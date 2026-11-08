import { describe, expect, it } from "vitest";

import {
  LEAD_PRESELECT_DAYS,
  choiceFromTicks,
  clubMessageHref,
  groupForStatus,
  groupPeople,
  leadCandidates,
  messageAudience,
  messageProgress,
  peopleCount,
  plainExcerpt,
  sendConfirmTitle,
  type LeadRegistration,
  type MessagePerson,
} from "./club-message";

const PARENT = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";
const APPLICANT = "00000000-0000-4000-8000-000000000004";
const LAPSED = "00000000-0000-4000-8000-000000000005";
const ARCHIVED = "00000000-0000-4000-8000-000000000006";

function person(
  user_id: string,
  lifecycle_status: MessagePerson["lifecycle_status"],
  extra: Partial<MessagePerson> = {},
): MessagePerson {
  return {
    user_id,
    guardian_user_id: null,
    name: user_id.slice(-1),
    lifecycle_status,
    archived: false,
    ...extra,
  };
}

describe("groupForStatus", () => {
  it("keeps lapsed members apart from visitors, and reaches no lead", () => {
    expect(groupForStatus("member")).toBe("members");
    expect(groupForStatus("visitor")).toBe("visitors");
    expect(groupForStatus("lapsed")).toBe("lapsed");
    expect(groupForStatus("applicant")).toBe("applicants");
    expect(groupForStatus("lead")).toBeNull();
  });
});

describe("messageAudience", () => {
  const people = [
    // A parent who is only a lead-shaped account holder, with a member child.
    person(PARENT, "lead", { name: "Pat" }),
    person(CHILD, "member", { guardian_user_id: PARENT, name: "Bea" }),
    person(MEMBER, "member"),
    person(APPLICANT, "applicant"),
    person(LAPSED, "lapsed"),
    person(ARCHIVED, "member", { archived: true }),
  ];

  it("reaches only the ticked groups", () => {
    const inboxes = messageAudience({ people, groups: ["applicants"] });
    expect(inboxes.map((i) => i.contactUserId)).toEqual([APPLICANT]);
  });

  it("sends a child's email to the parent, naming the child", () => {
    const inboxes = messageAudience({ people, groups: ["members"] });
    const family = inboxes.find((i) => i.contactUserId === PARENT);
    expect(family).toEqual({
      contactUserId: PARENT,
      includesSelf: false,
      dependants: [{ userId: CHILD, name: "Bea" }],
    });
  });

  it("never includes somebody who has left the club", () => {
    const inboxes = messageAudience({
      people,
      groups: ["members", "visitors", "lapsed", "applicants"],
    });
    expect(inboxes.map((i) => i.contactUserId)).not.toContain(ARCHIVED);
    expect(inboxes).toHaveLength(4);
  });

  it("reaches a person ticked one by one without their whole group", () => {
    const inboxes = messageAudience({ people, groups: [], personIds: [LAPSED.toUpperCase()] });
    expect(inboxes.map((i) => i.contactUserId)).toEqual([LAPSED]);
  });

  it("never reaches somebody who has left, even ticked one by one", () => {
    expect(messageAudience({ people, groups: [], personIds: [ARCHIVED] })).toEqual([]);
  });

  it("does not reach a lead by naming their id", () => {
    // PARENT is lead-shaped in this fixture: no group reaches them.
    expect(messageAudience({ people, groups: [], personIds: [PARENT] })).toEqual([]);
  });

  it("sends nothing to a family whose account holder has left", () => {
    const gone = people.map((p) => (p.user_id === PARENT ? { ...p, archived: true } : p));
    const inboxes = messageAudience({ people: gone, groups: ["members"] });
    expect(inboxes.map((i) => i.contactUserId)).toEqual([MEMBER]);
  });

  it("counts a household once however many of it are ticked", () => {
    const both = [
      person(PARENT, "member", { name: "Pat" }),
      person(CHILD, "member", { guardian_user_id: PARENT, name: "Bea" }),
    ];
    const inboxes = messageAudience({ people: both, groups: ["members"] });
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0].includesSelf).toBe(true);
  });

  it("is empty when nothing is ticked", () => {
    expect(messageAudience({ people, groups: [] })).toEqual([]);
  });
});

describe("groupPeople", () => {
  const people = [
    person(PARENT, "lead", { name: "Pat" }),
    person(CHILD, "member", { guardian_user_id: PARENT, name: "Bea" }),
    person(MEMBER, "member", { name: "Mo" }),
    person(LAPSED, "lapsed", { name: "Lu" }),
    person(ARCHIVED, "member", { archived: true, name: "Gone" }),
  ];

  it("lists everybody a group reaches, by name, and says whose inbox a child's goes to", () => {
    expect(groupPeople(people)).toEqual([
      { user_id: CHILD, name: "Bea", group: "members", inbox_user_id: PARENT, inbox_name: "Pat" },
      { user_id: LAPSED, name: "Lu", group: "lapsed", inbox_user_id: LAPSED, inbox_name: null },
      { user_id: MEMBER, name: "Mo", group: "members", inbox_user_id: MEMBER, inbox_name: null },
    ]);
  });
});

