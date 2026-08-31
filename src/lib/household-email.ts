// Which address belongs to a person, once some people have no address of their
// own.
//
// A dependant's `auth.users` row carries a reserved, non-deliverable address in
// a subdomain the club never routes mail for (`waiver.functions.ts` has the
// generator and the GoTrue finding behind it). It is a bare uuid. It identifies
// nobody, no mailbox is behind it, and it must never be sent to and never be
// printed. So the single question "what is this person's email?" splits in two,
// and they have DIFFERENT answers:
//
//   * **Delivery** -- where does a message about this person go? Their
//     guardian's mailbox, for a dependant. `deliveryEmail`.
//   * **Display** -- what does a screen print as their contact? Their
//     guardian's address, AND whose it is. A bare address under a child's name
//     reads as the child's own, which is how a manager ends up believing they
//     can write to a nine-year-old. `displayEmail`.
//
// One helper per side, resolved once, rather than the rule taught to the nine
// call sites that ask. #106 has the classification table; the short version is
// that everything which SENDS uses the first, everything which PRINTS uses the
// second, and the two paths a dependant can never reach (blog comments,
// calendar RSVPs) use neither and are left alone.
//
// ⚠️ The reserved address is never looked up in the first place. Every lookup
// below resolves the contact person FIRST and asks `user_emails` only about
// them, so a dependant's own address does not enter this process at all and
// cannot leak from a field somebody added later. That is deliberate, and it is
// stronger than filtering it out on the way to the screen: there is nothing to
// filter.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { contactUserIdFor, type HouseholdLink } from "@/lib/household";
import { userEmails } from "@/lib/supabase-rpc";
import { nameWithPreferred } from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** What a screen prints as somebody's contact address. */
export type ContactEmail = {
  /** The address to show. Null when none could be resolved. */
  email: string | null;
  /**
   * Set only when the address belongs to somebody OTHER than the person being
   * shown, which today means a dependant's guardian. Null for an account
   * holder, whose address is their own and needs no explanation.
   */
  onBehalfOf: { user_id: string; name: string | null } | null;
};

/** The `profiles` columns this module reads. */
export type HouseholdContactProfile = HouseholdLink & {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
};

const PROFILE_COLUMNS =
  "user_id, guardian_user_id, first_name, middle_name, last_name, preferred_name";

/**
 * Both answers for a set of people, resolved in one pass.
 *
 * Returned as a lookup rather than a bare map because the two sides need
 * different things out of the same rows, and building it twice is how they
 * drift.
 */
export type HouseholdContacts = {
  /**
   * Where a message ABOUT this person goes: their guardian's mailbox if they
   * have one, their own otherwise. Null when no address could be resolved, in
   * which case the caller must not send.
   */
  deliveryEmail(userId: string): string | null;
  /** What a screen prints as this person's contact, and whose address it is. */
  displayEmail(userId: string): ContactEmail;
  /** The person the club writes to about this person. */
  contactUserId(userId: string): string;
};

/**
 * Build the lookup from rows already in hand.
 *
 * Pure, so the rule is unit-testable without a database, and so the aggregation
 * helpers that are already pure (`aggregateClubUsers`) can use it without
 * growing IO.
 *
 * `people` may be missing a row: a person with no `profiles` row is treated as
 * an account holder with no guardian, which is what they are. It is not this
 * module's job to decide what a missing row means (`household.ts` says the same
 * thing about the gate).
 */
export function householdContacts(input: {
  people: HouseholdContactProfile[];
  /** Resolved addresses, keyed by the CONTACT person's id. */
  emails: { user_id: string; email: string }[];
}): HouseholdContacts {
  const byId = new Map(input.people.map((p) => [p.user_id.toLowerCase(), p]));
  const emailById = new Map(input.emails.map((e) => [e.user_id.toLowerCase(), e.email]));

  const contactUserId = (userId: string): string => {
    const id = userId.toLowerCase();
    const person = byId.get(id);
    return person ? contactUserIdFor(person).toLowerCase() : id;
  };

  return {
    contactUserId,
    deliveryEmail: (userId) => emailById.get(contactUserId(userId)) ?? null,
    displayEmail: (userId) => {
      const id = userId.toLowerCase();
      const contactId = contactUserId(id);
      const email = emailById.get(contactId) ?? null;
      if (contactId === id) return { email, onBehalfOf: null };
      const guardian = byId.get(contactId);
      return {
        email,
        onBehalfOf: {
          user_id: contactId,
          name: guardian ? nameWithPreferred(guardian) || null : null,
        },
      };
    },
  };
}

