// Manager agent HTTP API — a small, token-authenticated JSON surface a manager's
// AI agent can drive (via an MCP wrapper or the uts-manager-agent skill).
//
//   GET  /api/manager/agent   -> the self-describing manifest (source of truth)
//   POST /api/manager/agent   -> { action, params } dispatch
//
// Auth is an opaque bearer token rather than a manager's Supabase JWT: agents
// can't run the email/password login flow, and this endpoint only ever exposes
// the whitelisted manager actions below. Tokens are manager-issued and revocable
// (the manager_api_tokens table, minted from /manager/api-tokens); an optional
// MANAGER_AGENT_API_KEY env var is accepted as a break-glass fallback. All DB
// access uses the service-role admin client, so it is lazy-imported inside the
// handler (route files are bundled to the client — never top-level import it).
import { createFileRoute } from "@tanstack/react-router";
import { ZodError } from "zod";
import {
  editInvoiceSchema,
  listAgentInvoicesSchema,
  listAgentUsersSchema,
  managerAgentActions,
  nameWithPreferred,
  paperWaiverUploadSchema,
} from "@/lib/validation";
import type { ManagerAgentAction } from "@/lib/validation";
import {
  AGENT_ENV_KEY_UPLOADER,
  AGENT_MANIFEST,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  classifyAction,
  diffInvoicePatch,
  invoiceEditAudit,
  projectInvoice,
  reconciledEditBlockers,
  reconciledEditMessage,
  safeEqual,
} from "@/lib/manager-agent";
import { DuplicateWaiverError } from "@/lib/waiver-duplicates";
import { aggregateClubUsers, profileUserIds, CHECKINS_LIMIT, LEADS_LIMIT } from "@/lib/club-users";
import type {
  ClubUserEmail,
  ClubUserLead,
  ClubUserProfile,
  ClubUserWaiver,
} from "@/lib/club-users";
import { hashToken } from "@/lib/manager-api-tokens";
import { filePaperWaiver } from "@/lib/waiver.functions";
import type { MembershipClient, MembershipPlanRow, MembershipRow } from "@/lib/membership-types";
import type { AppClient } from "@/lib/profile-types";
import { userEmails } from "@/lib/supabase-rpc";

/**
 * Resolve auth emails (the one email store) for a set of user ids via the
 * service-role `user_emails` RPC; empty list on failure. Degraded mode: persons
 * render with a null email and leads aren't deduped against them (a person
 * could transiently appear twice) — rare and non-destructive.
 *
 * Keeps the whole row, including `email_confirmed_at`, so an agent listing
 * members sees the same verified state a manager sees on screen.
 */
async function emailsByUserId(pdb: AppClient, userIds: string[]): Promise<ClubUserEmail[]> {
  if (!userIds.length) return [];
  const { data, error } = await userEmails(pdb, userIds);
  if (error || !data) return [];
  return data.map((e) => ({
    user_id: e.user_id,
    email: e.email,
    email_confirmed_at: e.email_confirmed_at ?? null,
  }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Only GET (manifest) and POST (dispatch) carry behaviour. Every other method
 * used to fall through to the site's normal SSR router (no matching handler
 * on this route), returning the marketing homepage HTML with a 200 — harmless
 * but confusing, and a trap if a future handler ever dispatches on method.
 * Reject explicitly instead.
 */
function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "method_not_allowed", message: "Method not allowed." },
    }),
    {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        allow: "GET, POST",
      },
    },
  );
}

/** Load the service-role client. */
async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * Authenticate the request. Accepts either a manager-issued token (looked up by
 * SHA-256 hash in manager_api_tokens, whose owner must still be a manager) or,
 * as a break-glass fallback, the MANAGER_AGENT_API_KEY env var. Throws
 * AgentError on any failure. On success, best-effort stamps last_used_at.
 *
 * Returns who is acting: the token owner's user id for a manager-issued token,
 * or AGENT_ENV_KEY_UPLOADER for the break-glass key, which has no owner to
 * resolve. `file_waiver` records this as the waiver's `uploaded_by`.
 */