describe("choiceFromTicks", () => {
  const listed = [
    { user_id: "a", name: "A", group: "members" as const, inbox_user_id: "a", inbox_name: null },
    { user_id: "b", name: "B", group: "members" as const, inbox_user_id: "b", inbox_name: null },
    { user_id: "c", name: "C", group: "lapsed" as const, inbox_user_id: "c", inbox_name: null },
    { user_id: "d", name: "D", group: "visitors" as const, inbox_user_id: "d", inbox_name: null },
  ];

  it("sends a fully ticked group as the group, and a partly ticked one as its people", () => {
    expect(choiceFromTicks(listed, new Set(["a", "b", "c"]))).toEqual({
      groups: ["members", "lapsed"],
      person_ids: [],
    });
    expect(choiceFromTicks(listed, new Set(["a", "c"]))).toEqual({
      groups: ["lapsed"],
      person_ids: ["a"],
    });
  });

  it("sends nothing for a group nobody in it is ticked for", () => {
    expect(choiceFromTicks(listed, new Set())).toEqual({ groups: [], person_ids: [] });
  });
});

describe("leadCandidates", () => {
  const now = new Date("2026-11-08T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const reg = (id: string, email: string, created_at: string, extra = {}): LeadRegistration => ({
    id,
    name: `Lead ${id}`,
    email,
    created_at,
    source: "interest",
    promotion_consent: false,
    ...extra,
  });

  it("ticks leads from the last 90 days and leaves older ones unticked", () => {
    const out = leadCandidates({
      registrations: [
        reg("a", "new@example.com", daysAgo(10)),
        reg("b", "edge@example.com", daysAgo(LEAD_PRESELECT_DAYS - 1)),
        reg("c", "old@example.com", daysAgo(LEAD_PRESELECT_DAYS + 1)),
      ],
      personEmails: [],
      now,
    });
    expect(out.map((l) => [l.email, l.preselected])).toEqual([
      ["new@example.com", true],
      ["edge@example.com", true],
      ["old@example.com", false],
    ]);
  });

  it("folds repeat registrations into the newest, matching addresses loosely", () => {
    const out = leadCandidates({
      registrations: [
        reg("old", "Sam@Example.com", daysAgo(200)),
        reg("new", "sam@example.com ", daysAgo(5)),
      ],
      personEmails: [],
      now,
    });
    expect(out).toHaveLength(1);
    expect(out[0].registration_id).toBe("new");
    expect(out[0].preselected).toBe(true);
  });

  it("leaves out an address that now belongs to a person", () => {
    const out = leadCandidates({
      registrations: [reg("a", "member@example.com", daysAgo(3))],
      personEmails: ["MEMBER@example.com"],
      now,
    });
    expect(out).toEqual([]);
  });

  it("makes a contact-form sender a lead, and folds both forms into one row", () => {
    const out = leadCandidates({
      registrations: [
        reg("i", "sam@example.com", daysAgo(40)),
        reg("c", "sam@example.com", daysAgo(2), { source: "contact" }),
        reg("x", "kim@example.com", daysAgo(200), { source: "contact" }),
      ],
      personEmails: [],
      now,
    });
    expect(
      out.map((l) => [l.email, l.registration_id, l.source, l.sources, l.preselected]),
    ).toEqual([
      ["sam@example.com", "c", "contact", ["interest", "contact"], true],
      ["kim@example.com", "x", "contact", ["contact"], false],
    ]);
  });

  it("keeps consent if any of their registrations ticked the box", () => {
    const out = leadCandidates({
      registrations: [
        reg("a", "sam@example.com", daysAgo(50), { promotion_consent: true }),
        reg("b", "sam@example.com", daysAgo(5)),
      ],
      personEmails: [],
      now,
    });
    expect(out[0].promotion_consent).toBe(true);
  });
});

describe("plainExcerpt", () => {
  it("drops markdown and keeps link words", () => {
    expect(plainExcerpt("**Closed** on the 24th. See [the calendar](https://x.test).")).toBe(
      "Closed on the 24th. See the calendar.",
    );
  });

  it("drops list and heading markers", () => {
    expect(plainExcerpt("## Changes\n\n- Tuesday 7pm\n- Thursday 6pm")).toBe(
      "Changes Tuesday 7pm Thursday 6pm",
    );
  });

  it("keeps underscores and stars that are not formatting", () => {
    expect(plainExcerpt("Email club_admin@example.com, room 5 * 3")).toBe(
      "Email club_admin@example.com, room 5 * 3",
    );
  });

  it("keeps underscores inside words, even two of them", () => {
    expect(plainExcerpt("Use club_room and side_door, _not_ the lift")).toBe(
      "Use club_room and side_door, not the lift",
    );
  });

  it("cuts long text at a word boundary", () => {
    const out = plainExcerpt("word ".repeat(100), 20);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(23);
  });
});

describe("wording", () => {
  it("says the real number in the confirm", () => {
    expect(sendConfirmTitle("Dojo closed", 1)).toBe('Email 1 person about "Dojo closed"?');
    expect(peopleCount(23)).toBe("23 people");
  });

  it("links the members' copy to its own page", () => {
    expect(clubMessageHref("ABC")).toBe("/messages/abc");
  });
});

describe("messageProgress", () => {
  it("adds people and leads together", () => {
    expect(
      messageProgress(
        [{ emailed_at: "x" }, { emailed_at: null }],
        [{ emailed_at: "x" }, { emailed_at: "y" }],
      ),
    ).toEqual({ recipients: 4, emailed: 3, pending: 1 });
  });
});
