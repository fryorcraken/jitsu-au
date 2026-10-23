import { describe, expect, it } from "vitest";

import {
  announceConfirmTitle,
  announcedLine,
  announcementAudience,
  announcementBody,
  announcementSummaries,
  announcementTitle,
  forWhomText,
  formatPlanDate,
  planAnnouncementHref,
  planIdFromAnnouncementHref,
  planNeedsInsurance,
  planPriceText,
  planRunsText,
  uninsuredNames,
  type AnnouncedPlan,
  type AudiencePerson,
} from "./plan-announcement";

const PARENT = "00000000-0000-4000-8000-000000000001";
const CHILD_A = "00000000-0000-4000-8000-000000000002";
const CHILD_B = "00000000-0000-4000-8000-000000000003";
const ADULT = "00000000-0000-4000-8000-000000000004";
const APPLICANT = "00000000-0000-4000-8000-000000000005";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";

const person = (
  user_id: string,
  first_name: string,
  guardian_user_id: string | null = null,
): AudiencePerson => ({ user_id, guardian_user_id, first_name, last_name: "Example" });

const PEOPLE = [
  person(PARENT, "Ada"),
  person(CHILD_A, "Cy", PARENT),
  person(CHILD_B, "Bea", PARENT),
  person(ADULT, "Eve"),
  person(APPLICANT, "Sam"),
];

const PLAN: AnnouncedPlan = {
  id: PLAN_ID,
  name: "Semester 1 2027",
  description: null,
  kind: "period",
  public_price_cents: 44500,
  student_price_cents: 24500,
  starts_on: "2027-03-01",
  ends_on: "2027-06-30",
  duration_days: null,
  session_credits: null,
};

describe("announcementAudience", () => {
  it("is everyone with an approved waiver, one entry per inbox", () => {
    const inboxes = announcementAudience({
      people: PEOPLE,
      approvedUserIds: [PARENT, CHILD_A, CHILD_B, ADULT],
    });
    expect(inboxes.map((i) => i.contactUserId)).toEqual([PARENT, ADULT]);
  });

  // An applicant's login is still locked, and the email links to a signed-in
  // page. A lead never reaches this list at all: they have no person record.
  it("leaves out an applicant whose waiver is still waiting", () => {
    const inboxes = announcementAudience({ people: PEOPLE, approvedUserIds: [ADULT] });
    expect(inboxes.map((i) => i.contactUserId)).toEqual([ADULT]);
  });

  it("leaves out an approval with no person record behind it", () => {
    const stray = "00000000-0000-4000-8000-0000000000ff";
    expect(announcementAudience({ people: PEOPLE, approvedUserIds: [stray] })).toEqual([]);
  });

  // One family, one email: the children fold into the parent's inbox, named.
  it("folds a household into the parent's inbox and names the children in order", () => {
    const [inbox] = announcementAudience({
      people: PEOPLE,
      approvedUserIds: [PARENT, CHILD_A, CHILD_B],
    });
    expect(inbox).toEqual({
      contactUserId: PARENT,
      includesSelf: true,
      dependants: [
        { userId: CHILD_B, name: "Bea" },
        { userId: CHILD_A, name: "Cy" },
      ],
    });
  });

  // A parent who does not train is still where their children's mail goes.
  it("reaches a parent who is not active themselves, for their active children", () => {
    const [inbox] = announcementAudience({ people: PEOPLE, approvedUserIds: [CHILD_A] });
    expect(inbox).toEqual({
      contactUserId: PARENT,
      includesSelf: false,
      dependants: [{ userId: CHILD_A, name: "Cy" }],
    });
  });

  it("counts a person approved twice once", () => {
    const inboxes = announcementAudience({ people: PEOPLE, approvedUserIds: [ADULT, ADULT] });
    expect(inboxes).toHaveLength(1);
  });
});

