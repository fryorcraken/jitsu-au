// The whole story, end to end: a stranger registers interest, signs the
// waiver, a manager approves it (assigning the free trial), the trial gets
// used up at the door, the person buys a real plan and is checked in on it,
// the invoice is paid, and — the awkward case that actually happens — the
// person later moves to a different plan, so a manager moves their check-in
// across and closes out the old invoice.
//
// Every other spec in this suite proves one screen in isolation, arranging
// its starting state directly where that's faster. This one deliberately
// does none of that: every fact below (the account, the trial, the invoices,
// the coverage) is produced by walking the real screens in order, the same
// way it would happen for a real person.

import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixture";
import { expectPageRendered } from "../support/page";

let newUserId: string | null = null;

test.afterAll(async () => {
  if (!newUserId) return;
  // Explicit, rather than relying on FK cascades: memberships.user_id is
  // ON DELETE SET NULL, not CASCADE, so deleting the auth user alone would
  // leave every membership row behind, orphaned instead of removed.
  await adminClient().from("session_checkins").delete().eq("user_id", newUserId);
  await adminClient().from("memberships").delete().eq("user_id", newUserId);
  await adminClient().from("waivers").delete().eq("user_id", newUserId);
  await adminClient().auth.admin.deleteUser(newUserId);
});

