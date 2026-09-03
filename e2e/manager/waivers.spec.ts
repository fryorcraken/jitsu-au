// A manager opens the waivers screen and sees what the club has been sent.

import { expect, test } from "../support/test";
import { readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

test("the manager sidebar reaches the waivers screen", async ({ page }) => {
  await page.goto("/account");

  await page.getByRole("link", { name: "Signed waivers" }).click();

  await expect(page).toHaveURL(/\/manager\/waivers$/);
  await expect(page.getByRole("heading", { name: "Waivers", level: 1 })).toBeVisible();
  await expectPageRendered(page);
});

test("the waivers screen lists the club's submissions", async ({ page }) => {
  const fixture = readClubFixture();
  await page.goto("/manager/waivers");

  // TWO rows carry the member's address, not one. A person on somebody else's
  // account has no address of their own, so the address submitted on their
  // waiver is their guardian's, and the seeded club now has a child of this
  // member. That is a fact about the club rather than a bug, and it is exactly
  // why "one row per address" stopped being a safe thing to assert.
  const rows = page.getByRole("row").filter({ hasText: fixture.personas.member.email });
  await expect(rows).toHaveCount(2);

  // The seeded member's own waiver is approved and their latest, so the screen
  // derives it as the one in force. (The displayed status is derived, not
  // stored — see docs/waivers.md.)
  const own = rows.filter({ hasNotText: "Robin" });
  await expect(own).toHaveCount(1);
  await expect(own).toContainText("active");

  // And the child's waiver is listed under the child's own name, which is the
  // half a manager needs in order to tell the two apart at all.
  await expect(rows.filter({ hasText: "Robin" })).toHaveCount(1);
});
