import { describe, expect, it } from "vitest";
import {
  aggregateClubUsers,
  collectClubUserIds,
  type ClubUserMembership,
  type ClubUserPlan,
  type ClubUserWaiver,
} from "./club-users";

const plans: ClubUserPlan[] = [
  { id: "plan-trial", name: "Free trial", kind: "trial" },
  { id: "plan-sem", name: "One semester", kind: "period" },
];

function waiver(over: Partial<ClubUserWaiver> = {}): ClubUserWaiver {
  return {
    user_id: "u1",
    full_name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "0400 000 000",
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

describe("collectClubUserIds", () => {
  it("unions waiver signers and membership holders, dropping nulls and dupes", () => {
    const ids = collectClubUserIds(
      [{ user_id: "a" }, { user_id: null }, { user_id: "b" }],
      [{ user_id: "b" }, { user_id: "c" }, { user_id: null }],
    );
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("aggregateClubUsers", () => {
  it("returns one row per person from the union of waivers and memberships", () => {
    const users = aggregateClubUsers({
      waivers: [waiver({ user_id: "u1" })],
      memberships: [membership({ user_id: "u2" })],
      plans,
      roles: [],
    });
    expect(users.map((u) => u.user_id).sort()).toEqual(["u1", "u2"]);
  });

  it("resolves name, email and phone from the latest waiver", () => {
    const users = aggregateClubUsers({
      waivers: [
        waiver({ full_name: "Old Name", phone: "111", signed_at: "2026-01-01T00:00:00Z" }),
        waiver({ full_name: "New Name", phone: "222", signed_at: "2026-03-01T00:00:00Z" }),
      ],
      memberships: [],
      plans,
      roles: [],
    });
    expect(users[0].name).toBe("New Name");
    expect(users[0].phone).toBe("222");
    expect(users[0].has_waiver).toBe(true);
    expect(users[0].waiver_signed_at).toBe("2026-03-01T00:00:00Z");
  });

  it("leaves name/email/phone null for a membership holder with no waiver", () => {
    const users = aggregateClubUsers({
      waivers: [],
      memberships: [membership({ user_id: "u9" })],
      plans,
      roles: [],
    });
    expect(users[0].name).toBeNull();
    expect(users[0].email).toBeNull();
    expect(users[0].phone).toBeNull();
    expect(users[0].has_waiver).toBe(false);
  });

  it("derives lifecycle status from waiver + memberships", () => {
    const [member] = aggregateClubUsers({
      waivers: [waiver()],
      memberships: [membership({ status: "active", plan_id: "plan-sem" })],
      plans,
      roles: [],
    });
    expect(member.lifecycle_status).toBe("member");

    const [prospect] = aggregateClubUsers({
      waivers: [],
      memberships: [membership({ status: "cancelled", plan_id: "plan-sem" })],
      plans,
      roles: [],
    });
    expect(prospect.lifecycle_status).toBe("expired");
  });

  it("prefers the waiver's student number over membership data", () => {
    const [u] = aggregateClubUsers({
      waivers: [waiver({ uts_student_number: "99999999" })],
      memberships: [membership({ is_student: true, uts_student_number: "11111111" })],
      plans,
      roles: [],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("99999999");
  });

  it("marks a UTS student from the waiver alone (trial signer, no membership)", () => {
    const [u] = aggregateClubUsers({
      waivers: [waiver({ uts_student_number: "12345678" })],
      memberships: [],
      plans,
      roles: [],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("12345678");
  });

  it("marks a UTS student from a captured student number and surfaces it", () => {
    const [u] = aggregateClubUsers({
      waivers: [waiver()],
      memberships: [membership({ is_student: true, uts_student_number: "12345678" })],
      plans,
      roles: [],
    });
    expect(u.is_uts_student).toBe(true);
    expect(u.uts_student_number).toBe("12345678");
  });

  it("marks a UTS student on is_student even without a number, and non-students otherwise", () => {
    const [withFlag] = aggregateClubUsers({
      waivers: [waiver()],
      memberships: [membership({ is_student: true, uts_student_number: "   " })],
      plans,
      roles: [],
    });
    expect(withFlag.is_uts_student).toBe(true);
    expect(withFlag.uts_student_number).toBeNull();

    const [nonStudent] = aggregateClubUsers({
      waivers: [waiver()],
      memberships: [membership({ is_student: false, uts_student_number: null })],
      plans,
      roles: [],
    });
    expect(nonStudent.is_uts_student).toBe(false);
  });

  it("summarises the latest membership by created_at", () => {
    const [u] = aggregateClubUsers({
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

  it("computes first-seen as the earliest waiver or membership date", () => {
    const [u] = aggregateClubUsers({
      waivers: [waiver({ signed_at: "2026-03-01T00:00:00Z" })],
      memberships: [membership({ created_at: "2026-01-15T00:00:00Z" })],
      plans,
      roles: [],
    });
    expect(u.first_seen_at).toBe("2026-01-15T00:00:00Z");
  });

  it("attaches roles per user", () => {
    const users = aggregateClubUsers({
      waivers: [waiver({ user_id: "u1" }), waiver({ user_id: "u2", full_name: "Bob" })],
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
      waivers: [
        waiver({ user_id: "u1", full_name: "Zoe" }),
        waiver({ user_id: "u2", full_name: "Amy" }),
      ],
      memberships: [],
      plans,
      roles: [],
    });
    expect(users.map((u) => u.name)).toEqual(["Amy", "Zoe"]);
  });
});
