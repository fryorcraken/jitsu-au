// A manager emails every member about next semester's plan, from the plan's
// own card: the tick box beside Save, the hard stop with the real number in it,
// and the "Announced on..." line it leaves behind. docs/notifications.md, "A
// plan is announced".

import { expect, step, test } from "../support/test";
import { adminClient, readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

/** The seed's never-announced plan (scripts/seed-local-club.mjs). */
const PLAN_CODE = "screenshot-next-semester";

let planId: string;

test.beforeAll(async () => {
  const { data, error } = await adminClient()
    .from("membership_plans")
    .select("id")
    .eq("code", PLAN_CODE)
    .single();
  if (error || !data) throw new Error(`no seeded ${PLAN_CODE} plan: re-run the seed`);
  planId = data.id;
});

// The announcement writes a notification for every member, which the tour
// would otherwise photograph as somebody's unread badge on every later run.
test.afterAll(async () => {
  if (!planId) return;
  await adminClient()
    .from("notifications")
    .delete()
    .eq("kind", "membership_plan_open")
    .eq("href", `/membership?plan=${planId}`);
});

test("a manager emails every member about a plan, after saying yes to the real number", async ({
  page,
}) => {
  const fixture = readClubFixture();
  await page.goto("/manager/membership-plans");
  await expectPageRendered(page);

  const card = page.locator(`[data-plan="${planId}"]`);
  const box = card.getByRole("checkbox", { name: "Email all members about this plan" });
  const save = card.getByRole("button", { name: "Save" });

  await step(page, "the manager ticks the box beside Save", async () => {
    // Nothing on the plan has changed, so Save starts greyed out; the box alone
    // is reason enough to press it.
    await expect(save).toBeDisabled();
    await box.check();
    await expect(save).toBeEnabled();
  });

  const dialog = page.getByRole("alertdialog");
  await step(page, "the app asks first, saying how many people it will email", async () => {
    await save.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Save and email \d+ (people|person) about Next semester\?/);
    await expect(dialog).toContainText("This can't be undone.");
  });

  // Read off the dialog, then checked against what the app actually wrote.
  const asked = Number(
    /Save and email (\d+)/.exec((await dialog.textContent()) ?? "")?.[1] ?? Number.NaN,
  );
  expect(asked).toBeGreaterThan(0);

  await step(page, "saved and sent, the card says when and to how many", async () => {
    await dialog.getByRole("button", { name: "Save and email" }).click();
    await expect(card).toContainText(
      new RegExp(`Announced on \\d{1,2} \\w{3} to ${asked} (people|person)\\.`),
    );
    await expect(box).not.toBeChecked();
  });

  // One row per inbox, so the member's family is one row on the member, never
  // one per child, and nobody waiting on a waiver is in it.
  const { data: rows } = await adminClient()
    .from("notifications")
    .select("user_id")
    .eq("kind", "membership_plan_open")
    .eq("href", `/membership?plan=${planId}`);
  const recipients = (rows ?? []).map((r) => r.user_id);
  expect(recipients).toHaveLength(asked);
  expect(recipients).toContain(fixture.personas.member.userId);
  for (const child of fixture.household?.children ?? [])
    expect(recipients).not.toContain(child.userId);
});
