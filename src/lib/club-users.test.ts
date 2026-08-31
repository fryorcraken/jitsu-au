import { describe, expect, it } from "vitest";
import {
  aggregateClubUsers,
  personLabelsById,
  profileUserIds,
  type ClubUserEmail,
  type ClubUserLead,
  type ClubUserMembership,
  type ClubUserPlan,
  type ClubUserProfile,
  type ClubUserWaiver,
  type PersonNameRow,
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
    preferred_name: null,
    phone: "0400 000 000",
    uts_student_number: null,
    gi_size: null,
    belt_size: null,
    guardian_user_id: null,
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
    sessions_remaining: null,
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

describe("personLabelsById", () => {
  function nameRow(over: Partial<PersonNameRow> = {}): PersonNameRow {
    return {
      user_id: "m1",
      first_name: "Grace",
      middle_name: null,
      last_name: "Hopper",
      preferred_name: null,
      ...over,
    };
  }

  it("labels a person by their name when they have a profile", () => {
    const labels = personLabelsById({
      profiles: [nameRow()],
      emails: [{ user_id: "m1", email: "grace@example.com" }],
    });
    expect(labels.get("m1")).toBe("Grace Hopper");
  });

  it("quotes in a preferred name, like every other screen", () => {
    const labels = personLabelsById({
      profiles: [nameRow({ preferred_name: "Amazing" })],
      emails: [],
    });
    expect(labels.get("m1")).toBe('Grace "Amazing" Hopper');
  });

  it("falls back to the login address for a manager with no profile row", () => {
    const labels = personLabelsById({
      profiles: [],
      emails: [{ user_id: "m1", email: "grace@example.com" }],
    });
    expect(labels.get("m1")).toBe("grace@example.com");
  });

  it("falls back to the email when the profile has no name at all", () => {
    const labels = personLabelsById({
      profiles: [nameRow({ first_name: null, last_name: null })],
      emails: [{ user_id: "m1", email: "grace@example.com" }],
    });
    expect(labels.get("m1")).toBe("grace@example.com");
  });

  it("omits anyone who resolves to neither a name nor an email", () => {
    const labels = personLabelsById({
      profiles: [nameRow({ first_name: null, last_name: null })],
      emails: [{ user_id: "m1", email: "   " }],
    });
    expect(labels.has("m1")).toBe(false);
  });

  it("labels each id independently", () => {
    const labels = personLabelsById({
      profiles: [nameRow({ user_id: "m2", first_name: "Ada", last_name: "Lovelace" })],
      emails: [
        { user_id: "m1", email: "grace@example.com" },
        { user_id: "m2", email: "ada@example.com" },
      ],
    });
    expect([...labels.entries()].sort()).toEqual([
      ["m1", "grace@example.com"],
      ["m2", "Ada Lovelace"],
    ]);
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

  it("carries kit sizes through to the row, and leaves a lead's empty", () => {
    const users = aggregate({
      profiles: [profile({ user_id: "u1", gi_size: "4", belt_size: "3" })],
      leads: [lead()],
    });
    const person = users.find((u) => u.user_id === "u1")!;
    expect(person.gi_size).toBe("4");
    expect(person.belt_size).toBe("3");
    // A lead has given us an email and nothing else, so there is no profile to
    // hold a size and nothing to show but a blank.
    const l = users.find((u) => u.user_id === null)!;
    expect(l.gi_size).toBeNull();
    expect(l.belt_size).toBeNull();
  });

  it("carries the email confirmation stamp through to the row", () => {
    const [u] = aggregate({
      profiles: [profile({ user_id: "u1" })],
      emails: [
        { user_id: "u1", email: "ada@example.com", email_confirmed_at: "2026-02-02T00:00:00Z" },
      ],
    });
    expect(u.email_confirmed_at).toBe("2026-02-02T00:00:00Z");
  });

  it("reports an unproven address as null rather than guessing", () => {
    const [u] = aggregate({
      profiles: [profile({ user_id: "u1" })],
      emails: [{ user_id: "u1", email: "ada@example.com" }],
    });
    expect(u.email_confirmed_at).toBeNull();
  });

  it("surfaces the preferred name in both the list name and the greeting name", () => {
    const [u] = aggregate({
      profiles: [profile({ first_name: "Ada", last_name: "Lovelace", preferred_name: "Addy" })],
    });
    // Managers see who they are AND what to call them; the greeting name is
    // what transactional emails address them by.
    expect(u.name).toBe('Ada "Addy" Lovelace');
    expect(u.greeting_name).toBe("Addy");
  });

  it("falls back to the plain full name and first name with no preferred name", () => {
    const [u] = aggregate({
      profiles: [profile({ first_name: "Ada", last_name: "Lovelace", preferred_name: null })],
    });
    expect(u.name).toBe("Ada Lovelace");
    expect(u.greeting_name).toBe("Ada");
  });

  it("leaves a lead without a greeting name (no person record yet)", () => {
    const users = aggregate({ profiles: [], emails: [], leads: [lead()] });
    expect(users[0].greeting_name).toBeNull();
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
    // A lead has no person record, so there is nothing to have confirmed. Any
    // proof they gave by clicking their interest email is held on the token
    // until they sign a waiver and a person exists to carry it.
    expect(l.email_confirmed_at).toBeNull();
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
    expect(u.latest_plan_kind).toBe("period");
    expect(u.latest_membership_status).toBe("active");
    expect(u.membership_count).toBe(2);
  });

  it("carries the latest plan's kind, which is what names its status on screen", () => {
    // A used-up trial and a finished semester are both stored as `expired`. The
    // kind is the only thing that tells the users list which word to print, and
    // it separates "they came twice and stopped" from "the semester ended".
    const [trialOnly] = aggregate({
      profiles: [profile()],
      waivers: [waiver()],
      memberships: [
        membership({
          plan_id: "plan-trial",
          price_cents: 0,
          status: "expired",
          sessions_remaining: 0,
        }),
      ],
    });
    expect(trialOnly.lifecycle_status).toBe("lapsed");
    expect(trialOnly.latest_plan_kind).toBe("trial");
    // The balance rides along with the kind: an ended credit plan only reads as
    // "used up" once its classes are actually gone, and a refunded check-in can
    // leave one `expired` with a class still on it.
    expect(trialOnly.latest_sessions_remaining).toBe(0);

    // A lead has no memberships at all, so there is no kind to report.
    const [aLead] = aggregate({ profiles: [], emails: [], leads: [lead()] });
    expect(aLead.latest_plan_kind).toBeNull();
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

  it("counts the classes each person has attended", () => {
    const users = aggregate({
      profiles: [profile({ user_id: "u1" }), profile({ user_id: "u2", first_name: "Bob" })],
      checkins: [{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }],
    });
    expect(users.find((u) => u.user_id === "u1")!.sessions_attended).toBe(2);
    expect(users.find((u) => u.user_id === "u2")!.sessions_attended).toBe(1);
  });

  it("reports nobody as having attended when there are no check-ins", () => {
    const users = aggregate({ profiles: [profile()] });
    expect(users[0].sessions_attended).toBe(0);
  });

  it("ignores a check-in for someone who is not a person here, and never counts a lead", () => {
    const users = aggregate({
      profiles: [profile({ user_id: "u1" })],
      leads: [lead({ name: "Amy Lead", email: "amy@example.com" })],
      checkins: [{ user_id: "u1" }, { user_id: "ghost" }],
    });
    expect(users.find((u) => u.user_id === "u1")!.sessions_attended).toBe(1);
    expect(users.find((u) => u.user_id === null)!.sessions_attended).toBe(0);
  });

  it("sorts persons and leads together by name A-Z", () => {
    const users = aggregate({
      profiles: [profile({ user_id: "u1", first_name: "Zoe", last_name: null })],
      leads: [lead({ name: "Amy Lead" })],
    });
    expect(users.map((u) => u.name)).toEqual(["Amy Lead", "Zoe"]);
  });
});

describe("aggregateClubUsers, for a dependant", () => {
  // What a manager reads on a child's row. A dependant's own login carries a
  // reserved, non-deliverable address that identifies nobody, so the address
  // shown has to be their guardian's -- and it has to SAY so, or the row reads
  // as a nine-year-old with a mailbox somebody can write to.
  const PARENT = profile({ user_id: "parent", first_name: "Ada", last_name: "Lovelace" });
  const CHILD = profile({
    user_id: "child",
    first_name: "Bea",
    last_name: "Lovelace",
    guardian_user_id: "parent",
  });
  const emails = [
    { user_id: "parent", email: "ada@example.com", email_confirmed_at: "2026-08-01T00:00:00Z" },
  ];
  const base = { waivers: [], memberships: [], plans, roles: [], leads: [] };

  it("shows the guardian's address on a child's row, and whose it is", () => {
    const [parent, child] = aggregateClubUsers({ profiles: [PARENT, CHILD], emails, ...base });

    expect(child.email).toBe("ada@example.com");
    expect(child.email_belongs_to).toBe("Ada Lovelace");

    // The guardian's own row is unchanged: their address is their own, and
    // captioning it would be noise on almost every row in the directory.
    expect(parent.email).toBe("ada@example.com");
    expect(parent.email_belongs_to).toBeNull();
  });

  it("badges the guardian's confirmation state on the child's row", () => {
    // Confirmation is a fact about the ADDRESS. The guardian is who proved they
    // can read that mailbox, so that is the honest thing to badge; reading the
    // child's own would badge a reserved address nobody ever confirmed.
    const [, child] = aggregateClubUsers({ profiles: [PARENT, CHILD], emails, ...base });
    expect(child.email_confirmed_at).toBe("2026-08-01T00:00:00Z");
  });

  it("resolves the guardian even when they are not one of the people listed", () => {
    // The single-person page (`getClubUser`) reads one person. If that person
    // is a dependant their guardian is not in `profiles` at all, so it passes
    // them separately rather than showing a child with no contact address.
    const [child] = aggregateClubUsers({
      profiles: [CHILD],
      guardians: [PARENT],
      emails,
      ...base,
    });
    expect(child.email).toBe("ada@example.com");
    expect(child.email_belongs_to).toBe("Ada Lovelace");
  });

  it("shows no address rather than the reserved one when the guardian cannot be resolved", () => {
    // Never a fallback to the person's own address. That address is the
    // reserved string, and printing it is the one thing this must not do.
    const [child] = aggregateClubUsers({ profiles: [CHILD], emails: [], ...base });
    expect(child.email).toBeNull();
  });
});

describe("aggregateClubUsers, when the guardian's name is what a screen prints", () => {
  // `email_belongs_to` is what the manager directory and person page render
  // beside a dependant's address. Computed and never read, it would leave both
  // screens showing a guardian's address uncaptioned, which is the exact
  // reading #106 forbids.
  it("carries the guardian's name for a screen to print", () => {
    const parent = profile({ user_id: "parent", first_name: "Ada", last_name: "Lovelace" });
    const child = profile({
      user_id: "child",
      first_name: "Bea",
      last_name: "Lovelace",
      guardian_user_id: "parent",
    });
    const [, dependant] = aggregateClubUsers({
      profiles: [parent, child],
      emails: [{ user_id: "parent", email: "ada@example.com", email_confirmed_at: null }],
      waivers: [],
      memberships: [],
      plans,
      roles: [],
      leads: [],
    });
    expect(dependant.email_belongs_to).toBe("Ada Lovelace");
  });
});
