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
  deriveLifecycleStatus,
  editInvoiceSchema,
  listAgentInvoicesSchema,
  listAgentUsersSchema,
  managerAgentActions,
} from "@/lib/validation";
import type { LifecycleStatus, ManagerAgentAction } from "@/lib/validation";
import {
  AGENT_MANIFEST,
  AgentError,
  bearerToken,
  buildInvoicePatch,
  projectInvoice,
  safeEqual,
} from "@/lib/manager-agent";
import { hashToken } from "@/lib/manager-api-tokens";
import type { MembershipClient, MembershipPlanRow, MembershipRow } from "@/lib/membership-types";

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

  const [{ data: rows, error }, { data: plans }, { data: waivers }] = await Promise.all([
    db.from("memberships").select("*").order("created_at", { ascending: false }).limit(2000),
    db.from("membership_plans").select("*"),
    db.from("waivers").select("user_id, full_name, email, signed_at"),
  ]);
  if (error) throw new AgentError(500, "db_error", error.message);

  const planById = new Map((plans ?? []).map((p) => [p.id, p as MembershipPlanRow]));

  // Latest waiver per user gives the display name/email and marks a signed waiver.
  const waiverRows = (
    (waivers ?? []) as {
      user_id: string | null;
      full_name: string;
      email: string;
      signed_at: string;
    }[]
  )
    .filter((w) => w.user_id)
    .sort((a, b) => (a.signed_at < b.signed_at ? 1 : -1));
  const nameByUser = new Map<string, { full_name: string; email: string }>();
  for (const w of waiverRows) {
    if (!nameByUser.has(w.user_id!))
      nameByUser.set(w.user_id!, { full_name: w.full_name, email: w.email });
  }

  // Group memberships by user; users = union of waiver signers + membership holders.
  const membershipsByUser = new Map<string, MembershipRow[]>();
  for (const r of (rows ?? []) as MembershipRow[]) {
    if (!r.user_id) continue;
    const list = membershipsByUser.get(r.user_id) ?? [];
    list.push(r);
    membershipsByUser.set(r.user_id, list);
  }
  const userIds = [...new Set([...nameByUser.keys(), ...membershipsByUser.keys()])];

  const rolesByUser = new Map<string, string[]>();
  if (userIds.length) {
    const { data: roles } = await db
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", userIds);
    for (const r of (roles ?? []) as { user_id: string; role: string }[]) {
      const list = rolesByUser.get(r.user_id) ?? [];
      list.push(r.role);
      rolesByUser.set(r.user_id, list);
    }
  }

  let users = userIds.map((uid) => {
    const ms = membershipsByUser.get(uid) ?? [];
    const who = nameByUser.get(uid);
    const lifecycle_status: LifecycleStatus = deriveLifecycleStatus({
      hasWaiver: nameByUser.has(uid),
      memberships: ms.map((m) => ({
        status: m.status,
        kind: planById.get(m.plan_id)?.kind ?? "session",
        price_cents: m.price_cents,
      })),
    });
    return {
      user_id: uid,
      name: who?.full_name ?? null,
      email: who?.email ?? null,
      roles: rolesByUser.get(uid) ?? [],
      lifecycle_status,
      invoices: ms.map((m) => projectInvoice(m, planById.get(m.plan_id))),
    };
  });

  users.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
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

  // Resolve a display name/email per member from their latest waiver.
  const userIds = [
    ...new Set(((rows ?? []) as MembershipRow[]).map((r) => r.user_id).filter(Boolean)),
  ] as string[];
  const nameByUser = new Map<string, { full_name: string; email: string }>();
  if (userIds.length) {
    const { data: waivers } = await db
      .from("waivers")
      .select("user_id, full_name, email, signed_at")
      .in("user_id", userIds)
      .order("signed_at", { ascending: false });
    for (const w of (waivers ?? []) as { user_id: string; full_name: string; email: string }[]) {
      if (!nameByUser.has(w.user_id))
        nameByUser.set(w.user_id, { full_name: w.full_name, email: w.email });
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
