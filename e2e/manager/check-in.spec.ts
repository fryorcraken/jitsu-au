// Check-in is what actually produces the "can't delete, a class was checked
// in against it" block, and it is where the free trial's two-session limit
// becomes visible. Both tests act on the seeded applicant, who is never
// signed in themselves (see applicantUserId in support/fixture.ts) — only
// ever the person a manager is checking in or fixing up.

import { expect, test } from "@playwright/test";

import { APPLICANT_EMAIL, adminClient, applicantUserId } from "../support/fixture";
import { expectPageRendered } from "../support/page";

let applicantId: string;

/** Membership rows this file arranges or raises, removed once in afterAll. */
const createdMembershipIds: string[] = [];
/** The seeded trial's original status/credits, restored once in afterAll. */
let originalTrial: { id: string; status: string; sessions_remaining: number | null } | null = null;

test.beforeAll(async () => {
  applicantId = await applicantUserId();
});

test.afterAll(async () => {
  // The applicant has no organic check-ins in the seeded club (see
  // scripts/seed-local-club.mjs), so every one of theirs belongs to this file
  // and can be cleared without tracking individual check-in ids.
  await adminClient().from("session_checkins").delete().eq("user_id", applicantId);
  if (createdMembershipIds.length > 0) {
    await adminClient().from("memberships").delete().in("id", createdMembershipIds);
  }
  if (originalTrial) {
    await adminClient()
      .from("memberships")
      .update({
        status: originalTrial.status,
        sessions_remaining: originalTrial.sessions_remaining,
      })
      .eq("id", originalTrial.id);
  }
});

/**
 * The five classes scripts/seed-local-club.mjs puts on the calendar, oldest
 * first. Read fresh each time rather than cached: the check-in screen tops up
 * the recurring series on every load, and while that only ever appends to the
 * future end, reading live is what makes that assumption safe to make once.
 *
 * The earliest one (day -14 from seed time) sits right at the check-in
 * screen's 14-day lookback edge, so a CI run that happens to straddle a UTC
 * midnight between seeding and a test using it could briefly push it outside
 * the window — a known, narrow residual risk this suite accepts rather than
 * arranging synthetic events to fully engineer away.
 */
async function seededClassEventIds(limit: number): Promise<string[]> {
  const { data, error } = await adminClient()
    .from("calendar_events")
    .select("id")
    .eq("title", "Tuesday class")
    .order("starts_at", { ascending: true })
    .limit(limit);
  if (error || !data || data.length < limit) {
    throw new Error(`fewer than ${limit} seeded classes to check the applicant in against`);
  }
  return data.map((e) => e.id);
}

