// Pure, server-import-free aggregation of the club's *people*.
//
// A "club user" is a person: one row in `profiles` (keyed by email). This module
// joins each profile to its waivers (has one been signed, and when), its
// memberships, its roles, and derives a lifecycle status. Identity (name, email,
// phone) comes from the profile — the single source of truth — not from waivers.
//
// Memberships, roles and the auth account are keyed by `auth.users` id; a profile
// links to that via `user_id` (null for someone who never made an account). So a
// profile's memberships/roles are matched through its `user_id`.
//
// It is deliberately free of any DB/server import so it is unit-testable and can
// be shared by both the manager agent HTTP API (`list_users`) and the manager
// user-list screen (`/manager/users`) — the single aggregation code path.
import { deriveLifecycleStatus, profileFullName } from "./validation";
import type { LifecycleStatus, MembershipPlanKind, MembershipStatus } from "./validation";

/** The profile fields the aggregation reads (one row per person). */
export type ClubUserProfile = {
  id: string;
  user_id: string | null;
  email: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  phone: string | null;
  uts_student_number: string | null;
  created_at: string;
};

/** The waiver fields the aggregation reads (existence + when, per profile). */
export type ClubUserWaiver = {
  profile_id: string;
  signed_at: string;
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

/** One aggregated person known to the club. */
export type ClubUser = {
  profile_id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
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

/** The non-null auth user ids across a set of profiles (to scope the roles query). */
export function profileUserIds(profiles: Pick<ClubUserProfile, "user_id">[]): string[] {
  const ids = new Set<string>();
  for (const p of profiles) if (p.user_id) ids.add(p.user_id);
  return [...ids];
}

/**
 * Aggregate profiles + waivers + memberships + roles into one row per person,
 * sorted by name (A–Z). Pure: callers do their own filtering/capping/re-sorting.
 */
export function aggregateClubUsers(input: {
  profiles: ClubUserProfile[];
  waivers: ClubUserWaiver[];
  memberships: ClubUserMembership[];
  plans: ClubUserPlan[];
  roles: ClubUserRole[];
}): ClubUser[] {
  const planById = new Map(input.plans.map((p) => [p.id, p]));

  // Latest waiver signature per profile (also marks that a waiver exists).
  const waiverSignedByProfile = new Map<string, string>();
  for (const w of input.waivers) {
    const prev = waiverSignedByProfile.get(w.profile_id);
    if (!prev || prev < w.signed_at) waiverSignedByProfile.set(w.profile_id, w.signed_at);
  }

  // Group memberships by auth user id, newest first (by created_at).
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
    const ms = p.user_id ? (membershipsByUser.get(p.user_id) ?? []) : [];
    const latest = ms[0] ?? null;
    const waiverSignedAt = waiverSignedByProfile.get(p.id) ?? null;
    const hasWaiver = waiverSignedAt != null;

    const lifecycle_status = deriveLifecycleStatus({
      hasWaiver,
      memberships: ms.map((m) => ({
        status: m.status as MembershipStatus,
        kind: (planById.get(m.plan_id)?.kind ?? "session") as MembershipPlanKind,
        price_cents: m.price_cents,
      })),
    });

    // UTS-student status is trust-based on a non-empty student number. Prefer the
    // number on the profile; fall back to membership data (the student rate +
    // number captured at membership start).
    const profileNumber = p.uts_student_number?.trim() || null;
    const studentMembership =
      ms.find((m) => hasStudentNumber(m.uts_student_number)) ??
      ms.find((m) => m.is_student) ??
      null;
    const membershipNumber = studentMembership?.uts_student_number?.trim() || null;
    const uts_student_number = profileNumber ?? membershipNumber;
    const is_uts_student = Boolean(profileNumber) || Boolean(studentMembership);

    // First-seen: earliest of the profile creation, waiver signature and
    // membership dates.
    const dates = [
      p.created_at,
      ...ms.map((m) => m.created_at),
      ...(waiverSignedAt ? [waiverSignedAt] : []),
    ].filter(Boolean);
    const first_seen_at = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;

    const name = profileFullName(p) || null;

    return {
      profile_id: p.id,
      user_id: p.user_id,
      name,
      email: p.email,
      phone: p.phone,
      roles: p.user_id ? (rolesByUser.get(p.user_id) ?? []) : [],
      lifecycle_status,
      has_waiver: hasWaiver,
      waiver_signed_at: waiverSignedAt,
      is_uts_student,
      uts_student_number,
      latest_plan_name: latest ? (planById.get(latest.plan_id)?.name ?? null) : null,
      latest_membership_status: latest ? (latest.status as MembershipStatus) : null,
      membership_count: ms.length,
      first_seen_at,
    };
  });

  users.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return users;
}
