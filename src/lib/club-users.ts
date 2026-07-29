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
import type { LifecycleStatus, MembershipPlanKind, MembershipStatus } from "./validation";

/** Max interest-registration (lead) rows the directory pulls in one page. */
export const LEADS_LIMIT = 2000;

/** The profile fields the aggregation reads (one row per person). */
export type ClubUserProfile = {
  user_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  phone: string | null;
  uts_student_number: string | null;
  created_at: string;
};

/** A resolved auth email for a person (from the `user_emails` RPC). */
export type ClubUserEmail = {
  user_id: string;
  email: string;
  /**
   * When someone last proved they can read this address, by opening a link we
   * sent there. Null means nobody ever has. Lives on `auth.users`, never copied
   * onto `profiles`, so there is only one thing to trust.
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

/** One aggregated person (or lead) known to the club. */
export type ClubUser = {
  /** Null for a lead — they have no person record yet. */
  user_id: string | null;
  /** Legal full name, with the preferred name quoted in: `Ada "Addy" Lovelace`. */
  name: string | null;
  /** What to call them: preferred name, else first name. Null for a bare lead. */
  greeting_name: string | null;
  email: string | null;
  /**
   * When this address was proven, or null if never. Always null for a lead:
   * they have no person record to hold a confirmation, so their proof (if any)
   * is held on the token until they sign a waiver. See `email-verification.ts`.
   */
  email_confirmed_at: string | null;
  phone: string | null;
  roles: string[];
  lifecycle_status: LifecycleStatus;
  has_waiver: boolean;
  waiver_signed_at: string | null;
  is_uts_student: boolean;
  uts_student_number: string | null;
  latest_plan_name: string | null;
  latest_membership_status: MembershipStatus | null;
  membership_count: number;
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

/**
 * Aggregate profiles + emails + waivers + memberships + roles + leads into one
 * row per person, sorted by name (A–Z). A lead whose email already belongs to
 * a person is dropped (they moved on in the funnel); duplicate lead emails
 * keep the latest registration. Pure: callers do their own filtering/capping.
 */
export function aggregateClubUsers(input: {
  profiles: ClubUserProfile[];
  emails: ClubUserEmail[];
  waivers: ClubUserWaiver[];
  memberships: ClubUserMembership[];
  plans: ClubUserPlan[];
  roles: ClubUserRole[];
  leads: ClubUserLead[];
}): ClubUser[] {
  const planById = new Map(input.plans.map((p) => [p.id, p]));
  const emailByUser = new Map(input.emails.map((e) => [e.user_id, e.email]));
  const emailConfirmedByUser = new Map(
    input.emails.map((e) => [e.user_id, e.email_confirmed_at ?? null]),
  );

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

  const rolesByUser = new Map<string, string[]>();
  for (const r of input.roles) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push(r.role);
    rolesByUser.set(r.user_id, list);
  }

  const users: ClubUser[] = input.profiles.map((p) => {
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
      email: emailByUser.get(p.user_id) ?? null,
      email_confirmed_at: emailConfirmedByUser.get(p.user_id) ?? null,
      phone: p.phone,
      roles: rolesByUser.get(p.user_id) ?? [],
      lifecycle_status,
      has_waiver: hasApprovedWaiver,
      waiver_signed_at: approvedSignedAt,
      is_uts_student,
      uts_student_number,
      latest_plan_name: latest ? (planById.get(latest.plan_id)?.name ?? null) : null,
      latest_membership_status: latest ? (latest.status as MembershipStatus) : null,
      membership_count: ms.length,
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
      // A lead has no person record, so there is nothing here to badge.
      email_confirmed_at: null,
      phone: lead.phone,
      roles: [],
      lifecycle_status: "lead",
      has_waiver: false,
      waiver_signed_at: null,
      is_uts_student: false,
      uts_student_number: null,
      latest_plan_name: null,
      latest_membership_status: null,
      membership_count: 0,
      first_seen_at: lead.created_at,
    });
  }

  users.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return users;
}
