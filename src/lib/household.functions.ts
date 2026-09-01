// The household, over the wire.
//
// `household.ts` holds the rules (who may act for whom, who the club writes to,
// who is on an account). This is the thin server-function layer over them, kept
// separate for the reason every `*.functions.ts` module is: the rules stay pure
// and unit-testable, and the handler does nothing but authenticate and call
// them.
//
// Two functions: the picker `/waiver` needs (#105), and the list the account
// screens need (#106). Nothing is added here ahead of a caller.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isDependant, listHousehold } from "@/lib/household";
import {
  greetingName,
  nameWithPreferred,
  unpaidInvoices,
  type LifecycleStatus,
  type MembershipStatus,
  type UnpaidInvoice,
} from "@/lib/validation";

/** One person on the caller's account, as `/waiver`'s picker needs them. */
export type MyDependant = {
  user_id: string;
  first_name: string;
  /**
   * Carried even though no screen prints it. Picking a child prefills the
   * waiver form from these fields, and a middle name that came back missing
   * would be submitted blank and then promoted over the stored one at
   * approval: a field quietly erased by choosing the person it belongs to.
   */
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  date_of_birth: string | null;
};

/**
 * The people on the caller's account who have no login of their own.
 *
 * Only ever about the caller: there is no target parameter, so there is nothing
 * here to point at somebody else's household and `assertActingFor` has no
 * question to answer. A dependant who somehow held a session would get an empty
 * list, which is the truthful answer under the one-level rule.
 *
 * What it deliberately does NOT return is any email address. A dependant's is
 * the reserved, non-deliverable one, it identifies nobody, and no screen has
 * any use for it. The name and date of birth are what the picker shows and what
 * `resolveDependantId` matches on, so they are what this hands back.
 */
export const listMyDependants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyDependant[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const household = await listHousehold(supabaseAdmin, context.userId);
    return household.filter(isDependant).map((person) => ({
      user_id: person.user_id,
      first_name: person.first_name,
      middle_name: person.middle_name,
      last_name: person.last_name,
      preferred_name: person.preferred_name,
      date_of_birth: person.date_of_birth,
    }));
  });

/** One person on the account, as the account screens list them. */
export type HouseholdPerson = {
  user_id: string;
  /** Legal full name with the preferred name quoted in. */
  name: string | null;
  /**
   * What to CALL them: preferred name, else first name.
   *
   * Carried separately because the two answer different questions and a screen
   * that derives one from the other gets it wrong. `nameWithPreferred` renders
   * `Ada "Addy" Lovelace`, so taking its first word gives "Ada" -- the legal
   * name -- while every other screen greets her as "Addy". Two screens in this
   * PR were calling the same child different things for exactly that reason.
   */
  greeting_name: string | null;
  /** The account holder themselves, rather than somebody on their account. */
  is_self: boolean;
  /** Where they are in the club's funnel, for the pill beside their name. */
  lifecycle_status: LifecycleStatus;
  /**
   * Whether they have submitted a waiver at all, approved or not.
   *
   * Not the same as the aggregation's `has_waiver`, which means APPROVED. The
   * account page uses this one to decide whether the holder is a person the
   * club has records for or somebody who only ever signed for their children,
   * and a waiver sitting unapproved still makes them the former.
   */
  has_any_waiver: boolean;
  latest_plan_name: string | null;
  latest_plan_kind: string | null;
  latest_membership_status: MembershipStatus | null;
  latest_sessions_remaining: number | null;
};

/**
 * Everybody on the caller's account: themselves first, then their dependants.
 *
 * Only ever about the caller. There is no target parameter, so there is nothing
 * here to point at somebody else's household, exactly as `listMyDependants`
 * above. A dependant who somehow held a session sees only themselves, which is
 * the truthful answer under the one-level rule.
 *
 * The funnel phase and membership line come from `aggregateClubUsers`, the same
 * code path the manager directory reads, rather than a second derivation for
 * the member's own screen. A parent and a manager looking at the same child
 * must not see different answers about them.
 *
 * No addresses. The holder's own is on the session and every dependant's is the
 * reserved one, so there is nothing this could usefully return.
 */
