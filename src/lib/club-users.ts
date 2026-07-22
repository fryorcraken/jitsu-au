// Pure, server-import-free aggregation of the club's *people*.
//
// A "club user" is anyone known to the club: someone who has signed a waiver
// and/or holds a membership. This module unions those two populations into one
// row per person, resolving their display name/email/phone from their latest
// waiver, their roles, their lifecycle status, and a summary of their latest
// membership.
//
// It is deliberately free of any DB/server import so it is unit-testable and can
// be shared by both the manager agent HTTP API (`list_users`) and the manager
// user-list screen (`/manager/users`) — the single aggregation code path.
import { deriveLifecycleStatus } from "./validation";
import type { LifecycleStatus, MembershipPlanKind, MembershipStatus } from "./validation";

/** The waiver fields the aggregation reads (latest per user wins). */
export type ClubUserWaiver = {
  user_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  signed_at: string;
  // Student status is trust-based: a non-empty number means UTS student. The
  // generated Supabase types don't include this column on waivers yet, so
  // callers read it via select("*") and it stays optional here.
  uts_student_number?: string | null;
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
  user_id: string;
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

/**
 * The distinct set of user ids known to the club: the union of waiver signers
 * and membership holders. Used to scope the roles query before aggregation.
 */
export function collectClubUserIds(
  waivers: Pick<ClubUserWaiver, "user_id">[],
  memberships: Pick<ClubUserMembership, "user_id">[],
): string[] {
  const ids = new Set<string>();
  for (const w of waivers) if (w.user_id) ids.add(w.user_id);
  for (const m of memberships) if (m.user_id) ids.add(m.user_id);
  return [...ids];
}

/**
 * Aggregate waivers + memberships + roles into one row per person, sorted by
 * name (A–Z). Pure: callers do their own filtering/capping/re-sorting.
 */
export function aggregateClubUsers(input: {
  waivers: ClubUserWaiver[];
  memberships: ClubUserMembership[];
  plans: ClubUserPlan[];
  roles: ClubUserRole[];
}): ClubUser[] {
  const planById = new Map(input.plans.map((p) => [p.id, p]));

  // Latest waiver per user drives the display name/email/phone and marks a
  // signed waiver. Sort signed_at descending so the first seen per user is latest.
  const waiverRows = input.waivers
    .filter((w) => w.user_id)
    .sort((a, b) => (a.signed_at < b.signed_at ? 1 : -1));
  const latestWaiverByUser = new Map<string, ClubUserWaiver>();
  for (const w of waiverRows) {
    if (!latestWaiverByUser.has(w.user_id!)) latestWaiverByUser.set(w.user_id!, w);
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

  const userIds = collectClubUserIds(waiverRows, input.memberships);

  const users: ClubUser[] = userIds.map((uid) => {
    const ms = membershipsByUser.get(uid) ?? [];
    const waiver = latestWaiverByUser.get(uid) ?? null;
    const latest = ms[0] ?? null;

    const lifecycle_status = deriveLifecycleStatus({
      hasWaiver: Boolean(waiver),
      memberships: ms.map((m) => ({
        status: m.status as MembershipStatus,
        kind: (planById.get(m.plan_id)?.kind ?? "session") as MembershipPlanKind,
        price_cents: m.price_cents,
      })),
    });

    // UTS-student status is trust-based on a non-empty student number. Prefer
    // the number captured on the waiver (covers trial signers who never joined);
    // fall back to membership data (the student rate + number at membership start).
    const waiverNumber = waiver?.uts_student_number?.trim() || null;
    const studentMembership =
      ms.find((m) => hasStudentNumber(m.uts_student_number)) ??
      ms.find((m) => m.is_student) ??
      null;
    const membershipNumber = studentMembership?.uts_student_number?.trim() || null;
    const uts_student_number = waiverNumber ?? membershipNumber;
    const is_uts_student = Boolean(waiverNumber) || Boolean(studentMembership);

    // First-seen: earliest of the person's waiver signature and membership dates.
    const dates = [...ms.map((m) => m.created_at), ...(waiver ? [waiver.signed_at] : [])].filter(
      Boolean,
    );
    const first_seen_at = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;

    return {
      user_id: uid,
      name: waiver?.full_name ?? null,
      email: waiver?.email ?? null,
      phone: waiver?.phone ?? null,
      roles: rolesByUser.get(uid) ?? [],
      lifecycle_status,
      has_waiver: Boolean(waiver),
      waiver_signed_at: waiver?.signed_at ?? null,
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
