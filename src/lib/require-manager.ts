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

/**
 * Does the caller hold the `manager` role?
 *
 * The answered form of `requireManager`, which is defined in terms of it so the
 * check stays in one place. For the handler that does not simply refuse a
 * non-manager but has another route to try: `getWaiverPdfUrl` serves managers,
 * owners AND guardians, so "no" is the start of the next question rather than
 * the end of the request.
 *
 * A failed read still throws. "We could not ask" is not "no".
 */
export async function isManager(context: ManagerContext): Promise<boolean> {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/** Throw unless the caller holds the `manager` role. */
export async function requireManager(context: ManagerContext): Promise<void> {
  if (!(await isManager(context))) throw new Error("Forbidden");
}