export const listMyHousehold = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<HouseholdPerson[]> => {
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const { aggregateClubUsers } = await import("@/lib/club-users");

    const household = await listHousehold(admin, context.userId);
    const ids = household.map((p) => p.user_id);
    if (ids.length === 0) return [];

    const [
      { data: profiles, error: pErr },
      { data: waivers, error: wErr },
      { data: memberships, error: mErr },
      { data: plans, error: plErr },
    ] = await Promise.all([
      admin
        .from("profiles")
        .select(
          "user_id, first_name, middle_name, last_name, preferred_name, phone, uts_student_number, gi_size, belt_size, created_at, guardian_user_id",
        )
        .in("user_id", ids),
      admin.from("waivers").select("user_id, signed_at, approval_status").in("user_id", ids),
      admin.from("memberships").select("*").in("user_id", ids),
      admin.from("membership_plans").select("id, name, kind"),
    ]);
    // Every read fails the card. A failed memberships read reaching the
    // aggregation as an empty list would show a paid-up child as a visitor with
    // no plan, and a parent would go and buy one they already have.
    if (pErr) throw new Error(pErr.message);
    if (wErr) throw new Error(wErr.message);
    if (mErr) throw new Error(mErr.message);
    if (plErr) throw new Error(plErr.message);

    const waiverRows = waivers ?? [];
    const aggregated = aggregateClubUsers({
      profiles: profiles ?? [],
      // Deliberately empty. This screen prints no address, and asking for one
      // would mean resolving a household to answer a question nobody asked.
      emails: [],
      waivers: waiverRows,
      memberships: (memberships ?? []).map((m) => ({
        user_id: m.user_id,
        plan_id: m.plan_id,
        status: m.status,
        price_cents: m.price_cents,
        is_student: m.is_student,
        uts_student_number: m.uts_student_number,
        sessions_remaining: m.sessions_remaining,
        created_at: m.created_at,
      })),
      plans: plans ?? [],
      roles: [],
      leads: [],
    });

    const byId = new Map(aggregated.map((u) => [u.user_id, u]));
    const anyWaiver = new Set(waiverRows.map((w) => w.user_id));

    // Household order, not aggregation order: the holder first, then their
    // children by first name, which is what `listHousehold` already decided.
    return household.map((person) => {
      const summary = byId.get(person.user_id);
      return {
        user_id: person.user_id,
        name: summary?.name ?? nameWithPreferred(person) ?? null,
        greeting_name: summary?.greeting_name ?? greetingName(person) ?? null,
        is_self: person.user_id === context.userId,
        lifecycle_status: summary?.lifecycle_status ?? "lead",
        has_any_waiver: anyWaiver.has(person.user_id),
        latest_plan_name: summary?.latest_plan_name ?? null,
        latest_plan_kind: summary?.latest_plan_kind ?? null,
        latest_membership_status: summary?.latest_membership_status ?? null,
        latest_sessions_remaining: summary?.latest_sessions_remaining ?? null,
      };
    });
  });

/** What one person on the account still owes, as transfers rather than rows. */
export type HouseholdInvoices = {
  user_id: string;
  /** Who the transfer is for, so a parent can tell three of them apart. */
  name: string | null;
  is_self: boolean;
  invoices: UnpaidInvoice[];
};

/**
 * Everything still to pay across the whole account, per person.
 *
 * The "How to pay" panel is the reason this exists rather than the page asking
 * `getMyMemberships` once per child. A parent with three children owes three
 * transfers with three different references (`buildPaymentReference` mixes in
 * `stableCode(userId)`, so siblings never collide), and the one thing they must
 * be able to do is see all three at once and tell which is which. Asking
 * per person would also mean re-reading the plan catalogue once per child for
 * a panel that shows no plans.
 *
 * Only ever about the caller's own household, like everything else in this
 * file: no target parameter, so there is nothing to point elsewhere.
 *
 * People with nothing outstanding are dropped, so the panel is not padded with
 * rows saying nothing is owed.
 */
export const listHouseholdInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<HouseholdInvoices[]> => {
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");

    const household = await listHousehold(admin, context.userId);
    const ids = household.map((p) => p.user_id);
    if (ids.length === 0) return [];

    const [{ data: rows, error }, { data: plans, error: plErr }] = await Promise.all([
      admin
        .from("memberships")
        .select("id, user_id, plan_id, status, paid_at, price_cents, payment_reference")
        .in("user_id", ids)
        // Newest first, matching `getMyMemberships`, because `unpaidInvoices`
        // groups by reference in the order it is handed the rows and an
        // unordered read is free to hand them over differently each time. The
        // two panels a member can see at once would then disagree about the
        // order of the same transfers, and a person looking for the one they
        // have not paid would be reading a list that moves.
        .order("created_at", { ascending: false }),
      admin.from("membership_plans").select("id, name"),
    ]);
    // Both fail the panel. An errored read reaching `unpaidInvoices` as an
    // empty list would tell a parent they owe nothing, which is the one wrong
    // answer this panel must never give.
    if (error) throw new Error(error.message);
    if (plErr) throw new Error(plErr.message);

    const planName = new Map((plans ?? []).map((p) => [p.id, p.name]));
    return household
      .map((person) => ({
        user_id: person.user_id,
        name: nameWithPreferred(person) || null,
        is_self: person.user_id === context.userId,
        invoices: unpaidInvoices(
          (rows ?? [])
            .filter((m) => m.user_id === person.user_id)
            .map((m) => ({
              id: m.id,
              status: m.status,
              paid_at: m.paid_at,
              plan_name: planName.get(m.plan_id) ?? null,
              price_cents: m.price_cents,
              payment_reference: m.payment_reference,
            })),
        ),
      }))
      .filter((person) => person.invoices.length > 0);
  });
