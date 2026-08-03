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
  deleteKbSectionSchema,
  getKbArticleSchema,
  listAgentInvoicesSchema,
  listAgentUsersSchema,
  listKbCommentsSchema,
  managerAgentActions,
  nameWithPreferred,
  paperWaiverUploadSchema,
  saveKbArticleSchema,
  saveKbSectionSchema,
  saveSemesterSchema,
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
  projectAgentKbArticle,
  projectInvoice,
  reconciledEditBlockers,
  reconciledEditMessage,
  safeEqual,
} from "@/lib/manager-agent";
import {
  DuplicateCheckFailedError,
  DuplicateWaiverError,
  SubmissionIdConflictError,
  WaiverFilingIncompleteError,
} from "@/lib/waiver-duplicates";
import { aggregateClubUsers, profileUserIds, CHECKINS_LIMIT, LEADS_LIMIT } from "@/lib/club-users";
import type {
  ClubUserEmail,
  ClubUserLead,
  ClubUserProfile,
  ClubUserWaiver,
} from "@/lib/club-users";
import { hashToken } from "@/lib/manager-api-tokens";
import {
  deleteKbSection,
  listKbSections,
  listSharedAnnotations,
  loadKbArticle,
  projectAnnotation,
  projectArticle,
  saveKbArticle,
  saveKbSection,
} from "@/lib/kb-admin";
import type { KbAnnotationRow, KbArticleRow } from "@/lib/kb-types";
import { filePaperWaiver } from "@/lib/waiver.functions";
import { listSemesterRows, saveSemester } from "@/lib/membership.functions";
import type {
  ClubSemesterRow,
  MembershipClient,
  MembershipPlanRow,
  MembershipRow,
} from "@/lib/membership-types";
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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
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
    // `details` is NESTED, not spread. Flat-merging shared one namespace with
    // the envelope: ordering code/message last resolved the collision by
    // silently discarding a detail that happened to be named either, and it
    // would have blocked the envelope from ever growing a reserved key. Under
    // `error.details` the two can never argue, and `details.blocked` reads as
    // belonging to `code: "reconciled_invoice"` in a way bare `error.blocked`
    // does not.
    return json(
      {
        ok: false,
        version: AGENT_MANIFEST.version,
        error: { code: e.code, message: e.message, ...(e.details && { details: e.details }) },
      },
      e.httpStatus,
      // A retry policy reads headers, not prose. Without this, "safe to retry"
      // is a sentence only a human acts on, and the usual client default is an
      // immediate retry — the least useful timing for a read that just failed.
      e.retryAfterSeconds ? { "retry-after": String(e.retryAfterSeconds) } : {},
    );
  }
  if (e instanceof ZodError) {
    return json(
      {
        ok: false,
        version: AGENT_MANIFEST.version,
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
  return json(
    {
      ok: false,
      version: AGENT_MANIFEST.version,
      error: { code: "internal_error", message: "Internal error." },
    },
    500,
  );
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
    { data: semesters, error: semErr },
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
    db.from("club_semesters").select("id, code, name"),
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
  // Decoration only (which semester an invoice names); starts_at/ends_at on
  // the invoice are the source of truth regardless, so this degrades quietly.
  if (semErr) console.error("[agent.list_users] semester lookup failed:", semErr);

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
  const semesterById = new Map((semesters ?? []).map((s) => [s.id, s]));
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
      projectInvoice(
        m,
        planById.get(m.plan_id),
        m.semester_id ? semesterById.get(m.semester_id) : undefined,
      ),
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
  const [
    { data: rows, error },
    { data: plans, error: plErr },
    { data: semesters, error: semErr },
    { count, error: countErr },
  ] = await Promise.all([
    query.limit(limit ?? 200),
    db.from("membership_plans").select("*"),
    db.from("club_semesters").select("id, code, name"),
    countQuery,
  ]);
  if (error) throw new AgentError(500, "db_error", error.message);
  // Without this, a failed plans read returns invoices whose plan name, kind and
  // price basis are all null — an agent asked to correct one has no way to tell
  // that from an invoice genuinely missing its plan.
  if (plErr) throw new AgentError(500, "db_error", plErr.message);
  if (countErr) throw new AgentError(500, "db_error", countErr.message);
  // Decoration only; see the same note in handleListUsers.
  if (semErr) console.error("[agent.list_invoices] semester lookup failed:", semErr);

  const planById = new Map((plans ?? []).map((p) => [p.id, p as MembershipPlanRow]));
  const semesterById = new Map((semesters ?? []).map((s) => [s.id, s]));

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
    ...projectInvoice(
      r,
      planById.get(r.plan_id),
      r.semester_id ? semesterById.get(r.semester_id) : undefined,
    ),
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
    // `previous` is scoped to the blocked fields, not every field the call would
    // have changed. The whole update is refused atomically, but echoing an
    // unguarded field's old value here reads as "this was blocked too" — a
    // caller pairing `previous` with `blocked` would draw the wrong conclusion.
    const blockedPrevious = Object.fromEntries(blocked.map((f) => [f, diff.previous[f] ?? null]));
    throw new AgentError(
      409,
      "reconciled_invoice",
      reconciledEditMessage(blocked, existing.paid_at!),
      { blocked, paid_at: existing.paid_at, previous: blockedPrevious },
    );
  }

  // Compare-and-swap on everything this edit read, not just `paid_at`.
  //
  // Pinning `paid_at` alone stops a reconciliation slipping a guarded edit
  // through, but leaves the audit trail wrong: `previous` and the log's `from`
  // both come from the row read above, and nothing held the columns actually
  // being written. Two overlapping edits — B sets notes to "cheque", A then
  // writes "card" — would have A record `"cash" -> "card"`, a transition that
  // never happened, with B's edit gone from the record entirely. In the club's
  // only invoice edit history, a stale `from` is worse than no entry: it reads
  // as evidence.
  //
  // `.is` is only for NULL/TRUE/FALSE in PostgREST, so a null before-value
  // matches on IS NULL and anything else on equality.
  let update = db.from("memberships").update(patch).eq("id", input.id);
  update = existing.paid_at ? update.eq("paid_at", existing.paid_at) : update.is("paid_at", null);
  for (const field of diff.changed) {
    // Every editable column is a string, a number, or null (price_cents is the
    // only non-string), so this narrowing is total rather than convenient.
    const before = (diff.previous[field] ?? null) as string | number | null;
    update = before === null ? update.is(field, null) : update.eq(field, before);
  }
  const { data: updated, error: updErr } = await update.select("*").maybeSingle();
  if (updErr) throw new AgentError(500, "db_error", updErr.message);
  if (!updated) {
    // One code for both "somebody wrote first" and "the row is gone": each means
    // the caller's copy is stale and re-reading is the next step either way, and
    // the re-read tells them which (a deleted invoice 404s). Guessing here would
    // cost a query and could still be wrong.
    throw new AgentError(
      409,
      "invoice_changed",
      "This invoice changed under the edit (another edit, or a payment being reconciled), so nothing was written. Read it again and re-send if the edit still applies.",
    );
  }

  // The two reads here must NOT throw: the update above has already committed,
  // so failing now would report a successful edit as an error and invite the
  // agent to retry it. Both only decorate the echoed invoice, so log and return
  // what did happen.
  const { data: plan, error: planErr } = await db
    .from("membership_plans")
    .select("*")
    .eq("id", updated.plan_id)
    .maybeSingle();
  if (planErr) console.error("[agent.edit_invoice] plan lookup failed after update:", planErr);
  const semester = updated.semester_id
    ? await db
        .from("club_semesters")
        .select("id, code, name")
        .eq("id", updated.semester_id)
        .maybeSingle()
        .then(({ data, error: semErr }) => {
          if (semErr)
            console.error("[agent.edit_invoice] semester lookup failed after update:", semErr);
          return data ?? undefined;
        })
    : undefined;

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
      semester,
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
    const { id, user_id, created } = await filePaperWaiver(db, input, actingAs);
    // `created: false` means this call resolved to a waiver an earlier attempt
    // had already filed. A bulk importer that silently replayed half its calls
    // would otherwise look identical to a clean run, which makes reconciling
    // against a stack of paper impossible.
    return { id, user_id, created };
  } catch (e) {
    // A likely duplicate is a distinct, actionable outcome, not a generic
    // failure: it comes back as a 409 with the waivers it collided with, so the
    // caller can look at them and either stop or re-send with confirm_duplicate.
    if (e instanceof DuplicateWaiverError) {
      throw new AgentError(409, "duplicate_waiver", e.message, {
        existing: e.existing,
        truncated: e.truncated,
      });
    }
    // The probe failed, which is not a verdict on the waiver. 503, so a retry
    // policy reads "try this again" rather than the "fix your input" that a 4xx
    // implies — nothing was filed either way.
    if (e instanceof DuplicateCheckFailedError) {
      throw new AgentError(503, "duplicate_check_failed", e.message, undefined, 5);
    }
    // 5xx, not the generic 422: the row is half-filed and ONLY a retry with the
    // same id completes it. Landing this in a 4xx told a caller obeying the
    // documented "4xx means change the request" rule to change the one thing it
    // could — the id — which files a second waiver against the same paper and
    // abandons the first, the exact failure this feature exists to prevent.
    if (e instanceof WaiverFilingIncompleteError) {
      throw new AgentError(503, "waiver_filing_incomplete", e.message, undefined, 5);
    }
    // The opposite: permanent, and no retry of this request will ever succeed.
    // It must not share a code with the transient ones above.
    if (e instanceof SubmissionIdConflictError) {
      throw new AgentError(409, "submission_id_conflict", e.message);
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

/** Project a window row the way `list_membership_windows` returns it. */
function projectAgentMembershipWindow(s: ClubSemesterRow) {
  return {
    code: s.code,
    name: s.name,
    year: s.year,
    half: s.half,
    starts_on: s.starts_on,
    ends_on: s.ends_on,
    is_active: s.is_active,
  };
}

// ---- action: list_membership_windows ----
async function handleListMembershipWindows() {
  const db = await adminClient();
  const windows = await listSemesterRows(db);
  return { count: windows.length, windows: windows.map(projectAgentMembershipWindow) };
}

// ---- action: save_membership_window ----
async function handleSaveMembershipWindow(params: unknown) {
  const input = saveSemesterSchema.parse(params);
  const db = await adminClient();
  try {
    return await saveSemester(db, input);
  } catch (e) {
    throw new AgentError(
      422,
      "save_membership_window_failed",
      e instanceof Error ? e.message : "Could not save the membership window.",
    );
  }
}

/**
 * Cap on articles returned by `list_kb_articles`. Generous: a club with more
 * pages than this has outgrown a flat list, and the handler warns rather than
 * truncating in silence.
 */
const ARTICLES_LIMIT = 500;

// ---- action: list_kb_sections ----
async function handleListKbSections() {
  const db = await adminClient();
  const sections = await listKbSections(db);
  return {
    count: sections.length,
    sections: sections.map((s) => ({ slug: s.slug, title: s.title, position: s.position })),
  };
}

// ---- action: save_kb_section ----
async function handleSaveKbSection(params: unknown) {
  const input = saveKbSectionSchema.parse(params);
  const db = await adminClient();
  try {
    return await saveKbSection(db, input);
  } catch (e) {
    throw new AgentError(
      422,
      "save_kb_section_failed",
      e instanceof Error ? e.message : "Could not save the section.",
    );
  }
}

// ---- action: delete_kb_section ----
async function handleDeleteKbSection(params: unknown) {
  const input = deleteKbSectionSchema.parse(params);
  const db = await adminClient();
  try {
    return await deleteKbSection(db, input.slug);
  } catch (e) {
    throw new AgentError(
      422,
      "delete_kb_section_failed",
      e instanceof Error ? e.message : "Could not delete the section.",
    );
  }
}

// ---- action: list_kb_articles ----
async function handleListKbArticles() {
  const db = await adminClient();

  // Only the LIVE version of each article, not every version ever saved.
  //
  // Reading the whole `kb_article_versions` table to pick out the current rows
  // grows without bound (every save adds one) and would eventually be truncated
  // by the server-side row cap — silently, and in the worst possible way: a
  // article whose `is_current` row fell outside the window would be reported
  // with `title: null, version: null`, a confident wrong answer of exactly the
  // kind the comment in `handleListUsers` exists to prevent. `is_current` is a
  // partial unique index, so this is one row per article by construction.
  //
  // The live version is the one flagged `is_current`, NOT the highest-numbered
  // one. Those differ whenever a manager has rolled back to an earlier version,
  // and reporting the newest as live would have an agent read version 9, edit
  // it, and publish it over the version 4 the club deliberately went back to.
  const [{ data: docs, error }, { data: versions, error: vErr }, sections] = await Promise.all([
    db.from("kb_articles").select("*").order("slug").limit(ARTICLES_LIMIT),
    db
      .from("kb_article_versions")
      .select("article_id, title, version, created_at, change_note")
      .eq("is_current", true)
      .limit(ARTICLES_LIMIT),
    listKbSections(db),
  ]);
  if (error) throw new AgentError(500, "db_error", error.message);
  if (vErr) throw new AgentError(500, "db_error", vErr.message);

  // Articles report their section by SLUG, never by id: the slug is what
  // `save_kb_article` takes back, so an agent can move an article using exactly
  // what it just read.
  const sectionSlugById = new Map(sections.map((s) => [s.id, s.slug]));
  if ((docs ?? []).length >= ARTICLES_LIMIT) {
    console.warn(`[agent.list_kb_articles] articles capped at ${ARTICLES_LIMIT}; list truncated`);
  }

  const liveByDoc = new Map((versions ?? []).map((v) => [v.article_id, v]));

  // How many versions each article has, counted in the database rather than by
  // reading the rows: "this page has been rewritten nine times" is context a
  // manager wants before editing it, and it must not cost an unbounded read.
  const countByDoc = new Map<string, number>();
  await Promise.all(
    ((docs ?? []) as KbArticleRow[]).map(async (d) => {
      const { count, error: cErr } = await db
        .from("kb_article_versions")
        .select("*", { count: "exact", head: true })
        .eq("article_id", d.id);
      if (cErr) throw new AgentError(500, "db_error", cErr.message);
      countByDoc.set(d.id, count ?? 0);
    }),
  );

  const articles = ((docs ?? []) as KbArticleRow[]).map((d) =>
    projectAgentKbArticle(
      d,
      liveByDoc.get(d.id),
      d.section_id ? (sectionSlugById.get(d.section_id) ?? null) : null,
      countByDoc.get(d.id) ?? 0,
    ),
  );
  return { count: articles.length, articles };
}

// ---- action: get_kb_article ----
async function handleGetKbArticle(params: unknown) {
  const input = getKbArticleSchema.parse(params);
  const db = await adminClient();
  const loaded = await loadKbArticle(db, input.slug, input.version);
  // A manager token sees every article, drafts included, so there is no
  // visibility check here — unlike the public reader, which hides a missing
  // article and a forbidden one behind the same words.
  if (!loaded) throw new AgentError(404, "not_found", "No such article, or no such version.");
  return { article: projectArticle(loaded) };
}

// ---- action: save_kb_article ----
async function handleSaveKbArticle(params: unknown, actingAs: string) {
  const input = saveKbArticleSchema.parse(params);
  const db = await adminClient();
  try {
    const result = await saveKbArticle(db, input, actingAs);
    return {
      slug: result.slug,
      version: result.version,
      created: result.created,
      url: `/kb/${result.slug}`,
    };
  } catch (e) {
    // saveKbArticle throws plain Errors with manager-facing text (a promotion
    // race, a failed insert). Wrap so the agent gets that message inside the
    // endpoint's stable error envelope rather than a bare 500.
    throw new AgentError(
      422,
      "save_kb_article_failed",
      e instanceof Error ? e.message : "Could not save the article.",
    );
  }
}

// ---- action: list_kb_comments ----
async function handleListKbComments(params: unknown) {
  const input = listKbCommentsSchema.parse(params);
  const db = await adminClient();

  const { data: doc, error: docErr } = await db
    .from("kb_articles")
    .select("id, slug")
    .eq("slug", input.slug)
    .maybeSingle();
  if (docErr) throw new AgentError(500, "db_error", docErr.message);
  if (!doc) throw new AgentError(404, "not_found", "No such article.");

  // Through `listSharedAnnotations`, not a second query of its own. The
  // `visibility = 'shared'` filter is the single line keeping members' private
  // notes away from the club, and a copy of it here is a copy that can be
  // edited without the test noticing.
  let annotations: KbAnnotationRow[];
  try {
    annotations = await listSharedAnnotations(db, doc.id, {
      includeResolved: input.include_resolved,
      version: input.version,
      limit: input.limit ?? 200,
    });
  } catch (e) {
    throw new AgentError(500, "db_error", e instanceof Error ? e.message : "Could not read them.");
  }
  const userIds = [...new Set(annotations.map((a) => a.user_id))];
  const nameByUser = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles, error: pErr } = await db
      .from("profiles")
      .select("user_id, first_name, middle_name, last_name, preferred_name")
      .in("user_id", userIds);
    if (pErr) throw new AgentError(500, "db_error", pErr.message);
    for (const p of profiles ?? []) nameByUser.set(p.user_id, nameWithPreferred(p));
  }

  const projected = annotations.map((a) => projectAnnotation(a, nameByUser.get(a.user_id) ?? null));
  return { count: projected.length, slug: doc.slug, annotations: projected };
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
    case "list_membership_windows":
      return handleListMembershipWindows();
    case "save_membership_window":
      return handleSaveMembershipWindow(params);
    case "list_kb_sections":
      return handleListKbSections();
    case "save_kb_section":
      return handleSaveKbSection(params);
    case "delete_kb_section":
      return handleDeleteKbSection(params);
    case "list_kb_articles":
      return handleListKbArticles();
    case "get_kb_article":
      return handleGetKbArticle(params);
    case "save_kb_article":
      return handleSaveKbArticle(params, actingAs);
    case "list_kb_comments":
      return handleListKbComments(params);
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
          // The version travels on EVERY response, not just the manifest. A
          // client that read the manifest at the start of a long import and
          // cannot re-read it mid-run would otherwise meet "2" as an
          // unexplained 409; now it can compare against its own copy per call
          // and decide to stop and re-read. That is the client `changes` was
          // written for, and until now the one it could not reach.
          return json({ ok: true, version: AGENT_MANIFEST.version, action, result });
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
