import { describe, expect, it } from "vitest";
import {
  aggregateClubUsers,
  profileUserIds,
  type ClubUserEmail,
  type ClubUserLead,
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
    user_id: "u1",
    first_name: "Ada",
    middle_name: null,
    last_name: "Lovelace",
    phone: "0400 000 000",
    uts_student_number: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const emails: ClubUserEmail[] = [
  { user_id: "u1", email: "ada@example.com" },
  { user_id: "u2", email: "bob@example.com" },
];

function waiver(over: Partial<ClubUserWaiver> = {}): ClubUserWaiver {
  return {
    user_id: "u1",
    signed_at: "2026-01-01T00:00:00Z",
    approval_status: "approved",
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

function lead(over: Partial<ClubUserLead> = {}): ClubUserLead {
  return {
    email: "lead@example.com",
    name: "Lena Lead",
    phone: "0400 999 999",
    created_at: "2026-01-05T00:00:00Z",
    ...over,
  };
}

type AggregateInput = Parameters<typeof aggregateClubUsers>[0];

function aggregate(over: Partial<AggregateInput>) {
  return aggregateClubUsers({
    profiles: [],
    emails,
    waivers: [],
    memberships: [],
    plans,
    roles: [],
    leads: [],
    ...over,
  });
}

describe("profileUserIds", () => {
  it("collects distinct user ids", () => {
    const ids = profileUserIds([{ user_id: "a" }, { user_id: "b" }, { user_id: "a" }]);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});

describe("aggregateClubUsers", () => {
  it("returns one row per profile", () => {
    const users = aggregate({
      profiles: [
        profile({ user_id: "u1" }),
        profile({ user_id: "u2", first_name: "Bob", last_name: null }),
      ],
      memberships: [membership({ user_id: "u2" })],
    });
    expect(users.map((u) => u.user_id).sort()).toEqual(["u1", "u2"]);
  });

  it("resolves name/phone from the profile and email from the auth lookup", () => {
    const [u] = aggregate({
      profiles: [profile({ first_name: "Ada", last_name: "Lovelace", phone: "222" })],
    });
    expect(u.name).toBe("Ada Lovelace");
    expect(u.email).toBe("ada@example.com");
    expect(u.phone).toBe("222");
  });

  it("derives the funnel phases", () => {
    const cases: [ClubUserWaiver[], ClubUserMembership[], string][] = [
      // Bare profile, nothing else -> lead.
      [[], [], "lead"],
      // Pending submission only -> applicant.
      [[waiver({ approval_status: "pending" })], [], "applicant"],
      // Approved waiver (+ active trial) -> visitor.
      [[waiver()], [], "visitor"],
      [[waiver()], [membership({ plan_id: "plan-trial", price_cents: 0 })], "visitor"],
      // Active paid membership -> member.
      [[waiver()], [membership()], "member"],
      // Ended trial/membership, nothing active -> lapsed.
      [
        [waiver()],
        [membership({ plan_id: "plan-trial", price_cents: 0, status: "expired" })],
        "lapsed",
      ],
      [[waiver()], [membership({ status: "cancelled" })], "lapsed"],
    ];
    for (const [waivers, memberships, expected] of cases) {
      const [u] = aggregate({ profiles: [profile()], waivers, memberships });
      expect(u.lifecycle_status).toBe(expected);
    }
  });

  it("marks has_waiver only for approved waivers, tracking the latest approved date", () => {
    const [pendingOnly] = aggregate({
      profiles: [profile()],
      waivers: [waiver({ approval_status: "pending" })],
    });
    expect(pendingOnly.has_waiver).toBe(false);
    expect(pendingOnly.waiver_signed_at).toBeNull();

    const [approved] = aggregate({
      profiles: [profile()],
      waivers: [
        waiver({ signed_at: "2026-01-01T00:00:00Z" }),
        waiver({ signed_at: "2026-03-01T00:00:00Z" }),
        waiver({ signed_at: "2026-04-01T00:00:00Z", approval_status: "pending" }),
      ],
    });
    expect(approved.has_waiver).toBe(true);
    expect(approved.waiver_signed_at).toBe("2026-03-01T00:00:00Z");
  });

  it("appends leads with no person record as lifecycle lead", () => {
    const users = aggregate({ profiles: [profile()], leads: [lead()] });
    const l = users.find((u) => u.user_id === null)!;
    expect(l.lifecycle_status).toBe("lead");
    expect(l.name).toBe("Lena Lead");
    expect(l.email).toBe("lead@example.com");
    expect(l.phone).toBe("0400 999 999");
    expect(l.first_seen_at).toBe("2026-01-05T00:00:00Z");
  });

  it("drops a lead whose email already belongs to a person (case-insensitive)", () => {
    const users = aggregate({
      profiles: [profile()],
      leads: [lead({ email: "Ada@Example.com" })],
    });
    expect(users).toHaveLength(1);
    expect(users[0].user_id).toBe("u1");
  });

  it("dedupes leads by email, keeping the latest registration", () => {
    const users = aggregate({
      leads: [
        lead({ name: "Old Name", created_at: "2026-01-01T00:00:00Z" }),
        lead({ name: "New Name", created_at: "2026-02-01T00:00:00Z" }),
      ],
    });
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("New Name");
  });

  it("prefers the profile's student number over membership data", () => {
    const [u] = aggregate({
      profiles: [profile({ uts_student_number: "99999999" })],
      memberships: [membership({ is_student: true, uts_student_number: "11111111" })],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("99999999");
  });

  it("marks a UTS student from a membership number when the profile has none", () => {
    const [u] = aggregate({
      profiles: [profile({ uts_student_number: null })],
      memberships: [membership({ is_student: true, uts_student_number: "12345678" })],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("12345678");
  });

  it("summarises the latest membership by created_at", () => {
    const [u] = aggregate({
      profiles: [profile()],
      waivers: [waiver()],
      memberships: [
        membership({
          plan_id: "plan-trial",
          price_cents: 0,
          status: "expired",
          created_at: "2026-01-10T00:00:00Z",
        }),
        membership({ plan_id: "plan-sem", status: "active", created_at: "2026-05-10T00:00:00Z" }),
      ],
    });
    expect(u.latest_plan_name).toBe("One semester");
    expect(u.latest_membership_status).toBe("active");
    expect(u.membership_count).toBe(2);
  });

  it("computes first-seen as the earliest of profile, waiver and membership dates", () => {
    const [u] = aggregate({
      profiles: [profile({ created_at: "2026-02-01T00:00:00Z" })],
      waivers: [waiver({ signed_at: "2026-03-01T00:00:00Z" })],
      memberships: [membership({ created_at: "2026-01-15T00:00:00Z" })],
    });
    expect(u.first_seen_at).toBe("2026-01-15T00:00:00Z");
  });

  it("attaches roles per user", () => {
    const users = aggregate({
      profiles: [
        profile({ user_id: "u1", first_name: "Ada", last_name: "Lovelace" }),
        profile({ user_id: "u2", first_name: "Bob", last_name: null }),
      ],
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

  it("sorts persons and leads together by name A-Z", () => {
    const users = aggregate({
      profiles: [profile({ user_id: "u1", first_name: "Zoe", last_name: null })],
      leads: [lead({ name: "Amy Lead" })],
    });
    expect(users.map((u) => u.name)).toEqual(["Amy Lead", "Zoe"]);
  });
});
