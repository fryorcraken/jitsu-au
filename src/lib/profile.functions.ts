// A signed-in person's own account-level settings. Currently just the display
// name shown on blog comments (see docs/blog.md); not the waiver/profile
// person fields, which are only ever written by waiver submission or manager
// approval (see docs/database.md's `profiles` section).
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { updateDisplayNameSchema } from "@/lib/validation";

export const updateMyDisplayName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateDisplayNameSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ display_name: data.display_name, updated_at: new Date().toISOString() })
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const, display_name: data.display_name };
  });