async function authenticate(request: Request): Promise<string> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) throw new AgentError(401, "unauthorized", "Missing bearer token.");

  // Break-glass env key (optional; constant-time compared).
  const envKey = process.env.MANAGER_AGENT_API_KEY;
  if (envKey && safeEqual(token, envKey)) return AGENT_ENV_KEY_UPLOADER;

  const db = await adminClient();
  const tokenHash = await hashToken(token);
  const { data: row, error } = await db
    .from("manager_api_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new AgentError(500, "db_error", error.message);
  if (!row) throw new AgentError(401, "unauthorized", "Invalid or revoked API token.");

  // Defense in depth: the token is only as privileged as its owner is today.
  if (!row.created_by) {
    throw new AgentError(403, "forbidden", "Token has no owner.");
  }
  // Still fail-closed if the check errors, but say which it was: a failed RPC
  // reported as "no longer a manager" sends whoever is debugging it to revoke
  // and re-mint a token that was never the problem.
  const { data: isMgr, error: roleErr } = await db.rpc("has_role", {
    _user_id: row.created_by,
    _role: "manager",
  });
  if (roleErr) throw new AgentError(500, "db_error", roleErr.message);
  if (!isMgr) throw new AgentError(403, "forbidden", "Token owner is no longer a manager.");

  // Best-effort usage stamp — never fail the request on this.
  void db
    .from("manager_api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(
      () => {},
      () => {},
    );

  return row.created_by;
}

