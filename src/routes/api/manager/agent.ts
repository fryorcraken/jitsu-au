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
} from "@/lib/validation";
import type { ManagerAgentAction } from "@/lib/validation";
import {
  AGENT_MANIFEST,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  projectInvoice,
  safeEqual,
} from "@/lib/manager-agent";
import { aggregateClubUsers, profileUserIds, LEADS_LIMIT } from "@/lib/club-users";
import type {
  ClubUserEmail,
  ClubUserLead,
  ClubUserProfile,
  ClubUserWaiver,
} from "@/lib/club-users";
import { hashToken } from "@/lib/manager-api-tokens";
import type { MembershipClient, MembershipPlanRow, MembershipRow } from "@/lib/membership-types";
import type { AppClient } from "@/lib/profile-types";

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
  const { data, error } = await pdb.rpc("user_emails", { _user_ids: userIds });
  if (error || !data) return [];
  return (data as ClubUserEmail[]).map((e) => ({
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
 */
async function authenticate(request: Request): Promise<void> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) throw new AgentError(401, "unauthorized", "Missing bearer token.");

  // Break-glass env key (optional; constant-time compared).
  const envKey = process.env.MANAGER_AGENT_API_KEY;
  if (envKey && safeEqual(token, envKey)) return;

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
  const { data: isMgr } = await db.rpc("has_role", {
    _user_id: row.created_by,
    _role: "manager",
  });
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
}

/** Shape any thrown value into a stable JSON error response. */
function errorResponse(e: unknown): Response {
  if (e instanceof AgentError) {
    return json({ ok: false, error: { code: e.code, message: e.message } }, e.httpStatus);
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

  const [{ data: profiles }, { data: rows, error }, { data: plans }, { data: waivers }, leads] =
    await Promise.all([
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
      // Interest registrations are the LEAD phase of the funnel; the
      // aggregation drops any whose email already belongs to a person.
      db
        .from("interest_registrations")
        .select("email, name, phone, created_at")
        .order("created_at", { ascending: false })
        .limit(LEADS_LIMIT)
        .then((r) => (r.data ?? []) as ClubUserLead[]),
    ]);
  if (error) throw new AgentError(500, "db_error", error.message);
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
    const [{ data: roles }, resolved] = await Promise.all([
      db.from("user_roles").select("user_id, role").in("user_id", userIds),
      emailsByUserId(pdb, userIds),
    ]);
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
  const [{ data: rows, error }, { data: plans }] = await Promise.all([
    query.limit(limit ?? 200),
    db.from("membership_plans").select("*"),
  ]);
  if (error) throw new AgentError(500, "db_error", error.message);

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
    const [{ data: profiles }, resolved] = await Promise.all([
      pdb
        .from("profiles")
        .select("user_id, first_name, middle_name, last_name, preferred_name")
        .in("user_id", userIds),
      emailsByUserId(pdb, userIds),
    ]);
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
  return { count: invoices.length, invoices };
}

// ---- action: edit_invoice ----
async function handleEditInvoice(params: unknown) {
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
  const { data: updated, error: updErr } = await db
    .from("memberships")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
  if (updErr || !updated)
    throw new AgentError(500, "db_error", updErr?.message ?? "Update failed.");

  const { data: plan } = await db
    .from("membership_plans")
    .select("*")
    .eq("id", updated.plan_id)
    .maybeSingle();

  return {
    invoice: projectInvoice(
      updated as MembershipRow,
      (plan ?? undefined) as MembershipPlanRow | undefined,
    ),
  };
}

async function dispatch(action: ManagerAgentAction, params: unknown) {
  switch (action) {
    case "list_users":
      return handleListUsers(params);
    case "list_invoices":
      return handleListInvoices(params);
    case "edit_invoice":
      return handleEditInvoice(params);
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
          await authenticate(request);
          const body = (await request.json().catch(() => {
            throw new AgentError(400, "bad_json", "Request body must be valid JSON.");
          })) as { action?: unknown; params?: unknown };

          const action = body?.action;
          if (
            typeof action !== "string" ||
            !(managerAgentActions as readonly string[]).includes(action)
          ) {
            throw new AgentError(
              400,
              "unknown_action",
              `Unknown action. Valid actions: ${managerAgentActions.join(", ")}.`,
            );
          }

          const result = await dispatch(action as ManagerAgentAction, body?.params ?? {});
          return json({ ok: true, action, result });
        } catch (e) {
          return errorResponse(e);
        }
      },
    },
  },
});
