// Who "every manager" is, for the emails that tell managers something: a new
// contact message, a new lead, a signed waiver, a membership awaiting payment.
//
// It used to live in `waiver-email.server.ts`, which made three other email
// modules import the waiver module to find out who the managers are. It is its
// own module so none of them depends on another flow's sender.
//
// Server-only: it takes the service-role client. Only ever imported by other
// `*.server.ts` modules.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * The email addresses of every manager (users holding the `manager` role), at
 * their login address. Reads `user_roles` with the service-role client and
 * looks each user up through the auth admin API, all at once rather than one
 * after another, so a submission does not wait a round trip per manager.
 *
 * Never throws: returns whatever it could resolve, so a lookup hiccup cannot
 * block the confirmation email to the member that is sent alongside.
 */
export async function getManagerEmails(admin: SupabaseClient<Database>): Promise<string[]> {
  try {
    const { data: roles, error } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "manager");
    if (error || !roles) return [];

    const looked = await Promise.all(
      (roles as { user_id: string }[]).map(async ({ user_id }) => {
        const { data, error: uErr } = await admin.auth.admin.getUserById(user_id);
        return !uErr ? (data?.user?.email ?? null) : null;
      }),
    );
    // In role order, without the gaps, and de-duplicated in case a user somehow
    // holds the role twice.
    return [...new Set(looked.filter((e): e is string => Boolean(e)))];
  } catch {
    return [];
  }
}
