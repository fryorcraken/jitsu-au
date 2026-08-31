// Pure, server-import-free aggregation of the club's *people* — the funnel.
//
// One row per person, across the whole lifecycle: leads (interest
// registrations only — no person record yet), and persons (an auth user whose
// email lives on auth.users, plus their `profiles` row keyed by the same user
// id). This module joins each profile to its email (resolved by the caller via
// the service-role `user_emails` RPC), its waivers (approved and pending), its
// memberships, its roles, and derives the lifecycle phase:
// lead -> applicant -> visitor -> member (+ lapsed).
//
// It is deliberately free of any DB/server import so it is unit-testable and
// can be shared by both the manager agent HTTP API (`list_users`) and the
// manager user-list screen (`/manager/users`) — the single aggregation path.
import {
  deriveLifecycleStatus,
  greetingName,
  nameWithPreferred,
  normalizeEmail,
} from "./validation";
import { householdContacts, type HouseholdContactProfile } from "./household-email";
import type {
  LifecycleStatus,
  MembershipPlanKind,
  MembershipStatus,
  PersonNameParts,
} from "./validation";

/** Max interest-registration (lead) rows the directory pulls in one page. */
export const LEADS_LIMIT = 2000;

/**
 * Max check-in rows read to count attendance. One row per person per class, so
 * this is years of training for a club this size; the cap exists so a runaway
 * read cannot take the directory down with it.
 */
export const CHECKINS_LIMIT = 50000;

/** The profile fields the aggregation reads (one row per person). */
export type ClubUserProfile = {
  user_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  phone: string | null;
  uts_student_number: string | null;
  gi_size: string | null;
  belt_size: string | null;
  created_at: string;
  /**
   * The account holder this person is a dependant of, or null for everybody
   * else. REQUIRED rather than optional on purpose: it decides whose address is
   * shown on this person's row, and an optional field defaulting to null would
   * make a forgotten `.select()` render a child as an account holder with their
   * own mailbox, silently. Required, the typecheck refuses the caller instead.
   */
  guardian_user_id: string | null;
};

/** A resolved auth email for a person (from the `user_emails` RPC). */
export type ClubUserEmail = {
  user_id: string;
  email: string;
  /**
   * When someone last proved they can read this address, by opening a link we
   * sent there. Null means nobody ever has. Lives on `auth.users`, never copied
   * onto `profiles`, so there is only one thing to trust.
   *
   * OPTIONAL on purpose, and not the same thing as nullable. The live RPC always
   * projects the column, but code deploys and migrations go live by different
   * routes (see docs/database-changes.md), so a build running against a database
   * that predates `20260729000000_email_verification.sql` gets rows without the
   * key at all. Every consumer normalizes with `?? null`, which turns both the
   * missing key and a real NULL into "nobody has proved this address" — the safe
   * reading. `ClubUser.email_confirmed_at` below is the normalized, required form.
   */
  email_confirmed_at?: string | null;
};

/** The waiver fields the aggregation reads (ALL waivers, any status). */
export type ClubUserWaiver = {
  user_id: string;
  signed_at: string;
  approval_status: string;
};

/** An interest registration (lead) row the aggregation reads. */
export type ClubUserLead = {
  email: string;
  name: string;
  phone: string | null;
  created_at: string;
};

/** The membership fields the aggregation reads. */
export type ClubUserMembership = {
  user_id: string | null;
  plan_id: string;
  status: string;
  price_cents: number;
  is_student: boolean;
  uts_student_number: string | null;
  /** Credits left. Null for a plan that was never sold as a number of classes. */
  sessions_remaining: number | null;
  created_at: string;
};

/** The plan fields needed to label a membership and derive lifecycle. */
export type ClubUserPlan = {
  id: string;
  name: string;
  kind: string;
};

/** A single role assignment row. */
export type ClubUserRole = {
  user_id: string;
  role: string;
};

