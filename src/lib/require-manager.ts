// The manager gate every manager-only server function runs before it does
// anything. It asks the database, through the caller-scoped client, whether the
// caller holds the `manager` role — so the check is the same `has_role` RPC that
// backs the RLS policies, evaluated as that user, and never something the client
// can assert about itself.
//
// This lives in its own module because nine `*.functions.ts` modules each grew a
// private copy of the same six lines (membership, checkin, waiver, club-user,
// google-drive, blog, calendar, blog-comments, manager-api-tokens). Modules are
// migrated to this one as they are touched; the remaining copies are identical
// and safe to swap over whenever their file is next opened. `kb.functions.ts` is
// the one deliberate exception — `requireManagerViewer` returns a viewer record
// rather than just gating, so it is a different function.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * The slice of a `requireSupabaseAuth` server-function context this needs. The
 * middleware supplies more (`claims`), so call sites can pass their context
 * straight through.
 */
export type ManagerContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

/** Throw unless the caller holds the `manager` role. */
export async function requireManager(context: ManagerContext): Promise<void> {
  const { data: isManager, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isManager) throw new Error("Forbidden");
}
