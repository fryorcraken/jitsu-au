// A signed-in member checks their own status, and buys a plan through the
// page: the money side of the member area, next to account.spec.ts's profile
// side.

import { expect, test } from "../support/test";
import { adminClient, readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

/** Payment references the purchase test below raises, for afterAll cleanup. */
const references: string[] = [];

test.afterAll(async () => {
  if (references.length === 0) return;
  await adminClient().from("memberships").delete().in("payment_reference", references);
});

test("the member's status and memberships show on their membership page", async ({ page }) => {
  await page.goto("/membership");

  await expect(page.getByText("You're an active member. See you on the mat!")).toBeVisible();

  // "This semester" is the fallback period plan scripts/seed-local-club.mjs
  // creates when the fresh migrations ship no dated plan of their own (see
  // its planOf helper) — the member's seeded membership is bought on it.
  const periodRow = page.getByRole("row").filter({ hasText: "This semester" });
  await expect(periodRow).toHaveCount(1);
  await expect(periodRow).toContainText("Active");

  const insuranceRow = page.getByRole("row").filter({ hasText: "Sydney Jitsu yearly membership" });
  await expect(insuranceRow).toHaveCount(1);
  await expect(insuranceRow).toContainText("Active");

  await expectPageRendered(page);
});

test("a member can buy a plan and is shown how to pay for it", async ({ page }) => {
  const fixture = readClubFixture();
  const { data: casualPlan } = await adminClient()
    .from("membership_plans")
    .select("id")
    .eq("code", "casual_session")
    .single();
  if (!casualPlan) throw new Error("no seeded casual_session plan");

  await page.goto("/membership");

  // Forces the public rate, so the amount checked below is not at the mercy
  // of whether the seeded waiver's student number happened to prefill.
  await page.getByLabel(/UTS student number/).fill("");

  // Plan cards carry no individual landmark, so the card is found from its
  // own heading and the "Choose" button read off its enclosing card.
  const heading = page.getByRole("heading", { name: "Casual class", level: 3 });
  const card = heading.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
  await card.getByRole("button", { name: "Choose & pay by transfer" }).click();

  await expect(
    page.getByText("Your invoice is ready. The payment details are at the top of this page."),
  ).toBeVisible();
  await expect(page.getByText("How to pay")).toBeVisible();

  // The screen says it worked; this is what proves it did. Matched by plan
  // rather than "the newest row", since a still-open insurance invoice would
  // otherwise leave this guessing which of two just-inserted rows is which.
  const { data: created } = await adminClient()
    .from("memberships")
    .select("id, price_cents, payment_reference")
    .eq("user_id", fixture.personas.member.userId)
    .eq("plan_id", casualPlan.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!created) throw new Error("the purchase did not create a membership row");
  references.push(created.payment_reference);

  expect(created.price_cents).toBe(3000);
  // The reference now shows in two places on this page: the status table's
  // Reference column (unpaid rows show it there too) and this pay panel's own
  // amount/reference block, which is the only one rendered as a <dl>.
  await expect(page.locator("dl").getByText(created.payment_reference)).toBeVisible();
});