test("a membership blocked from deletion by a check-in can be freed by moving it", async ({
  page,
}) => {
  // Membership A: arranged directly with wide-open dates, so it is the only
  // thing that can cover the class picked below regardless of when this runs
  // — this test is about the delete guard and the Move control, not about
  // coverage precedence.
  const { data: periodPlan } = await adminClient()
    .from("membership_plans")
    .select("id")
    .eq("kind", "period")
    .limit(1)
    .single();
  if (!periodPlan) throw new Error("no seeded period plan to arrange Membership A on");

  const referenceA = `E2E-CHECKIN-A-${crypto.randomUUID().slice(0, 8)}`;
  const { data: membershipA, error: aErr } = await adminClient()
    .from("memberships")
    .insert({
      user_id: applicantId,
      plan_id: periodPlan.id,
      status: "active",
      price_cents: 5000,
      payment_reference: referenceA,
      payment_method: "bank_transfer",
      starts_at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      ends_at: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (aErr || !membershipA) throw new Error(`could not arrange Membership A: ${aErr?.message}`);
  createdMembershipIds.push(membershipA.id);

  // The 4th-earliest seeded class: clear of the three the trial-exhaustion
  // test below uses, so the two tests never fight over one check-in row.
  const [, , , eventId] = await seededClassEventIds(4);

  await page.goto("/manager/check-in");
  await expectPageRendered(page);
  await page.locator("#class-picker").selectOption(eventId);
  await page.getByPlaceholder("Search by name or email").fill(APPLICANT_EMAIL);
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/are in/)).toBeVisible();

  await page.goto(`/manager/users/${applicantId}`);
  const rowA = page.getByRole("row").filter({ hasText: referenceA });
  const deleteA = rowA.getByRole("button", { name: "Delete" });
  await expect(deleteA).toBeDisabled();
  await expect(deleteA).toHaveAttribute("title", /a class was checked in against it/);
  // Attendance is not a reason to keep a membership open — only a payment is
  // (see the "Cancel vs Delete" note in docs/memberships.md).
  await expect(rowA.getByRole("button", { name: "Cancel" })).toBeEnabled();

  await page.getByRole("button", { name: "Add a membership" }).click();
  const planSelect = page.getByLabel("Plan");
  await planSelect.selectOption("casual_session");
  await page.getByRole("checkbox", { name: "Email them the payment instructions" }).uncheck();
  await page.getByRole("button", { name: "Add membership" }).click();
  // The click only dispatches the request; the card resets this to blank
  // only once the write has actually landed (`AddMembershipCard`'s success
  // path). Querying the database before this would race the insert — the
  // "newest row for this person" read could still return whatever existed
  // before this one landed.
  await expect(planSelect).toHaveValue("");

  const { data: casualPlan } = await adminClient()
    .from("membership_plans")
    .select("id")
    .eq("code", "casual_session")
    .single();
  if (!casualPlan) throw new Error("no seeded casual_session plan");
  const { data: membershipB } = await adminClient()
    .from("memberships")
    .select("id")
    .eq("user_id", applicantId)
    .eq("plan_id", casualPlan.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (membershipB) createdMembershipIds.push(membershipB.id);

  // Matched on price as well as name: the Sessions table's "Move to..."
  // dropdown below will shortly offer Membership B as an option, and its
  // plan-name text counts toward that row's `hasText` match too — but its
  // options never show a price.
  const rowB = page.getByRole("row").filter({ hasText: "Casual class" }).filter({ hasText: "$30" });
  await expect(rowB).toHaveCount(1);

  const sessionsRow = page.getByRole("row").filter({ hasText: "Tuesday class" });
  await expect(sessionsRow).toHaveCount(1);
  const moveSelect = sessionsRow.getByLabel("Membership to move this check-in to");
  const targetValue = await moveSelect
    .locator("option", { hasText: "Casual class" })
    .getAttribute("value");
  if (!targetValue) throw new Error("Membership B is not offered as a move target");
  await moveSelect.selectOption(targetValue);
  await sessionsRow.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Moved to Casual class.")).toBeVisible();

  // The class moved off it, so the delete guard has nothing left to say.
  await expect(deleteA).toBeEnabled();
  await deleteA.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("row").filter({ hasText: referenceA })).toHaveCount(0);
});

test("a check-in that outruns the trial's two sessions lands uncovered on the third", async ({
  page,
}) => {
  const { data: trial, error: tErr } = await adminClient()
    .from("memberships")
    .select("id, status, sessions_remaining")
    .eq("payment_reference", "JITSU-000103")
    .single();
  if (tErr || !trial) {
    throw new Error(`could not find the seeded trial membership: ${tErr?.message}`);
  }
  originalTrial = {
    id: trial.id,
    status: trial.status,
    sessions_remaining: trial.sessions_remaining,
  };

  // The seeded row is a legacy `pending` trial with one credit left (see
  // scripts/seed-local-club.mjs) — not the clean "active, two credits" start
  // this test needs, so it is arranged directly rather than through the app.
  await adminClient()
    .from("memberships")
    .update({ status: "active", sessions_remaining: 2 })
    .eq("id", trial.id);

  // The three earliest seeded classes: clear of the one the recoverable-
  // delete test above uses.
  const [event1, event2, event3] = await seededClassEventIds(3);

  await page.goto("/manager/check-in");

  await page.locator("#class-picker").selectOption(event1);
  await page.getByPlaceholder("Search by name or email").fill(APPLICANT_EMAIL);
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/Free trial, 1 left/)).toBeVisible();

  await page.locator("#class-picker").selectOption(event2);
  await page.getByPlaceholder("Search by name or email").fill(APPLICANT_EMAIL);
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/Free trial, 0 left/)).toBeVisible();

  const { data: closed } = await adminClient()
    .from("memberships")
    .select("status, sessions_remaining")
    .eq("id", trial.id)
    .single();
  if (!closed) throw new Error("the trial membership went missing mid-test");
  expect(closed).toMatchObject({ status: "expired", sessions_remaining: 0 });

  // Nothing is left to cover a third session. Check-in is never refused
  // (docs/check-in.md, rule 5) — it lands uncovered instead, for a manager to
  // sort out later, rather than turning someone away at the door.
  await page.locator("#class-picker").selectOption(event3);
  await page.getByPlaceholder("Search by name or email").fill(APPLICANT_EMAIL);
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/nothing covers it\. Added to needs attention\./)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention (1)" })).toBeVisible();
});
