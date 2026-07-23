import { describe, expect, it } from "vitest";
import {
  aggregateClubUsers,
  profileUserIds,
  type ClubUserMembership,
  type ClubUserPlan,
  type ClubUserProfile,
  type ClubUserWaiver,
} from "./club-users";

const plans: ClubUserPlan[] = [
  { id: "plan-trial", name: "Free trial", kind: "trial" },
  { id: "plan-sem", name: "One semester", kind: "period" },
];

function profile(over: Partial<ClubUserProfile> = {}): ClubUserProfile {
  return {
    id: "p1",
    user_id: "u1",
    email: "ada@example.com",
    first_name: "Ada",
    middle_name: null,
    last_name: "Lovelace",
    phone: "0400 000 000",
    uts_student_number: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function waiver(over: Partial<ClubUserWaiver> = {}): ClubUserWaiver {
  return {
    profile_id: "p1",
    signed_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function membership(over: Partial<ClubUserMembership> = {}): ClubUserMembership {
  return {
    user_id: "u1",
    plan_id: "plan-sem",
    status: "active",
    price_cents: 24500,
    is_student: false,
    uts_student_number: null,
    created_at: "2026-02-01T00:00:00Z",
    ...over,
  };
}

describe("profileUserIds", () => {
  it("collects non-null auth user ids, dropping nulls and dupes", () => {
    const ids = profileUserIds([
      { user_id: "a" },
      { user_id: null },
      { user_id: "b" },
      { user_id: "a" },
    ]);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});

describe("aggregateClubUsers", () => {
  it("returns one row per profile", () => {
    const users = aggregateClubUsers({
      profiles: [
        profile({ id: "p1", user_id: "u1" }),
        profile({ id: "p2", user_id: "u2", first_name: "Bob", last_name: null }),
      ],
      waivers: [],
      memberships: [membership({ user_id: "u2" })],
      plans,
      roles: [],
    });
    expect(users.map((u) => u.profile_id).sort()).toEqual(["p1", "p2"]);
  });

  it("resolves name, email and phone from the profile", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile({ first_name: "Ada", last_name: "Lovelace", phone: "222" })],
      waivers: [],
      memberships: [],
      plans,
      roles: [],
    });
    expect(u.name).toBe("Ada Lovelace");
    expect(u.email).toBe("ada@example.com");
    expect(u.phone).toBe("222");
  });

  it("marks has_waiver and the latest signed_at from the profile's waivers", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile({ id: "p1" })],
      waivers: [
        waiver({ profile_id: "p1", signed_at: "2026-01-01T00:00:00Z" }),
        waiver({ profile_id: "p1", signed_at: "2026-03-01T00:00:00Z" }),
      ],
      memberships: [],
      plans,
      roles: [],
    });
    expect(u.has_waiver).toBe(true);
    expect(u.waiver_signed_at).toBe("2026-03-01T00:00:00Z");
  });

  it("keeps name/email from the profile even with no waiver", () => {
    const [u] = aggregateClubUsers({
      profiles: [
        profile({
          id: "p9",
          user_id: "u9",
          first_name: "Grace",
          last_name: "Hopper",
          email: "grace@example.com",
        }),
      ],
      waivers: [],
      memberships: [membership({ user_id: "u9" })],
      plans,
      roles: [],
    });
    expect(u.name).toBe("Grace Hopper");
    expect(u.email).toBe("grace@example.com");
    expect(u.has_waiver).toBe(false);
  });

  it("derives lifecycle status from waiver + memberships", () => {
    const [member] = aggregateClubUsers({
      profiles: [profile()],
      waivers: [waiver()],
      memberships: [membership({ status: "active", plan_id: "plan-sem" })],
      plans,
      roles: [],
    });
    expect(member.lifecycle_status).toBe("member");

    const [expired] = aggregateClubUsers({
      profiles: [profile({ id: "p9", user_id: "u9" })],
      waivers: [],
      memberships: [membership({ user_id: "u9", status: "cancelled", plan_id: "plan-sem" })],
      plans,
      roles: [],
    });
    expect(expired.lifecycle_status).toBe("expired");
  });

  it("prefers the profile's student number over membership data", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile({ uts_student_number: "99999999" })],
      waivers: [],
      memberships: [membership({ is_student: true, uts_student_number: "11111111" })],
      plans,
      roles: [],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("99999999");
  });

  it("marks a UTS student from the profile alone (no membership)", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile({ uts_student_number: "12345678" })],
      waivers: [],
      memberships: [],
      plans,
      roles: [],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("12345678");
  });

  it("marks a UTS student from a membership number when the profile has none", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile({ uts_student_number: null })],
      waivers: [],
      memberships: [membership({ is_student: true, uts_student_number: "12345678" })],
      plans,
      roles: [],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("12345678");
  });

  it("marks a UTS student on is_student even without a number, and non-students otherwise", () => {
    const [withFlag] = aggregateClubUsers({
      profiles: [profile({ uts_student_number: null })],
      waivers: [],
      memberships: [membership({ is_student: true, uts_student_number: "   " })],
      plans,
      roles: [],
    });
    expect(withFlag.is_uts_student).toBe(true);
    expect(withFlag.uts_student_number).toBeNull();

    const [nonStudent] = aggregateClubUsers({
      profiles: [profile({ uts_student_number: null })],
      waivers: [],
      memberships: [membership({ is_student: false, uts_student_number: null })],
      plans,
      roles: [],
    });
    expect(nonStudent.is_uts_student).toBe(false);
  });

  it("summarises the latest membership by created_at", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile()],
      waivers: [waiver()],
      memberships: [
        membership({
          plan_id: "plan-trial",
          status: "expired",
          created_at: "2026-01-10T00:00:00Z",
        }),
        membership({ plan_id: "plan-sem", status: "active", created_at: "2026-05-10T00:00:00Z" }),
      ],
      plans,
      roles: [],
    });
    expect(u.latest_plan_name).toBe("One semester");
    expect(u.latest_membership_status).toBe("active");
    expect(u.membership_count).toBe(2);
  });

  it("computes first-seen as the earliest of profile, waiver and membership dates", () => {
    const [u] = aggregateClubUsers({
      profiles: [profile({ created_at: "2026-02-01T00:00:00Z" })],
      waivers: [waiver({ signed_at: "2026-03-01T00:00:00Z" })],
      memberships: [membership({ created_at: "2026-01-15T00:00:00Z" })],
      plans,
      roles: [],
    });
    expect(u.first_seen_at).toBe("2026-01-15T00:00:00Z");
  });

  it("attaches roles per user", () => {
    const users = aggregateClubUsers({
      profiles: [
        profile({ id: "p1", user_id: "u1", first_name: "Ada", last_name: "Lovelace" }),
        profile({ id: "p2", user_id: "u2", first_name: "Bob", last_name: null }),
      ],
      waivers: [],
      memberships: [],
      plans,
      roles: [
        { user_id: "u1", role: "manager" },
        { user_id: "u1", role: "member" },
      ],
    });
    const u1 = users.find((u) => u.user_id === "u1")!;
    const u2 = users.find((u) => u.user_id === "u2")!;
    expect(u1.roles.sort()).toEqual(["manager", "member"]);
    expect(u2.roles).toEqual([]);
  });

  it("sorts by name A–Z", () => {
    const users = aggregateClubUsers({
      profiles: [
        profile({ id: "p1", user_id: "u1", first_name: "Zoe", last_name: null }),
        profile({ id: "p2", user_id: "u2", first_name: "Amy", last_name: null }),
      ],
      waivers: [],
      memberships: [],
      plans,
      roles: [],
    });
    expect(users.map((u) => u.name)).toEqual(["Amy", "Zoe"]);
  });
});
