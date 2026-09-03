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

import { expect, shot, step, test } from "../support/test";
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
  // themselves once they can sign in — each gets its own browser context, so
  // it never shares storage with the manager's. An explicit empty storage
  // state, not the default: this project's `use.storageState` (the saved
  // manager session) turned out to still apply to a bare `newContext()` call
  // with no override — a signed-out visitor cannot be assumed otherwise.
  const NO_SESSION = { cookies: [], origins: [] };
  const email = `e2e-journey-${crypto.randomUUID()}@example.com`;
  const firstName = "Devon";
  const lastName = "Marsh";

  const visitor = await browser.newContext({ storageState: NO_SESSION });
  const visitorPage = await visitor.newPage();

  await step(visitorPage, "registers interest", async () => {
    await visitorPage.goto("/register-interest");
    await visitorPage.getByLabel("First name").fill(firstName);
    await visitorPage.getByLabel("Last name").fill(lastName);
    await visitorPage.getByLabel("Email").fill(email);
    await visitorPage.getByLabel("Phone (optional)").fill("0400 000 555");
    await visitorPage.getByRole("button", { name: "Continue" }).click();
    await expect(visitorPage.getByRole("heading", { name: /You're on the list/ })).toBeVisible();
  });

  await step(visitorPage, "signs the waiver", async () => {
    // The confirmation screen's own link, carrying what was just typed —
    // exactly what a real visitor would click, rather than a hand-built URL.
    await visitorPage.getByRole("link", { name: "Sign my waiver" }).click();
    // The page's own fields (names, dates) render immediately, but the
    // current waiver template — including which acknowledgements exist, if
    // any — is fetched client-side. Waited for generally rather than for one
    // assumed-present acknowledgement id: which ones exist is template
    // content, not something this test should assume.
    await visitorPage.waitForLoadState("networkidle");

    // First/last/email/phone come from the link's own query-param prefill
    // (checked here rather than re-typed): the email field in particular is
    // locked once prefilled, so re-filling it fails outright instead of
    // being a harmless no-op.
    await expect(visitorPage.getByLabel("Email")).toHaveValue(email);
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
    // is ticked rather than naming a specific one (the network-idle wait
    // above is what makes it safe to count them now). Not
    // `input[id^="ack_"]`: these are shadcn/Radix Checkboxes, which render
    // as `<button role="checkbox">`, not a native `<input>` — that selector
    // would match nothing, silently leave a required one unticked, and the
    // server would reject the submission with no heading change to say why.
    const acks = visitorPage.locator('[id^="ack_"]');
    const ackCount = await acks.count();
    for (let i = 0; i < ackCount; i++) await acks.nth(i).check();

    // Typed rather than drawn: an equally valid signature, and a canvas
    // needs synthesized pointer events to register a non-empty stroke.
    await visitorPage.getByRole("tab", { name: "Type" }).click();
    await visitorPage.getByLabel("Type your full name to sign").fill(`${firstName} ${lastName}`);

    // The form as the person leaves it, before it is replaced by the
    // confirmation. A step's own picture is of where it ENDED, so the only way
    // a filled-in form reaches the gallery is to ask for it here.
    await shot(visitorPage, "the waiver, filled in");

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

  await step(page, "a manager approves the waiver, which assigns the free trial", async () => {
    await page.goto(`/manager/users/${newUserId}`);
    await expectPageRendered(page);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    // Approving emails the member and opens their login, so it asks first and
    // says so. The photograph of this step is that dialog.
    await expect(page.getByRole("alertdialog")).toContainText("starts their free trial");
    await page.getByRole("button", { name: "Approve waiver" }).click();
    // The button relabels once its own click lands — no toast text to guess.
    await expect(page.getByRole("button", { name: "Revoke approval" })).toBeVisible();
  });

  // The four earliest seeded classes (scripts/seed-local-club.mjs puts five
  // on the calendar, at day -14/-7/+1/+8/+15 from seed time). The earliest
  // sits right at the check-in screen's 14-day lookback edge, so if this CI
  // run happens to straddle a UTC midnight between seeding and this step,
  // it could briefly fall outside the window — a known, narrow residual risk
  // rather than one this test tries to fully engineer away.
  const { data: events, error: eventsErr } = await adminClient()
    .from("calendar_events")
    .select("id")
    .eq("title", "Tuesday class")
    .order("starts_at", { ascending: true })
    .limit(4);
  if (eventsErr || !events || events.length < 4) {
    throw new Error(
      `fewer than 4 seeded classes to check the new member in against: ${eventsErr?.message}`,
    );
  }
  const [event1, event2, event3, event4] = events.map((e) => e.id);

  await step(page, "a manager checks them in twice, using up the trial", async () => {
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

  const member = await browser.newContext({ storageState: NO_SESSION });
  const memberPage = await member.newPage();

  await step(memberPage, "the new member signs in and buys a casual class", async () => {
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

  await step(
    page,
    "a manager checks them in a third time, now covered by the casual class",
    async () => {
      await page.goto("/manager/check-in");
      await page.locator("#class-picker").selectOption(event3);
      await page.getByPlaceholder("Search by name or email").fill(email);
      await page.getByRole("button", { name: "Check in" }).click();
      // One credit, spent: the casual class closes itself on the same check-in
      // that used it, exactly like the trial did above.
      await expect(page.getByText(/Casual class, 0 left/)).toBeVisible();
    },
  );

  await step(page, "a manager marks the casual-class invoice as paid", async () => {
    await page.goto(`/manager/users/${newUserId}`);
    // Matched on plan name too, not the reference alone: a brand-new member
    // has no existing insurance cover, so it was bundled onto this purchase
    // automatically (mandatory, not a checkbox they could leave off) — that
    // invoice rides on the SAME reference, so the reference alone now
    // resolves to two rows.
    const row = page
      .getByRole("row")
      .filter({ hasText: casualMembership.payment_reference })
      .filter({ hasText: "Casual class" });
    await expect(row).toHaveCount(1);
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

  await step(
    page,
    "the person commits to a full training period, and the manager raises it",
    async () => {
      await page.getByRole("button", { name: "Add a membership" }).click();
      const planSelect = page.getByLabel("Plan");
      await planSelect.selectOption(periodPlan.code);
      await page.getByRole("checkbox", { name: "Email them the payment instructions" }).uncheck();
      await page.getByRole("button", { name: "Add membership" }).click();
      // The click only dispatches the request; the card resets this to blank
      // only once the write has actually landed. The next step reads the
      // database for the row this just created, which would otherwise race
      // the insert.
      await expect(planSelect).toHaveValue("");
    },
  );

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

  await step(
    page,
    "a manager moves the check-in off the casual class and onto the new plan",
    async () => {
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
    },
  );

  await step(
    page,
    "the casual class, superseded and free of the check-in, is cancelled",
    async () => {
      // Same reason as the "mark as paid" step above: the bundled insurance
      // invoice still shares this reference, so it takes the plan name too to
      // land on the casual-class row alone.
      const row = page
        .getByRole("row")
        .filter({ hasText: casualMembership.payment_reference })
        .filter({ hasText: "Casual class" });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "Cancel" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Cancel membership" })
        .click();
      await expect(row).toContainText("Cancelled");

      // The new plan is what pays for them now: active, and it is the one the
      // check-in landed on.
      const periodRow = page
        .getByRole("row")
        .filter({ hasText: periodMembership.payment_reference });
      await expect(periodRow).toContainText("Active");
    },
  );

  // Real club behaviour: someone on a period plan still occasionally pays for
  // a one-off extra class (a friend's trial class, a session outside their
  // usual days). A `casual_session` membership is one credit, so there is no
  // way to spend the SAME row twice — the only way to prove the check-in
  // invoice guarantee (`ensureCasualInvoiceEmailed`, reached from
  // `applyCoverage` in checkin.functions.ts) engages on every casual credit a
  // person spends, not just their first ever one, is a genuinely SECOND casual
  // purchase. Run after the plan switch above, so it cannot disturb that
  // step's "exactly one check-in covered by Casual class" assertion.
  const second = await browser.newContext({ storageState: NO_SESSION });
  const secondPage = await second.newPage();

  await step(secondPage, "the member buys a second casual class", async () => {
    const { data: link, error: linkErr } = await adminClient().auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: `${baseURL}/membership` },
    });
    if (linkErr) throw new Error(`could not sign the member back in: ${linkErr.message}`);
    await secondPage.goto(link.properties.action_link, { waitUntil: "networkidle" });
    await secondPage.waitForFunction(() =>
      Object.keys(localStorage).some((key) => key.endsWith("-auth-token")),
    );
    await secondPage.getByLabel(/UTS student number/).fill("");

    const heading = secondPage.getByRole("heading", { name: "Casual class", level: 3 });
    const card = heading.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    // A different session date than the first casual purchase: the payment
    // reference is deterministic on (surname, user id, session date), so
    // buying two casual classes dated the same day would land both on the
    // SAME reference — the exact shape insurance bundling uses on purpose,
    // but wrong here, where the point is two genuinely separate invoices.
    await card
      .getByLabel("Session date")
      .fill(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
    await card.getByRole("button", { name: "Choose & pay by transfer" }).click();
    await expect(
      secondPage.getByText(
        "Your invoice is ready. The payment details are at the top of this page.",
      ),
    ).toBeVisible();
    await second.close();
  });

  const { data: secondCasualMembership } = await adminClient()
    .from("memberships")
    .select("id, payment_reference")
    .eq("user_id", newUserId)
    .eq("plan_id", casualPlan.id)
    .neq("id", casualMembership.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!secondCasualMembership)
    throw new Error("the second casual-class purchase did not create a membership row");
  // Genuinely a second invoice, not a re-read of the first: a distinct
  // reference is what a different session date buys, and it is also what
  // makes the two casual purchases tellable apart on screen.
  expect(secondCasualMembership.payment_reference).not.toBe(casualMembership.payment_reference);

  await step(
    page,
    "a manager checks them in on the second casual credit too, and it reaches the invoice guarantee",
    async () => {
      await page.goto("/manager/check-in");
      await page.locator("#class-picker").selectOption(event4);
      await page.getByPlaceholder("Search by name or email").fill(email);
      await page.getByRole("button", { name: "Check in" }).click();
      // One credit, spent, exactly like the first casual purchase — the credit
      // pack precedence still outranks the now-active period plan.
      await expect(page.getByText(/Casual class, 0 left/)).toBeVisible();

      // The door screen has no email transport to assert an actual send
      // against (no LOVABLE_API_KEY in the local stack, by design — see
      // docs/e2e-tests.md), so what is provable end to end is the part that IS
      // observable: `applyCoverage` resolved and spent THIS credit
      // specifically, and reached `ensureCasualInvoiceEmailed` without the door
      // failing or stalling — on the second casual credit this person has ever
      // spent, not just the first. `membership.functions.test.ts` pins which
      // email that guarantee sends and with what.
      const { data: checkin } = await adminClient()
        .from("session_checkins")
        .select("coverage, membership_id, consumed_credit")
        .eq("user_id", newUserId)
        .eq("membership_id", secondCasualMembership.id)
        .maybeSingle();
      expect(checkin).toMatchObject({
        coverage: "session",
        membership_id: secondCasualMembership.id,
        consumed_credit: true,
      });

      const { data: spent } = await adminClient()
        .from("memberships")
        .select("sessions_remaining, status")
        .eq("id", secondCasualMembership.id)
        .maybeSingle();
      expect(spent).toMatchObject({ sessions_remaining: 0, status: "expired" });
    },
  );

  // The row above is stored as `expired`, but a casual class is one class, not
  // a stretch of time: nothing about it went out of date, its class was used.
  // This is the only place the whole path is provable at once — a real credit
  // spent to zero by a real check-in, then read back off the screen a manager
  // actually looks at (docs/memberships.md, "What an ended membership is
  // called"). `toContainText` is case-sensitive, and sentence case is the
  // point: these labels are words, not enum values.
  await step(page, "the spent casual class reads as used up, not expired", async () => {
    await page.goto("/manager/memberships");
    const row = page
      .getByRole("row")
      .filter({ hasText: secondCasualMembership.payment_reference })
      .filter({ hasText: "Casual class" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Used up");
    await expect(row).not.toContainText("Expired");
  });
});

// The other half of the same story, and the one #102 is actually about: the
// person who signs is not the person who trains.
//
// A parent signs for a child who will never have a login, a manager approves it,
// and the login that opens is the PARENT's. Everything here is walked through
// the real screens for the same reason the journey above is.
let childUserId: string | null = null;
let parentUserId: string | null = null;

test.afterAll(async () => {
  const admin = adminClient();
  // The child FIRST. `profiles.guardian_user_id` is ON DELETE RESTRICT, so
  // deleting a parent who still has children fails with a raw 23503 and removes
  // nothing at all (`docs/erasing-personal-data.md`).
  for (const id of [childUserId, parentUserId]) {
    if (!id) continue;
    await admin.from("memberships").delete().eq("user_id", id);
    await admin.from("waivers").delete().eq("user_id", id);
  }
  if (childUserId) await admin.auth.admin.deleteUser(childUserId);
  if (parentUserId) await admin.auth.admin.deleteUser(parentUserId);
});

test("a parent signs for a child, and approving it unlocks the PARENT", async ({
  page,
  browser,
}) => {
  const NO_SESSION = { cookies: [], origins: [] };
  const parentEmail = `e2e-parent-${crypto.randomUUID()}@example.com`;
  const parentName = "Rowan Kestrel";
  const childFirst = "Wren";
  const childLast = "Kestrel";

  const visitor = await browser.newContext({ storageState: NO_SESSION });
  const visitorPage = await visitor.newPage();

  await step(visitorPage, "a parent signs a waiver for their child", async () => {
    await visitorPage.goto("/waiver");
    await visitorPage.waitForLoadState("networkidle");

    // The question is asked FIRST, before any field, because the answer changes
    // what the rest of the form asks for. Choosing a child removes the
    // participant's own email field entirely: a nine-year-old is never asked
    // for one.
    await visitorPage
      .getByRole("radio", { name: "My child, or someone else I look after" })
      .check();
    await expect(visitorPage.getByLabel("Email", { exact: true })).toHaveCount(0);

    await visitorPage.getByLabel("First name").fill(childFirst);
    await visitorPage.getByLabel("Last name").fill(childLast);
    // A child, so the guardian block is required whatever else is on the form.
    await visitorPage.getByLabel("Date of birth").fill("2016-03-08");
    await visitorPage.getByLabel("Phone").fill("0400 000 557");
    await visitorPage.getByLabel("Address").fill("7 Pyrmont Bridge Road, Pyrmont NSW 2009");

    await visitorPage.getByLabel("Parent or guardian name").fill(parentName);
    await visitorPage.getByLabel("Relationship to the participant").fill("Parent");
    await visitorPage.getByLabel(/Guardian mobile/).fill("0400 000 558");
    // Required for a child, where it is optional for a minor signing for
    // themselves: this address IS the club's only way to reach the family.
    await visitorPage.getByLabel(/Guardian email/).fill(parentEmail);

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

    const acks = visitorPage.locator('[id^="ack_"]');
    const ackCount = await acks.count();
    for (let i = 0; i < ackCount; i++) await acks.nth(i).check();

    // Two signatures, and both are the PARENT's hand: the child's name on the
    // participant line, signed by the person who may consent for them.
    const typeTabs = visitorPage.getByRole("tab", { name: "Type" });
    await typeTabs.nth(0).click();
    await visitorPage.getByLabel("Type your full name to sign").fill(`${childFirst} ${childLast}`);
    await typeTabs.nth(1).click();
    await visitorPage.getByPlaceholder("Guardian full name").fill(parentName);

    await shot(visitorPage, "a child's waiver, filled in by their parent");

    await visitorPage.getByRole("button", { name: "Sign and download waiver" }).click();
    await expect(
      visitorPage.getByRole("heading", { name: "Waiver signed", level: 1 }),
    ).toBeVisible();
  });

  await visitor.close();

  const admin = adminClient();

  // The parent is resolved from the address they gave; the child is found
  // through the household link, because they have no address to look up. That
  // asymmetry is the model: a dependant is identified by whose account they are
  // on, never by an email.
  const { data: parentId, error: parentErr } = await admin.rpc("user_id_by_email", {
    _email: parentEmail,
  });
  if (parentErr || !parentId) {
    throw new Error(`the filing did not create the parent: ${parentErr?.message}`);
  }
  parentUserId = parentId;

  const { data: kids, error: kidsErr } = await admin
    .from("profiles")
    .select("user_id, first_name, guardian_user_id")
    .eq("guardian_user_id", parentId);
  if (kidsErr) throw new Error(`could not read the household: ${kidsErr.message}`);
  expect(kids, "the filing did not put a child on the parent's account").toHaveLength(1);
  childUserId = kids![0].user_id;
  expect(kids![0].first_name).toBe(childFirst);
  // Two people, not one. The child is their own person record, which is the
  // whole of #102.
  expect(childUserId).not.toBe(parentUserId);

  await step(page, "a manager approves the child's waiver", async () => {
    await page.goto(`/manager/users/${childUserId}`);
    await expectPageRendered(page);

    // The page says whose child this is before the manager approves anything.
    await expect(page.getByRole("heading", { name: "Household", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(parentName) })).toBeVisible();

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("button", { name: "Approve waiver" }).click();
    await expect(page.getByRole("button", { name: "Revoke approval" })).toBeVisible();
  });

  // The assertion this whole test exists for. Approving a CHILD's waiver opens
  // the PARENT's login, because the child will never have one: #102's "a
  // parent-only account is normal", and `docs/waivers.md` rule 6.
  const { data: parentUser } = await admin.auth.admin.getUserById(parentUserId!);
  expect(parentUser.user?.banned_until ?? null, "the parent's login was not unlocked").toBeFalsy();

  // And the child stays locked, forever. A child never gets a login, so an
  // approval that unlocked them would be handing one out.
  const { data: childUser } = await admin.auth.admin.getUserById(childUserId!);
  expect(childUser.user?.banned_until, "the child's login was unlocked").toBeTruthy();

  // The trial goes to the person who trains, not to the person who signed.
  const { data: trials } = await admin
    .from("memberships")
    .select("user_id")
    .eq("user_id", childUserId!);
  expect(trials?.length, "the child did not get their own free trial").toBeGreaterThan(0);
  const { data: parentTrials } = await admin
    .from("memberships")
    .select("user_id")
    .eq("user_id", parentUserId!);
  expect(parentTrials ?? [], "the parent was given a membership they did not ask for").toHaveLength(
    0,
  );
});