/** Shape any thrown value into a stable JSON error response. */
function errorResponse(e: unknown): Response {
  if (e instanceof AgentError) {
    // details first: `code` and `message` are the envelope's stable contract and
    // must win, whatever a future call site happens to name a detail field.
    return json(
      { ok: false, error: { ...(e.details ?? {}), code: e.code, message: e.message } },
      e.httpStatus,
    );
  }
  if (e instanceof ZodError) {
    return json(
      {
        ok: false,
        error: {
          code: "invalid_params",
          message: "Invalid parameters.",
          issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      400,
    );
  }
  // Don't leak internal detail; log server-side for debugging.
  console.error("[manager-agent] unexpected error:", e);
  return json({ ok: false, error: { code: "internal_error", message: "Internal error." } }, 500);
}

// ---- action: list_users ----
async function handleListUsers(params: unknown) {
  const { status, limit } = listAgentUsersSchema.parse(params ?? {});
  const db = await adminClient();
  const pdb = db;

  const [
    { data: profiles, error: pErr },
    { data: rows, error },
    { data: plans, error: plErr },
    { data: waivers, error: wErr },
    { data: checkins, error: cErr },
    { data: leadRows, error: lErr },
  ] = await Promise.all([
    pdb
      .from("profiles")
      .select(
        "user_id, first_name, middle_name, last_name, preferred_name, phone, uts_student_number, created_at",
      )
      .limit(5000),
    db.from("memberships").select("*").order("created_at", { ascending: false }).limit(2000),
    db.from("membership_plans").select("*"),
    // ALL waivers: approved => visitor+, pending-only => applicant.
    pdb.from("waivers").select("user_id, signed_at, approval_status").limit(5000),
    // Attendance, counted per person: "who has been coming" is squarely this
    // API's use case, and it costs one read on the shared aggregation path.
    db.from("session_checkins").select("user_id").limit(CHECKINS_LIMIT),
    // Interest registrations are the LEAD phase of the funnel; the
    // aggregation drops any whose email already belongs to a person.
    db
      .from("interest_registrations")
      .select("email, name, phone, created_at")
      .order("created_at", { ascending: false })
      .limit(LEADS_LIMIT),
  ]);
  // A db_error is the only honest answer to a failed read. An agent cannot see
  // that a query fell over, so degrading to `[]` would hand it a confident
  // answer — every applicant reported as a lead, nobody needing approval — and
  // it would act on that.
  if (pErr) throw new AgentError(500, "db_error", pErr.message);
  if (error) throw new AgentError(500, "db_error", error.message);
  if (plErr) throw new AgentError(500, "db_error", plErr.message);
  if (wErr) throw new AgentError(500, "db_error", wErr.message);
  if (cErr) throw new AgentError(500, "db_error", cErr.message);
  if (lErr) throw new AgentError(500, "db_error", lErr.message);

  const leads = (leadRows ?? []) as ClubUserLead[];
  if ((checkins ?? []).length >= CHECKINS_LIMIT) {
    console.warn(
      `[agent.list_users] session_checkins capped at ${CHECKINS_LIMIT}; counts truncated`,
    );
  }
  if (leads.length >= LEADS_LIMIT) {
    console.warn(
      `[agent.list_users] interest_registrations capped at ${LEADS_LIMIT}; leads truncated`,
    );
  }

  const memberships = (rows ?? []) as MembershipRow[];
  const planById = new Map((plans ?? []).map((p) => [p.id, p as MembershipPlanRow]));
  const profileRows = (profiles ?? []) as ClubUserProfile[];
  const waiverRows = (waivers ?? []) as ClubUserWaiver[];

  // Roles + emails are scoped to the club's known people.
  const userIds = profileUserIds(profileRows);
  let rolesRows: { user_id: string; role: string }[] = [];
  let emails: ClubUserEmail[] = [];
  if (userIds.length) {
    // The email RPC is the one deliberate degradation (see emailsByUserId).
    const [{ data: roles, error: rErr }, resolved] = await Promise.all([
      db.from("user_roles").select("user_id, role").in("user_id", userIds),
      emailsByUserId(pdb, userIds),
    ]);
    if (rErr) throw new AgentError(500, "db_error", rErr.message);
    rolesRows = (roles ?? []) as { user_id: string; role: string }[];
    emails = resolved;
  }

  // Shared aggregation: one row per person with name/roles/lifecycle resolved.
  const aggregated = aggregateClubUsers({
    profiles: profileRows,
    emails,
    waivers: waiverRows,
    leads,
    memberships: memberships.map((m) => ({
      user_id: m.user_id,
      plan_id: m.plan_id,
      status: m.status,
      price_cents: m.price_cents,
      is_student: m.is_student,
      uts_student_number: m.uts_student_number,
      created_at: m.created_at,
    })),
    plans: (plans ?? []).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    roles: rolesRows,
    checkins: checkins ?? [],
  });

  // The agent surface also returns each person's invoices, projected from their
  // raw membership rows (newest first, matching the memberships query order).
  const membershipsByUser = new Map<string, MembershipRow[]>();
  for (const m of memberships) {
    if (!m.user_id) continue;
    const list = membershipsByUser.get(m.user_id) ?? [];
    list.push(m);
    membershipsByUser.set(m.user_id, list);
  }

  let users = aggregated.map((u) => ({
    user_id: u.user_id,
    name: u.name,
    email: u.email,
    roles: u.roles,
    lifecycle_status: u.lifecycle_status,
    sessions_attended: u.sessions_attended,
    invoices: (u.user_id ? (membershipsByUser.get(u.user_id) ?? []) : []).map((m) =>
      projectInvoice(m, planById.get(m.plan_id)),
    ),
  }));

  if (status) users = users.filter((u) => u.lifecycle_status === status);
  const capped = users.slice(0, limit ?? 200);
  return { count: capped.length, total: users.length, users: capped };
}

// ---- action: list_invoices ----
async function handleListInvoices(params: unknown) {
  const { status, limit } = listAgentInvoicesSchema.parse(params ?? {});
  const db = await adminClient();

  let query = db.from("memberships").select("*").order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  // Separate exact-count read (matching the same filter, no limit) so a capped
  // page still reports how many rows exist in total — list_users already does
  // this for the same reason: without it a caller can't tell a full page from
  // a truncated one, and there's no offset/cursor to page past the cap.
  let countQuery = db.from("memberships").select("*", { count: "exact", head: true });
  if (status) countQuery = countQuery.eq("status", status);
  const [{ data: rows, error }, { data: plans, error: plErr }, { count, error: countErr }] =
    await Promise.all([
      query.limit(limit ?? 200),
      db.from("membership_plans").select("*"),
      countQuery,
    ]);
  if (error) throw new AgentError(500, "db_error", error.message);
  // Without this, a failed plans read returns invoices whose plan name, kind and
  // price basis are all null — an agent asked to correct one has no way to tell
  // that from an invoice genuinely missing its plan.
  if (plErr) throw new AgentError(500, "db_error", plErr.message);
  if (countErr) throw new AgentError(500, "db_error", countErr.message);

  const planById = new Map((plans ?? []).map((p) => [p.id, p as MembershipPlanRow]));

  // Resolve each member's display name from their profile and email from the
  // auth user (the one email store).
  const userIds = [
    ...new Set(((rows ?? []) as MembershipRow[]).map((r) => r.user_id).filter(Boolean)),
  ] as string[];
  const nameByUser = new Map<string, string>();
  let emailByUser = new Map<string, string>();
  if (userIds.length) {
    const pdb = db;
    const [{ data: profiles, error: prErr }, resolved] = await Promise.all([
      pdb
        .from("profiles")
        .select("user_id, first_name, middle_name, last_name, preferred_name")
        .in("user_id", userIds),
      emailsByUserId(pdb, userIds),
    ]);
    if (prErr) throw new AgentError(500, "db_error", prErr.message);
    // The invoice listing only needs the address, not its verified state.
    emailByUser = new Map(resolved.map((e) => [e.user_id, e.email]));
    for (const p of profiles ?? []) {
      nameByUser.set(p.user_id, nameWithPreferred(p));
    }
  }

  const invoices = ((rows ?? []) as MembershipRow[]).map((r) => ({
    ...projectInvoice(r, planById.get(r.plan_id)),
    member_name: (r.user_id ? nameByUser.get(r.user_id) : null) || null,
    member_email: (r.user_id ? emailByUser.get(r.user_id) : null) ?? null,
  }));
  return { count: invoices.length, total: count ?? invoices.length, invoices };
}

// ---- action: edit_invoice ----
async function handleEditInvoice(params: unknown, actingAs: string) {
  const input = editInvoiceSchema.parse(params);
  const db = await adminClient();

  const { data: existing, error: findErr } = await db
    .from("memberships")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (findErr) throw new AgentError(500, "db_error", findErr.message);
  if (!existing) throw new AgentError(404, "not_found", "Invoice not found.");

  const patch = buildInvoicePatch(input);
  // What this edit would actually move, measured against the row as it stands.
  // Submitting a field with the value it already has is not an edit: it neither
  // trips the guard below nor gets recorded as a change that happened.
  const diff = diffInvoicePatch(existing, patch);
  const blocked = reconciledEditBlockers(existing, diff.changed, input.confirm_paid_edit);
  if (blocked.length) {
    throw new AgentError(
      409,
      "reconciled_invoice",
      reconciledEditMessage(blocked, existing.paid_at!),
      { blocked, paid_at: existing.paid_at, previous: diff.previous },
    );
  }

  const { data: updated, error: updErr } = await db
    .from("memberships")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
  if (updErr || !updated)
    throw new AgentError(500, "db_error", updErr?.message ?? "Update failed.");

  // The one read here that must NOT throw: the update above has already
  // committed, so failing now would report a successful edit as an error and
  // invite the agent to retry it. The plan only decorates the echoed invoice, so
  // log and return what did happen.
  const { data: plan, error: planErr } = await db
    .from("membership_plans")
    .select("*")
    .eq("id", updated.plan_id)
    .maybeSingle();
  if (planErr) console.error("[agent.edit_invoice] plan lookup failed after update:", planErr);

  // The audit trail. There is no audit table, so the server log is where an
  // invoice's edit history lives: without it, a disagreement between the books
  // and the bank cannot be traced back to who changed what. console.info, not
  // console.error — this is a normal event, and it must be findable as one.
  if (diff.changed.length) {
    console.info(
      "[agent.edit_invoice] audit",
      JSON.stringify(
        invoiceEditAudit({
          invoiceId: input.id,
          actor: actingAs,
          paidAt: existing.paid_at,
          confirmed: input.confirm_paid_edit,
          diff,
          patch,
          at: new Date().toISOString(),
        }),
      ),
    );
  }

  return {
    invoice: projectInvoice(
      updated as MembershipRow,
      (plan ?? undefined) as MembershipPlanRow | undefined,
    ),
    // What moved, and what it held before. An edit that changed nothing comes
    // back with an empty `changed`, so a caller can tell a real correction from
    // a no-op instead of reading a 200 as proof something happened.
    changed: diff.changed,
    previous: diff.previous,
  };
}

// ---- action: file_waiver ----
async function handleFileWaiver(params: unknown, actingAs: string) {
  const input = paperWaiverUploadSchema.parse(params);
  const db = await adminClient();
  try {
    const { id, user_id } = await filePaperWaiver(db, input, actingAs);
    return { id, user_id };
  } catch (e) {
    // A likely duplicate is a distinct, actionable outcome, not a generic
    // failure: it comes back as a 409 with the waivers it collided with, so the
    // caller can look at them and either stop or re-send with confirm_duplicate.
    if (e instanceof DuplicateWaiverError) {
      throw new AgentError(409, "duplicate_waiver", e.message, { existing: e.existing });
    }
    // filePaperWaiver throws plain Errors with member-facing text (the manager
    // web form renders `.message` directly); wrap so the agent gets the same
    // message inside the endpoint's stable error envelope instead of a bare 500.
    throw new AgentError(
      422,
      "file_waiver_failed",
      e instanceof Error ? e.message : "Could not file the waiver.",
    );
  }
}

async function dispatch(action: ManagerAgentAction, params: unknown, actingAs: string) {
  switch (action) {
    case "list_users":
      return handleListUsers(params);
    case "list_invoices":
      return handleListInvoices(params);
    case "edit_invoice":
      return handleEditInvoice(params, actingAs);
    case "file_waiver":
      return handleFileWaiver(params, actingAs);
  }
}

export const Route = createFileRoute("/api/manager/agent")({
  server: {
    handlers: {
      // Self-description: agents read this to discover the current action set.
      GET: async ({ request }) => {
        try {
          await authenticate(request);
          return json({ ok: true, ...AGENT_MANIFEST });
        } catch (e) {
          return errorResponse(e);
        }
      },
      POST: async ({ request }) => {
        try {
          const actingAs = await authenticate(request);
          const body = (await request.json().catch(() => {
            throw new AgentError(400, "bad_json", "Request body must be valid JSON.");
          })) as { action?: unknown; params?: unknown };

          const classified = classifyAction(body?.action, managerAgentActions);
          if (!classified.ok) {
            throw new AgentError(400, classified.code, classified.message);
          }
          const action = classified.action;

          const result = await dispatch(action as ManagerAgentAction, body?.params ?? {}, actingAs);
          return json({ ok: true, action, result });
        } catch (e) {
          return errorResponse(e);
        }
      },
      PUT: async () => methodNotAllowed(),
      PATCH: async () => methodNotAllowed(),
      DELETE: async () => methodNotAllowed(),
    },
  },
});