/**
 * One recorded attendance. Only the person is needed: this counts classes
 * trained, whatever paid for them, which is the coaching and grading number.
 * How many credits a membership has left is a different question and lives on
 * the membership.
 */
export type ClubUserCheckin = {
  user_id: string;
};

/** One aggregated person (or lead) known to the club. */
export type ClubUser = {
  /** Null for a lead — they have no person record yet. */
  user_id: string | null;
  /** Legal full name, with the preferred name quoted in: `Ada "Addy" Lovelace`. */
  name: string | null;
  /** What to call them: preferred name, else first name. Null for a bare lead. */
  greeting_name: string | null;
  /**
   * The address to WRITE TO about this person, which is not always their own.
   *
   * A dependant has no mailbox: their `auth.users` address is a reserved,
   * non-deliverable string that is never printed and never sent to, so what
   * appears here is their guardian's. `email_belongs_to` says so, and any
   * screen printing this must print that too.
   */
  email: string | null;
  /**
   * Whose address `email` is, when it is not this person's own. Null for every
   * account holder, which is almost everybody.
   *
   * A screen that shows the address without this says a nine-year-old has an
   * inbox, which is how a manager comes to write to one.
   */
  email_belongs_to: string | null;
  /**
   * When this address was proven, or null if never. Always null for a lead:
   * they have no person record to hold a confirmation, so their proof (if any)
   * is held on the token until they sign a waiver. See `email-verification.ts`.
   *
   * It is a fact about the ADDRESS, so for a dependant it is the guardian's
   * confirmation state. That is the truthful thing to badge: the guardian is
   * who proved they can read that mailbox.
   */
  email_confirmed_at: string | null;
  phone: string | null;
  roles: string[];
  lifecycle_status: LifecycleStatus;
  has_waiver: boolean;
  waiver_signed_at: string | null;
  is_uts_student: boolean;
  uts_student_number: string | null;
  /** Kit sizing, as size codes off the club's charts. Null when never given. */
  gi_size: string | null;
  belt_size: string | null;
  latest_plan_name: string | null;
  /**
   * The kind of plan behind `latest_membership_status`, so a screen can name
   * that status correctly: an ended trial or class pack is "used up", an ended
   * training period is "expired". Null for a lead, or when the plan row could
   * not be resolved.
   */
  latest_plan_kind: string | null;
  latest_membership_status: MembershipStatus | null;
  /**
   * Credits left on that latest membership. Needed alongside the kind because
   * an ended credit plan is only "used up" if its classes are actually gone: a
   * refunded check-in can leave one `expired` with a credit still on it.
   */
  latest_sessions_remaining: number | null;
  membership_count: number;
  /** Classes this person has been checked in to, all-time. Always 0 for a lead. */
  sessions_attended: number;
  first_seen_at: string | null;
};

/** True for a non-empty (after trim) student number. */
function hasStudentNumber(n: string | null | undefined): boolean {
  return Boolean(n && n.trim().length > 0);
}

/** The distinct user ids across a set of profiles (to scope roles/emails queries). */
export function profileUserIds(profiles: Pick<ClubUserProfile, "user_id">[]): string[] {
  return [...new Set(profiles.map((p) => p.user_id))];
}

/** The name parts a person is displayed by when all a screen has is their id. */
export type PersonNameRow = PersonNameParts & { user_id: string };

/**
 * Label people by id, for the places that store a bare `user_id` and have to
 * show a human: who approved a waiver, who filed one.
 *
 * The name wins; the email is the fallback for somebody with no profile row (a
 * manager account that never signed a waiver has none). Anyone who resolves to
 * neither is simply absent from the map — the caller decides what an
 * unresolvable id reads as, rather than being handed a raw uuid to render.
 */