describe("what the email says", () => {
  it("states both rates where there is a student price", () => {
    expect(planPriceText(PLAN)).toBe("$445, or $245 for UTS students");
    expect(planPriceText({ public_price_cents: 2000, student_price_cents: null })).toBe("$20");
    expect(planPriceText({ public_price_cents: 2000, student_price_cents: 2000 })).toBe("$20");
  });

  it("says when each kind of plan runs", () => {
    expect(planRunsText(PLAN)).toBe("1 Mar 2027 to 30 Jun 2027");
    expect(planRunsText({ ...PLAN, starts_on: null, ends_on: null, duration_days: 365 })).toBe(
      "365 days from the day it starts",
    );
    expect(planRunsText({ ...PLAN, starts_on: null, ends_on: null, session_credits: 1 })).toBe(
      "One class",
    );
    expect(
      planRunsText({ ...PLAN, starts_on: null, ends_on: null, session_credits: null }),
    ).toBeNull();
  });

  it("formats a date without a timezone shift", () => {
    expect(formatPlanDate("2027-03-01")).toBe("1 Mar 2027");
    expect(formatPlanDate("2026-11-03", { year: false })).toBe("3 Nov");
  });

  it("names who it is for", () => {
    const [family] = announcementAudience({
      people: PEOPLE,
      approvedUserIds: [PARENT, CHILD_A, CHILD_B],
    });
    expect(forWhomText(family)).toBe("you, Bea and Cy");
    expect(announcementBody(PLAN, family)).toBe(
      "1 Mar 2027 to 30 Jun 2027. $445, or $245 for UTS students. For you, Bea and Cy.",
    );
    const [adult] = announcementAudience({ people: PEOPLE, approvedUserIds: [ADULT] });
    expect(announcementBody(PLAN, adult)).toBe(
      "1 Mar 2027 to 30 Jun 2027. $445, or $245 for UTS students.",
    );
    expect(announcementTitle(PLAN)).toBe("Membership: Semester 1 2027");
  });

  it("names only the people in the inbox who have no insurance cover", () => {
    const [family] = announcementAudience({
      people: PEOPLE,
      approvedUserIds: [PARENT, CHILD_A, CHILD_B],
    });
    const covered = new Set([CHILD_A]);
    expect(uninsuredNames(family, { insuranceRequired: true, coveredUserIds: covered })).toEqual([
      "you",
      "Bea",
    ]);
    expect(uninsuredNames(family, { insuranceRequired: false, coveredUserIds: covered })).toEqual(
      [],
    );
  });

  it("never asks for insurance on the trial or on the insurance plan itself", () => {
    expect(planNeedsInsurance("trial")).toBe(false);
    expect(planNeedsInsurance("insurance")).toBe(false);
    expect(planNeedsInsurance("period")).toBe(true);
    expect(planNeedsInsurance("session")).toBe(true);
  });

  // Copy rule from AGENTS.md: no em dashes in anything a person reads.
  it("uses no em dash", () => {
    const [family] = announcementAudience({ people: PEOPLE, approvedUserIds: [PARENT, CHILD_A] });
    for (const copy of [
      announcementBody(PLAN, family),
      announcementTitle(PLAN),
      announceConfirmTitle(PLAN.name, 84),
    ])
      expect(copy).not.toContain("—");
  });
});

describe("the plan link", () => {
  it("round-trips the plan id", () => {
    const href = planAnnouncementHref(PLAN_ID);
    expect(href).toBe(`/membership#plan-${PLAN_ID}`);
    expect(planIdFromAnnouncementHref(href)).toBe(PLAN_ID);
    expect(planIdFromAnnouncementHref("/blog/a-post")).toBeNull();
  });
});

describe("announcementSummaries", () => {
  const OTHER_PLAN = "22222222-2222-4222-8222-222222222222";
  const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const row = (subject_id: string, planId: string, created_at: string, emailed = true) => ({
    subject_id,
    href: planAnnouncementHref(planId),
    created_at,
    emailed_at: emailed ? created_at : null,
  });

  it("reports each plan's latest announcement and how many there have been", () => {
    const out = announcementSummaries([
      row(FIRST, PLAN_ID, "2026-11-03T01:00:00.000Z"),
      row(FIRST, PLAN_ID, "2026-11-03T01:00:01.000Z"),
      row(SECOND, PLAN_ID, "2026-12-01T01:00:00.000Z"),
      row(SECOND, PLAN_ID, "2026-12-01T01:00:00.000Z", false),
      row(SECOND, PLAN_ID, "2026-12-01T01:00:02.000Z"),
    ]);
    expect(out.get(PLAN_ID)).toEqual({
      announcement_id: SECOND,
      announced_at: "2026-12-01T01:00:00.000Z",
      recipients: 3,
      emailed: 2,
      times: 2,
    });
    expect(out.has(OTHER_PLAN)).toBe(false);
  });

  it("reads the announced line the way a manager would say it", () => {
    const once = {
      announcement_id: FIRST,
      announced_at: "x",
      recipients: 84,
      emailed: 84,
      times: 1,
    };
    expect(announcedLine(once, "2026-11-03")).toBe("Announced on 3 Nov to 84 people.");
    expect(announcedLine({ ...once, recipients: 1, emailed: 1 }, "2026-11-03")).toBe(
      "Announced on 3 Nov to 1 person.",
    );
    expect(announcedLine({ ...once, times: 2, emailed: 80 }, "2026-11-03")).toBe(
      "Last announced on 3 Nov to 84 people. 4 of those emails have not gone out yet, and will go with the next morning's summary.",
    );
  });

  it("asks the confirm with the real number", () => {
    expect(announceConfirmTitle("Semester 1 2027", 84)).toBe(
      "Save and email 84 people about Semester 1 2027?",
    );
    expect(announceConfirmTitle("Semester 1 2027", 1)).toBe(
      "Save and email 1 person about Semester 1 2027?",
    );
  });
});
