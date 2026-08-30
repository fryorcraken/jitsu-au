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
 * A target user id, lowercased.
 *
 * The normalisation is load-bearing, not tidiness. `z.string().uuid()` accepts
 * an uppercase uuid and Postgres does not care about case either, so
 * `.eq("user_id", ID)` matches whichever form arrives -- but the rows it hands
 * back are lowercase, and this module compares ids as JS strings. Without this
 * an uppercase id (a route param somebody pasted or typed) would miss the
 * "acting for yourself" check and then fail to match its own row, refusing a
 * guardian their own child on a query that would have worked. It fails closed,
 * so it was never a hole; it was an unactionable no on the happy path.
 *
 * Exported so every schema that takes a target uses this one and cannot drift.
 */
export const householdTargetUserId = z.string().uuid().toLowerCase();

/**
 * The optional target a "...for this person" server function takes. Absent
 * means the caller themselves, which is what every caller sends today.
 *
 * One schema rather than a `userId` field written out at each call site, so
 * every one of them agrees that a target is a uuid and that leaving it out is
 * allowed.
 */
export const householdTargetSchema = z.object({ userId: householdTargetUserId.optional() });

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
 * dependants. It throws for somebody else's dependant, for another account
 * holder, for a target that does not exist, and for a caller who is themselves
 * a dependant reaching for anybody but themselves. That last one is the
 * one-level rule: `20260827000000_household_guardian_link.sql` enforces only
 * "nobody is their own guardian" and leaves the depth to the application,
 * because a depth check in SQL needs a trigger. So a grandchild chain is
 * refused here or nowhere, even if a bad row builds one.
 *
 * **Acting for yourself is never refused, and never even asks the database.**
 * That is deliberate, and it is the difference between a gate and an outage.
 * This function guards reaching PAST yourself; a person looking at their own
 * record is not doing that, and every screen that shows somebody their own
 * details would otherwise depend on a query that can fail. Refusing a
 * dependant their own account page would buy nothing (they cannot sign in at
 * all, their auth user is permanently banned) and would cost a total,
 * unactionable lockout of anyone who ever ends up with a guardian and a login.
 * The person with no `profiles` row at all keeps working the same way for the
 * same reason: this is not the place that decides a missing row's meaning.
 */
export async function assertActingFor(
  admin: AdminClient,
  callerUserId: string,
  targetUserId: string,
): Promise<void> {
  // Again here, not only in the schema: this is the security boundary, and it
  // takes two bare strings from wherever a caller got them. Postgres hands back
  // lowercase, so every comparison below is against a lowercase id.
  const callerId = callerUserId.toLowerCase();
  const targetId = targetUserId.toLowerCase();
  if (callerId === targetId) return;

  // One round trip for both people. `.in()` is parameterised by the client, so
  // no filter string is assembled by hand here (see `kb.functions.ts`).
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, guardian_user_id")
    .in("user_id", [callerId, targetId]);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const caller = rows.find((r) => r.user_id.toLowerCase() === callerId);
  // No profile row is not the same as "not allowed", but reaching for somebody
  // else has the same answer either way, and saying which would leak the
  // difference.
  if (!caller || isDependant(caller)) throw new Error(NOT_YOURS);

  const target = rows.find((r) => r.user_id.toLowerCase() === targetId);
  if (!target || target.guardian_user_id?.toLowerCase() !== callerId) throw new Error(NOT_YOURS);
}

/**
 * The person a "...for this person" server function is about: the named target
 * once the gate has allowed it, or the caller when none was named.
 *
 * This exists so a handler cannot hold the rule wrongly. The four handlers that
 * take a target each used to carry their own `if (input.userId) await
 * assertActingFor(...)` followed by `input.userId ?? context.userId` -- two
 * lines that have to agree, repeated per handler, and every one of them a fresh
 * chance to gate one id and then read another. #105 and #106 add more of these,
 * so it is one call now: you cannot get the subject without going through the
 * gate, because getting the subject IS going through the gate.
 */
export async function resolveSubject(
  admin: AdminClient,
  callerUserId: string,
  targetUserId: string | undefined,
): Promise<string> {
  if (!targetUserId) return callerUserId;
  await assertActingFor(admin, callerUserId, targetUserId);
  return targetUserId;
}

// `listHousehold` below and `contactUserIdFor` above have no production caller
// yet: #106 lists a household, #107 addresses a digest to a contact. They are
// here rather than with those PRs because #102 asks for the household rule to
// exist in ONE place before three PRs start needing it, and an agent who
// arrives to find only half the module writes the other half themselves, which
// is the second seam CLAUDE.md forbids. It is a deliberate exception to "no
// speculative generality" and worth re-reading as one: if #106 and #107 land
// without calling these, delete them.

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
