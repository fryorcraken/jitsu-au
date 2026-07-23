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
  profileFullName,
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
import { aggregateClubUsers, profileUserIds } from "@/lib/club-users";
import type { ClubUserProfile, ClubUserWaiver } from "@/lib/club-users";
import { hashToken } from "@/lib/manager-api-tokens";
import type { MembershipClient, MembershipPlanRow, MembershipRow } from "@/lib/membership-types";
import type { AppClient } from "@/lib/profile-types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The service-role client, typed with the memberships-aware Database. */
async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as MembershipClient;
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
  const pdb = db as unknown as AppClient;

  const [{ data: profiles }, { data: rows, error }, { data: plans }, { data: waivers }] =
    await Promise.all([
      pdb
        .from("profiles")
        .select(
          "id, user_id, email, first_name, middle_name, last_name, phone, uts_student_number, created_at",
        )
        .limit(5000),
      db.from("memberships").select("*").order("created_at", { ascending: false }).limit(2000),
      db.from("membership_plans").select("*"),
      pdb.from("waivers").select("profile_id, signed_at").limit(5000),
    ]);
  if (error) throw new AgentError(500, "db_error", error.message);

  const memberships = (rows ?? []) as MembershipRow[];
  const planById = new Map((plans ?? []).map((p) => [p.id, p as MembershipPlanRow]));
  const profileRows = (profiles ?? []) as ClubUserProfile[];
  const waiverRows = (waivers ?? []) as ClubUserWaiver[];

  // Roles are scoped to the club's known users (profiles with an auth account).
  const userIds = profileUserIds(profileRows);
  let rolesRows: { user_id: string; role: string }[] = [];
  if (userIds.length) {
    const { data: roles } = await db
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", userIds);
    rolesRows = (roles ?? []) as { user_id: string; role: string }[];
  }

  // Shared aggregation: one row per person with name/roles/lifecycle resolved.
  const aggregated = aggregateClubUsers({
    profiles: profileRows,
    waivers: waiverRows,
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

  // Resolve a display name/email per member from their profile.
  const userIds = [
    ...new Set(((rows ?? []) as MembershipRow[]).map((r) => r.user_id).filter(Boolean)),
  ] as string[];
  const nameByUser = new Map<string, { full_name: string; email: string }>();
  if (userIds.length) {
    const pdb = db as unknown as AppClient;
    const { data: profiles } = await pdb
      .from("profiles")
      .select("user_id, first_name, middle_name, last_name, email")
      .in("user_id", userIds);
    for (const p of profiles ?? []) {
      if (p.user_id) nameByUser.set(p.user_id, { full_name: profileFullName(p), email: p.email });
    }
  }

  const invoices = ((rows ?? []) as MembershipRow[]).map((r) => {
    const who = r.user_id ? nameByUser.get(r.user_id) : undefined;
    return {
      ...projectInvoice(r, planById.get(r.plan_id)),
      member_name: who?.full_name ?? null,
      member_email: who?.email ?? null,
    };
  });
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

  return { invoice: projectInvoice(updated as MembershipRow, plan as MembershipPlanRow | null) };
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
