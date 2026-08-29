// Household: who a signed-in person is allowed to act for, and who the club
// writes to about somebody.
//
// The club takes children, and a parent has one email address. A dependant is
// therefore an ORDINARY person -- an ordinary `auth.users` row and an ordinary
// `profiles` row -- so every table that keys on a person keeps working
// untouched. One column marks them: `profiles.guardian_user_id`
// (`20260827000000_household_guardian_link.sql`). Not null means "this person
// is a dependant, and contact about them goes to their guardian".
//
// This module exists so that rule is written down ONCE. Several server
// functions are about to grow an optional target ("show me this person, not
// me"), and each of them re-deriving "...but only if they're mine" is how one
// of them ends up subtly more generous than the others. `assertActingFor` is
// the single gate; nothing else may decide the question.
//
// The client is passed in rather than imported, for the same reason
// `require-manager.ts` takes its context: it keeps the service-role client off
// the browser bundle, and it makes every rule here testable against a stub
// instead of a live database.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type AdminClient = SupabaseClient<Database>;

/**
 * The optional target a "...for this person" server function takes. Absent
 * means the caller themselves, which is what every caller sends today.
 *
 * One schema rather than a `userId` field written out at each call site, so
 * every one of them agrees that a target is a uuid and that leaving it out is
 * allowed.
 */
export const householdTargetSchema = z.object({ userId: z.string().uuid().optional() });

/**
 * The two `profiles` fields every question below is answered from. Kept as its
 * own type so callers can pass a whole profile row, or just the two columns
 * they selected.
 */
export type HouseholdLink = {
  user_id: string;
  guardian_user_id: string | null;
};

/**
 * What a refusal says, and it is deliberately the SAME sentence whoever the
 * target turns out to be.
 *
 * A gate that said "no such person" for one id and "not yours" for another
 * would answer, to anybody who could type a uuid, the question "is this a real
 * person at the club?". So the caller learns only that the answer is no.
 */
const NOT_YOURS = "You can only see your own account and the people on it.";

/** True when this person is somebody's dependant rather than an account holder. */
export function isDependant(person: Pick<HouseholdLink, "guardian_user_id">): boolean {
  return person.guardian_user_id != null;
}

/**
 * The person the club actually writes to about `profile`: their guardian if
 * they have one, otherwise themselves.
 *
 * Pure, and the reason it is a function rather than an inline `??` at each call
 * site: a dependant's own address is a reserved, non-deliverable one that
 * nothing may ever send to, so "which id do I email?" has to be a question with
 * one answer. Note it returns a USER ID, not an address: resolving that id to a
 * mailbox stays where it already is.
 */
export function contactUserIdFor(profile: HouseholdLink): string {
  return profile.guardian_user_id ?? profile.user_id;
}

/**
 * Throw unless `callerId` may act for `targetId`.
 *
 * Passes for the caller themselves, and for any of the caller's own
 * dependants. Everything else throws, including:
 *
 *   * somebody else's dependant, which is the whole point of the gate;
 *   * a target that does not exist, which is refused with the same words;
 *   * a caller who is themselves a dependant, acting for ANYBODY -- including
 *     for themselves. This is the one-level rule
 *     (`20260827000000_household_guardian_link.sql` leaves it to the
 *     application deliberately, because a depth check in SQL needs a trigger).
 *     A dependant has no login at all, so a session claiming to be one is
 *     already something that should not exist; refusing it here means a
 *     grandchild chain can never be walked even if a bad row is written.
 */
export async function assertActingFor(
  admin: AdminClient,
  callerId: string,
  targetId: string,
): Promise<void> {
  // One round trip for both people. `.in()` is parameterised by the client, so
  // no filter string is assembled by hand here (see `kb.functions.ts`).
  const ids = callerId === targetId ? [callerId] : [callerId, targetId];
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, guardian_user_id")
    .in("user_id", ids);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const caller = rows.find((r) => r.user_id === callerId);
  // No profile row is not the same as "not allowed", but it has the same
  // answer, and saying so any more precisely would leak the difference.
  if (!caller || isDependant(caller)) throw new Error(NOT_YOURS);
  if (callerId === targetId) return;

  const target = rows.find((r) => r.user_id === targetId);
  if (!target || target.guardian_user_id !== callerId) throw new Error(NOT_YOURS);
}

/** One person on an account, as the household screens list them. */
export type HouseholdMember = {
  user_id: string;
  first_name: string;
  last_name: string | null;
  preferred_name: string | null;
  date_of_birth: string | null;
  guardian_user_id: string | null;
};

/**
 * The account holder plus their dependants, the account holder first.
 *
 * This only READS the shape of a household; it does not decide who may look at
 * one. Callers gate with `assertActingFor` first, so the rule about who may act
 * for whom stays in exactly one place. Asked about a dependant it returns just
 * that person, which is the truthful answer under the one-level rule.
 */
export async function listHousehold(
  admin: AdminClient,
  userId: string,
): Promise<HouseholdMember[]> {
  const columns = "user_id, first_name, last_name, preferred_name, date_of_birth, guardian_user_id";
  // Two queries rather than one hand-written `.or()` filter, as `kb.functions.ts`
  // explains. They are independent, so they cost one round trip between them.
  const [self, dependants] = await Promise.all([
    admin.from("profiles").select(columns).eq("user_id", userId).maybeSingle(),
    admin
      .from("profiles")
      .select(columns)
      .eq("guardian_user_id", userId)
      .order("first_name", { ascending: true }),
  ]);
  if (self.error) throw new Error(self.error.message);
  if (dependants.error) throw new Error(dependants.error.message);
  return [...(self.data ? [self.data] : []), ...(dependants.data ?? [])];
}