test("a new member's journey: register, sign, trial, buy, pay, and switch plans", async ({
  page,
  browser,
  baseURL,
}) => {
  // `page` is this project's manager session throughout. Two more identities
  // are needed along the way — an anonymous visitor, then the person
  // themselves once they can sign in — each gets its own browser context so
  // it never shares storage with the manager's.
  const email = `e2e-journey-${crypto.randomUUID()}@example.com`;
  const firstName = "Devon";
  const lastName = "Marsh";

  const visitor = await browser.newContext();
  const visitorPage = await visitor.newPage();

  await test.step("registers interest", async () => {
    await visitorPage.goto("/register-interest");
    await visitorPage.getByLabel("First name").fill(firstName);
    await visitorPage.getByLabel("Last name").fill(lastName);
    await visitorPage.getByLabel("Email").fill(email);
    await visitorPage.getByLabel("Phone (optional)").fill("0400 000 555");
    await visitorPage.getByRole("button", { name: "Continue" }).click();
    await expect(visitorPage.getByRole("heading", { name: /You're on the list/ })).toBeVisible();
  });

  await test.step("signs the waiver", async () => {
    // The confirmation screen's own link, carrying what was just typed —
    // exactly what a real visitor would click, rather than a hand-built URL.
    await visitorPage.getByRole("link", { name: "Sign my waiver" }).click();

    await visitorPage.getByLabel("Date of birth").fill("1995-05-15");
    await visitorPage.getByLabel("Address").fill("1 Broadway, Ultimo NSW 2007");
    await visitorPage.getByLabel("Contact name").fill("Sam Marsh");
    await visitorPage.getByLabel("Relationship").fill("Sibling");
    await visitorPage.getByLabel("Contact mobile").fill("0400 000 556");

    // An adult with nothing to declare: every health question is "No", which
    // also keeps the (otherwise required) medical-notes field out of the way.
    const healthQuestions = [
      "Is the participant prescribed any drugs which may impair reaction time or judgement?",
      "Has the participant, within the past 5 years, suffered any blackout, seizure, convulsion, fainting or dizzy spells, or any incapacity that would render it unsafe to participate in martial arts?",
      "Is the participant fitted with any electronic device or shunt?",
      "Does the participant have any current physical impairment, injuries or medical conditions (for example back injuries, weak ankles)?",
      "Is there any other medical information or health needs our instructors should be aware of for the participant's safety?",
    ];
    for (const question of healthQuestions) {
      await visitorPage.getByRole("radiogroup", { name: question }).getByLabel("No").check();
    }

    // Acknowledgements are template-driven, not fixed, so every rendered one
    // is ticked rather than naming a specific one.
    const acks = visitorPage.locator('input[id^="ack_"]');
    const ackCount = await acks.count();
    for (let i = 0; i < ackCount; i++) await acks.nth(i).check();

    // Typed rather than drawn: an equally valid signature, and a canvas
    // needs synthesized pointer events to register a non-empty stroke.
    await visitorPage.getByRole("tab", { name: "Type" }).click();
    await visitorPage.getByLabel("Type your full name to sign").fill(`${firstName} ${lastName}`);

    await visitorPage.getByRole("button", { name: "Sign and download waiver" }).click();
    await expect(
      visitorPage.getByRole("heading", { name: "Waiver signed", level: 1 }),
    ).toBeVisible();
  });

  await visitor.close();

  // Signing the waiver is what creates the person (a locked login + a
  // profile) — read back who that just became rather than guessing an id.
  const { data: userId, error: idErr } = await adminClient().rpc("user_id_by_email", {
    _email: email,
  });
  if (idErr || !userId) throw new Error(`the waiver did not create an account: ${idErr?.message}`);
  newUserId = userId;

  await test.step("a manager approves the waiver, which assigns the free trial", async () => {
    await page.goto(`/manager/users/${newUserId}`);
    await expectPageRendered(page);
    await page.getByRole("button", { name: "Approve" }).click();
    // The button relabels once its own click lands — no toast text to guess.
    await expect(page.getByRole("button", { name: "Unapprove" })).toBeVisible();
  });

  const [event1, event2, event3] = (
    await adminClient()
      .from("calendar_events")
      .select("id")
      .eq("title", "Tuesday class")
      .order("starts_at", { ascending: true })
      .limit(3)
  ).data!.map((e) => e.id);

  await test.step("a manager checks them in twice, using up the trial", async () => {
    await page.goto("/manager/check-in");
    await page.locator("#class-picker").selectOption(event1);
    await page.getByPlaceholder("Search by name or email").fill(email);
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByText(/Free trial, 1 left/)).toBeVisible();

    await page.locator("#class-picker").selectOption(event2);
    await page.getByPlaceholder("Search by name or email").fill(email);
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByText(/Free trial, 0 left/)).toBeVisible();
  });

  const member = await browser.newContext();
  const memberPage = await member.newPage();

  await test.step("the new member signs in and buys a casual class", async () => {
    const { data: link, error: linkErr } = await adminClient().auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: `${baseURL}/membership` },
    });
    if (linkErr) throw new Error(`could not sign the new member in: ${linkErr.message}`);
    await memberPage.goto(link.properties.action_link, { waitUntil: "networkidle" });
    await memberPage.waitForFunction(() =>
      Object.keys(localStorage).some((key) => key.endsWith("-auth-token")),
    );

    // Forces the public rate, so later assertions aren't at the mercy of a
    // student-number prefill.
    await memberPage.getByLabel(/UTS student number/).fill("");
    const heading = memberPage.getByRole("heading", { name: "Casual class", level: 3 });
    const card = heading.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    await card.getByRole("button", { name: "Choose & pay by transfer" }).click();
    await expect(
      memberPage.getByText(
        "Your invoice is ready. The payment details are at the top of this page.",
      ),
    ).toBeVisible();
  });

  await member.close();

  const { data: casualPlan } = await adminClient()
    .from("membership_plans")
    .select("id, name")
    .eq("code", "casual_session")
    .single();
  if (!casualPlan) throw new Error("no seeded casual_session plan");
  const { data: casualMembership } = await adminClient()
    .from("memberships")
    .select("id, payment_reference")
    .eq("user_id", newUserId)
    .eq("plan_id", casualPlan.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!casualMembership)
    throw new Error("the casual-class purchase did not create a membership row");

  await test.step("a manager checks them in a third time, now covered by the casual class", async () => {
    await page.goto("/manager/check-in");
    await page.locator("#class-picker").selectOption(event3);
    await page.getByPlaceholder("Search by name or email").fill(email);
    await page.getByRole("button", { name: "Check in" }).click();
    // One credit, spent: the casual class closes itself on the same check-in
    // that used it, exactly like the trial did above.
    await expect(page.getByText(/Casual class, 0 left/)).toBeVisible();
  });

  await test.step("a manager marks the casual-class invoice as paid", async () => {
    await page.goto(`/manager/users/${newUserId}`);
    const row = page.getByRole("row").filter({ hasText: casualMembership.payment_reference });
    await row.getByRole("button", { name: "Mark as paid" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Mark as paid" }).click();
    await expect(row.getByRole("button", { name: "Mark as paid" })).toHaveCount(0);

    // Both reasons at once, not just the first one found: paid AND attended.
    const deleteButton = row.getByRole("button", { name: "Delete" });
    await expect(deleteButton).toHaveAttribute(
      "title",
      /a payment is recorded against it and a class was checked in against it/,
    );
  });

  const { data: periodPlan } = await adminClient()
    .from("membership_plans")
    .select("id, code, name")
    .eq("kind", "period")
    .limit(1)
    .single();
  if (!periodPlan) throw new Error("no seeded period plan");

  await test.step("the person commits to a full training period, and the manager raises it", async () => {
    await page.getByRole("button", { name: "Add a membership" }).click();
    await page.getByLabel("Plan").selectOption(periodPlan.code);
    await page.getByRole("checkbox", { name: "Email them the payment instructions" }).uncheck();
    await page.getByRole("button", { name: "Add membership" }).click();
  });

  const { data: periodMembership } = await adminClient()
    .from("memberships")
    .select("id, payment_reference")
    .eq("user_id", newUserId)
    .eq("plan_id", periodPlan.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!periodMembership) throw new Error("raising the period plan did not create a membership row");

  // Read back rather than asserted on screen by plan name: by this point the
  // Sessions table's "Move to..." dropdowns (three check-ins now have other
  // memberships to offer) all mention this plan too, so a name-only row
  // match would resolve to more than one element — same trap as
  // check-in.spec.ts hit with "Casual class".
  await expect(
    page.getByRole("row").filter({ hasText: periodMembership.payment_reference }),
  ).toHaveCount(1);

  await test.step("a manager moves the check-in off the casual class and onto the new plan", async () => {
    // Scoped by the "Covered by" pill (a <span>) rather than by row text: a
    // plain hasText match would also catch this same row's own "Move to..."
    // dropdown, whose <option> list mentions every other plan by name too.
    const sessionsRow = page
      .getByRole("row")
      .filter({ has: page.locator("span").filter({ hasText: "Casual class" }) });
    await expect(sessionsRow).toHaveCount(1);

    const moveSelect = sessionsRow.getByLabel("Membership to move this check-in to");
    const targetValue = await moveSelect
      .locator("option", { hasText: periodPlan.name })
      .getAttribute("value");
    if (!targetValue) throw new Error("the new plan is not offered as a move target");
    await moveSelect.selectOption(targetValue);
    await sessionsRow.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText(`Moved to ${periodPlan.name}.`)).toBeVisible();
  });

  await test.step("the casual class, superseded and free of the check-in, is cancelled", async () => {
    const row = page.getByRole("row").filter({ hasText: casualMembership.payment_reference });
    await row.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel membership" }).click();
    await expect(row).toContainText("cancelled");

    // The new plan is what pays for them now: active, and it is the one the
    // check-in landed on.
    const periodRow = page.getByRole("row").filter({ hasText: periodMembership.payment_reference });
    await expect(periodRow).toContainText("active");
  });
});
