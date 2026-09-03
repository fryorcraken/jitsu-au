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
 *
 * It names both verbs because it is thrown by a save as well as a read
 * (`updateMyProfile`), and a person refused a save should not be told they
 * cannot see something.
 */
const NOT_YOURS = "You can only see or change your own account and the people on it.";

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
  if (!(await mayActFor(admin, callerUserId, targetUserId))) throw new Error(NOT_YOURS);
}

/**
 * The same question as `assertActingFor`, answered rather than thrown.
 *
 * `assertActingFor` is defined in terms of this, so there is still exactly ONE
 * implementation of the rule and no way for the two to drift. This is not a
 * second gate: it is the same gate with the refusal left to the caller.
 *
 * It exists for the one caller whose own refusal has to say something DIFFERENT
 * from `NOT_YOURS`. `getWaiverPdfUrl` answers "Waiver PDF not found." to a
 * caller who may not have it, which is the same sentence it answers for an id
 * that does not exist -- so a stranger cannot use it to discover which waiver
 * ids are real. Letting `NOT_YOURS` escape from there would undo that: two
 * different messages for "exists but not yours" and "does not exist" is exactly
 * the probe this module's single refusal sentence exists to prevent.
 *
 * ⚠️ A failed READ still throws. Only the answer "no" is returned as `false`; a
 * database error is not an answer and must not be flattened into one, or an
 * outage would read as a refusal at every call site.
 */
export async function mayActFor(
  admin: AdminClient,
  callerUserId: string,
  targetUserId: string,
): Promise<boolean> {
  // Again here, not only in the schema: this is the security boundary, and it
  // takes two bare strings from wherever a caller got them. Postgres hands back
  // lowercase, so every comparison below is against a lowercase id.
  const callerId = callerUserId.toLowerCase();
  const targetId = targetUserId.toLowerCase();
  if (callerId === targetId) return true;

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
  if (!caller || isDependant(caller)) return false;

  const target = rows.find((r) => r.user_id.toLowerCase() === targetId);
  return target?.guardian_user_id?.toLowerCase() === callerId;
}

/**
 * Throw unless `userId` is an account holder who may be given dependants.
 *
 * The other half of the one-level rule, for the moment BEFORE a dependant
 * exists. `assertActingFor` can only answer "may A act for B", and creating a
 * child has no B yet: the server is about to mint one. So the question it asks
 * here is the narrower "is this person allowed to be a guardian at all", and
 * the answer is no when they are themselves somebody's dependant.
 *
 * It lives here, beside the gate, rather than in `waiver.functions.ts` where
 * its only caller is. #102 asks for a depth check the migration deliberately
 * left to the application (a depth check in SQL needs a trigger), and a second
 * copy of that rule written next to the code that creates a child is exactly
 * how the two drift. It refuses in the SAME words as `assertActingFor` for the
 * same reason: the caller learns that the answer is no, and nothing else.
 *
 * A person with no `profiles` row is refused too. Unlike `assertActingFor`,
 * where a missing row is not the interesting case, here it means the server is
 * about to hang a child off somebody it cannot find, and failing closed costs
 * nothing: every guardian this is asked about was either just resolved through
 * `resolvePersonId` (which creates the profile) or is a live signed-in session.
 */
export async function assertMayHaveDependants(admin: AdminClient, userId: string): Promise<void> {
  const id = userId.toLowerCase();
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, guardian_user_id")
    .eq("user_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || isDependant(data)) throw new Error(NOT_YOURS);
}

/**
 * Is this person on somebody else's account?
 *
 * The one-person, answered form of `isDependant`, for the callers that hold an
 * id rather than a row. It exists as its own export because the answer gates a
 * SEND: `resendClubUserVerification` is the only path that could mint an
 * `email_verification_tokens` row against a dependant, and what that produced
 * was a token bound to a reserved address in a subdomain the club routes no
 * mail for, redeemable by nobody, sitting in the table looking like somebody
 * had been asked to confirm something.
 *
 * Throws on a failed read rather than answering `false`, so a dropped
 * connection cannot turn "we could not check" into "go ahead and send". A
 * person with no `profiles` row is not a dependant, which is the same reading
 * `contactUserIdFor` takes and for the same reason: it is not this module's
 * job to decide what a missing row means, and every auth user has one.
 */
export async function isDependantUser(admin: AdminClient, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, guardian_user_id")
    .eq("user_id", userId.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? isDependant(data) : false;
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

// `listHousehold` below and `contactUserIdFor` above were written in #104 with
// no caller, as a deliberate exception to "no speculative generality": #102
// asked for the household rule to exist in ONE place before three PRs started
// needing it. #105 is the first of those, and it calls both -- `listHousehold`
// to find whether a guardian already has this child on the books, and
// `contactUserIdFor` to decide whose login an approval unlocks. So the
// exception has been paid off; they are ordinary code now.

/** One person on an account, as the household screens list them. */
export type HouseholdMember = {
  user_id: string;
  first_name: string;
  middle_name: string | null;
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
  const columns =
    "user_id, first_name, middle_name, last_name, preferred_name, date_of_birth, guardian_user_id";
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

/**
 * Whose memberships bear on `userId`'s `member` role, and whose role moves when
 * `userId`'s own memberships change.
 *
 * Two questions, one pair of reads, because they are answered from the same two
 * rows. `syncMemberRole` is the only caller and needs both: it is handed a
 * single user id by whichever membership just opened or closed, and a child's
 * plan changes their PARENT's label as well as their own.
 *
 * `countsFor` is this person plus their dependants. For a dependant that is just
 * themselves, which the one-level rule guarantees rather than this code
 * special-casing it.
 *
 * Returns **null when the question could not be asked**, which is deliberately
 * not the same value as "nobody". `syncMemberRole` revokes on "they hold
 * nothing", so collapsing a failed read into an empty household would strip the
 * label off paid-up parents the moment `profiles` had a blip -- the same reason
 * that function already returns early on a failed membership read.
 */
export async function householdRoleScope(
  admin: AdminClient,
  userId: string,
): Promise<{ countsFor: string[]; guardianUserId: string | null } | null> {
  const [self, dependants] = await Promise.all([
    admin.from("profiles").select("user_id, guardian_user_id").eq("user_id", userId).maybeSingle(),
    admin.from("profiles").select("user_id").eq("guardian_user_id", userId),
  ]);
  if (self.error) {
    console.error(
      `[householdRoleScope] could not read the profile for ${userId}:`,
      self.error.message,
    );
    return null;
  }
  if (dependants.error) {
    console.error(
      `[householdRoleScope] could not read the dependants of ${userId}:`,
      dependants.error.message,
    );
    return null;
  }
  return {
    countsFor: [userId, ...(dependants.data ?? []).map((d) => d.user_id)],
    guardianUserId: self.data?.guardian_user_id ?? null,
  };
}