export function personLabelsById(input: {
  profiles: PersonNameRow[];
  emails: { user_id: string; email: string }[];
}): Map<string, string> {
  const labels = new Map<string, string>();
  for (const e of input.emails) {
    const email = (e.email || "").trim();
    if (email) labels.set(e.user_id, email);
  }
  for (const p of input.profiles) {
    const name = nameWithPreferred(p).trim();
    if (name) labels.set(p.user_id, name);
  }
  return labels;
}

/**
 * Aggregate profiles + emails + waivers + memberships + roles + leads into one
 * row per person, sorted by name (A–Z). A lead whose email already belongs to
 * a person is dropped (they moved on in the funnel); duplicate lead emails
 * keep the latest registration. Pure: callers do their own filtering/capping.
 */
export function aggregateClubUsers(input: {
  profiles: ClubUserProfile[];
  emails: ClubUserEmail[];
  /**
   * Extra profile rows used ONLY to resolve contact addresses and name whose
   * they are. Never emitted as a person of their own.
   *
   * `listClubUsers` needs none: it lists everybody, so a dependant's guardian
   * is already in `profiles`. `getClubUser` reads one person, and if that
   * person is a dependant their guardian is not in the list at all, so it
   * passes them here.
   */
  guardians?: HouseholdContactProfile[];
  waivers: ClubUserWaiver[];
  memberships: ClubUserMembership[];
  plans: ClubUserPlan[];
  roles: ClubUserRole[];
  leads: ClubUserLead[];
  checkins?: ClubUserCheckin[];
}): ClubUser[] {
  const planById = new Map(input.plans.map((p) => [p.id, p]));
  const emailByUser = new Map(input.emails.map((e) => [e.user_id, e.email]));
  const emailConfirmedByUser = new Map(
    input.emails.map((e) => [e.user_id, e.email_confirmed_at ?? null]),
  );
  // The display side of `household-email.ts`, resolved once for everybody on
  // the page. A dependant's row shows their guardian's address and says whose
  // it is; every account holder is unaffected.
  const contacts = householdContacts({
    people: [...input.profiles, ...(input.guardians ?? [])],
    emails: input.emails,
  });

  // Waiver states per person: latest APPROVED signature (the waiver on file)
  // plus whether any submission exists at all.
  const approvedSignedByUser = new Map<string, string>();
  const hasAnyWaiverByUser = new Set<string>();
  for (const w of input.waivers) {
    hasAnyWaiverByUser.add(w.user_id);
    if (w.approval_status !== "approved") continue;
    const prev = approvedSignedByUser.get(w.user_id);
    if (!prev || prev < w.signed_at) approvedSignedByUser.set(w.user_id, w.signed_at);
  }

  // Group memberships by user, newest first (by created_at).
  const membershipsByUser = new Map<string, ClubUserMembership[]>();
  for (const m of input.memberships) {
    if (!m.user_id) continue;
    const list = membershipsByUser.get(m.user_id) ?? [];
    list.push(m);
    membershipsByUser.set(m.user_id, list);
  }
  for (const list of membershipsByUser.values()) {
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  const checkinsByUser = new Map<string, number>();
  for (const c of input.checkins ?? [])
    checkinsByUser.set(c.user_id, (checkinsByUser.get(c.user_id) ?? 0) + 1);

  const rolesByUser = new Map<string, string[]>();
  for (const r of input.roles) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push(r.role);
    rolesByUser.set(r.user_id, list);
  }

  const users: ClubUser[] = input.profiles.map((p) => {
    const contact = contacts.displayEmail(p.user_id);
    const ms = membershipsByUser.get(p.user_id) ?? [];
    const latest = ms[0] ?? null;
    const approvedSignedAt = approvedSignedByUser.get(p.user_id) ?? null;
    const hasApprovedWaiver = approvedSignedAt != null;
    const hasPendingWaiver = !hasApprovedWaiver && hasAnyWaiverByUser.has(p.user_id);

    const lifecycle_status = deriveLifecycleStatus({
      hasApprovedWaiver,
      hasPendingWaiver,
      memberships: ms.map((m) => ({
        status: m.status as MembershipStatus,
        kind: (planById.get(m.plan_id)?.kind ?? "session") as MembershipPlanKind,
        price_cents: m.price_cents,
      })),
    });

    // UTS-student status is trust-based on a non-empty student number. Prefer
    // the number on the profile; fall back to membership data (the student
    // rate + number captured at membership start).
    const profileNumber = p.uts_student_number?.trim() || null;
    const studentMembership =
      ms.find((m) => hasStudentNumber(m.uts_student_number)) ??
      ms.find((m) => m.is_student) ??
      null;
    const membershipNumber = studentMembership?.uts_student_number?.trim() || null;
    const uts_student_number = profileNumber ?? membershipNumber;
    const is_uts_student = Boolean(profileNumber) || Boolean(studentMembership);

    // First-seen: earliest of the profile creation, approved waiver signature
    // and membership dates.
    const dates = [
      p.created_at,
      ...ms.map((m) => m.created_at),
      ...(approvedSignedAt ? [approvedSignedAt] : []),
    ].filter(Boolean);
    const first_seen_at = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;

    return {
      user_id: p.user_id,
      name: nameWithPreferred(p) || null,
      greeting_name: greetingName(p) || null,
      email: contact.email,
      email_belongs_to: contact.onBehalfOf?.name ?? null,
      // Keyed on whose address it actually is, so a dependant badges their
      // guardian's confirmation rather than a reserved address nobody ever
      // confirmed.
      email_confirmed_at: emailConfirmedByUser.get(contacts.contactUserId(p.user_id)) ?? null,
      phone: p.phone,
      roles: rolesByUser.get(p.user_id) ?? [],
      lifecycle_status,
      has_waiver: hasApprovedWaiver,
      waiver_signed_at: approvedSignedAt,
      is_uts_student,
      uts_student_number,
      gi_size: p.gi_size,
      belt_size: p.belt_size,
      latest_plan_name: latest ? (planById.get(latest.plan_id)?.name ?? null) : null,
      latest_plan_kind: latest ? (planById.get(latest.plan_id)?.kind ?? null) : null,
      latest_membership_status: latest ? (latest.status as MembershipStatus) : null,
      latest_sessions_remaining: latest ? latest.sessions_remaining : null,
      membership_count: ms.length,
      sessions_attended: checkinsByUser.get(p.user_id) ?? 0,
      first_seen_at,
    };
  });

  // Leads: interest registrations whose email doesn't belong to a person yet.
  // Latest registration wins per (normalized) email.
  const personEmails = new Set([...emailByUser.values()].map((e) => normalizeEmail(e)));
  const leadByEmail = new Map<string, ClubUserLead>();
  for (const lead of input.leads) {
    const email = normalizeEmail(lead.email);
    if (personEmails.has(email)) continue;
    const prev = leadByEmail.get(email);
    if (!prev || prev.created_at < lead.created_at) leadByEmail.set(email, lead);
  }
  for (const [email, lead] of leadByEmail) {
    users.push({
      user_id: null,
      name: lead.name.trim() || null,
      greeting_name: null,
      email,
      // A lead is an address that wrote in. It is theirs by definition, and
      // there is no household to resolve: a lead has no person record at all.
      email_belongs_to: null,
      // A lead has no person record, so there is nothing here to badge.
      email_confirmed_at: null,
      phone: lead.phone,
      roles: [],
      lifecycle_status: "lead",
      has_waiver: false,
      waiver_signed_at: null,
      is_uts_student: false,
      uts_student_number: null,
      // A lead has given us nothing but an email: no profile, no sizes.
      gi_size: null,
      belt_size: null,
      latest_plan_name: null,
      latest_plan_kind: null,
      latest_membership_status: null,
      latest_sessions_remaining: null,
      membership_count: 0,
      // A lead has never been on the mat: there is no person record to check in.
      sessions_attended: 0,
      first_seen_at: lead.created_at,
    });
  }

  users.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return users;
}
