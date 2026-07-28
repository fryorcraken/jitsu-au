import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createApiTokenSchema, revokeApiTokenSchema } from "@/lib/validation";
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import type { ManagerApiTokenRow, MembershipClient } from "@/lib/membership-types";

/** Load the service-role client. */
async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Throw unless the caller holds the `manager` role (checked via the RLS RPC). */
async function requireManager(context: { supabase: MembershipClient; userId: string }) {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

/** Metadata projection — never leaks the token hash to the client. */
function projectToken(t: ManagerApiTokenRow) {
  return {
    id: t.id,
    label: t.label,
    token_prefix: t.token_prefix,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
    revoked_at: t.revoked_at,
    active: t.revoked_at === null,
  };
}

// ---- Manager: list issued tokens (metadata only) ----
export const listApiTokens = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    const { data, error } = await admin
      .from("manager_api_tokens")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map(projectToken);
  });

// ---- Manager: mint a new token (raw value returned ONCE) ----
export const createApiToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createApiTokenSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();

    // Generate + hash before insert; only the hash and a display prefix persist.
    const raw = generateRawToken();
    const token_hash = await hashToken(raw);
    const token_prefix = tokenPreview(raw);

    const { data: created, error } = await admin
      .from("manager_api_tokens")
      .insert({
        label: data.label,
        token_prefix,
        token_hash,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error || !created) throw new Error(error?.message || "Could not create token.");

    // The raw token is returned here and never again.
    return { ...projectToken(created), token: raw };
  });

// ---- Manager: revoke a token ----
export const revokeApiToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => revokeApiTokenSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    const { error } = await admin
      .from("manager_api_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .is("revoked_at", null);
    if (error) throw new Error(error.message);
    return { ok: true as const, id: data.id };
  });