/**
 * The same lookup, loaded for a set of people.
 *
 * Two round trips: the guardian links for the people asked about, then the
 * addresses of whoever turns out to be the contact for each. The guardians are
 * read a second time so a display can name them, which is the half of "say
 * whose it is" that a screen cannot invent.
 *
 * Degrades the way `emailsByUserId` does: a failed address lookup yields nulls
 * rather than throwing, because a directory with missing emails is more useful
 * than an error page. A failed PROFILE read does throw, because that one is not
 * a degradation: with no guardian links every dependant would silently look
 * like an account holder with no address, which is a wrong answer rather than a
 * missing one.
 */
export async function loadHouseholdContacts(
  admin: AdminClient,
  userIds: string[],
): Promise<HouseholdContacts> {
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()))].filter(Boolean);
  if (ids.length === 0) return householdContacts({ people: [], emails: [] });

  const { data: people, error } = await admin
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .in("user_id", ids);
  if (error) throw new Error(error.message);

  const rows = (people ?? []) as HouseholdContactProfile[];
  const byId = new Map(rows.map((p) => [p.user_id.toLowerCase(), p]));
  // Whose addresses are actually needed: the contact person for each id asked
  // about. A dependant's own id is deliberately NOT in this list.
  const contactIds = [
    ...new Set(
      ids.map((id) => {
        const person = byId.get(id);
        return person ? contactUserIdFor(person).toLowerCase() : id;
      }),
    ),
  ];

  // A guardian may not have been among the ids asked about, and a display has
  // to name them. One extra read rather than a name the screen has to guess.
  const missingGuardians = contactIds.filter((id) => !byId.has(id));
  if (missingGuardians.length > 0) {
    const { data: guardians, error: gErr } = await admin
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .in("user_id", missingGuardians);
    if (gErr) throw new Error(gErr.message);
    rows.push(...((guardians ?? []) as HouseholdContactProfile[]));
  }

  const { data: emails, error: eErr } = await userEmails(admin, contactIds);
  if (eErr || !emails) {
    console.error("[household-email] could not resolve contact addresses:", eErr?.message);
    return householdContacts({ people: rows, emails: [] });
  }

  return householdContacts({
    people: rows,
    emails: emails.map((e) => ({ user_id: e.user_id, email: e.email })),
  });
}

/**
 * The id of the person the club writes to about `userId`.
 *
 * The address-free half of the same question, for the callers that need the
 * PERSON rather than their mailbox: the digest's grouping key, and
 * `notification_tokens`, which is one row per inbox. One read, no `user_emails`
 * call at all.
 *
 * Falls back to `userId` on a failed read rather than throwing. Every caller is
 * on a best-effort email path where the alternative to a slightly wrong
 * grouping is no mail at all, and `userId` is the right answer for everybody
 * who is not a dependant, which is almost everybody.
 */
export async function contactUserIdOf(admin: AdminClient, userId: string): Promise<string> {
  const { data, error } = await admin
    .from("profiles")
    .select("user_id, guardian_user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return userId;
  return contactUserIdFor(data);
}

/**
 * One person's delivery address, for the callers that only ever have one.
 *
 * A thin wrapper on purpose. Every send path used to run its own
 * `userEmails(db, [userId])`, and this replaces that call rather than sitting
 * beside it, so there is no route left that reaches an address without passing
 * through the guardian rule.
 */
export async function deliveryEmailFor(admin: AdminClient, userId: string): Promise<string | null> {
  const contacts = await loadHouseholdContacts(admin, [userId]);
  return contacts.deliveryEmail(userId);
}
