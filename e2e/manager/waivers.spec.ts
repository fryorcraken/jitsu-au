// A manager opens the waivers screen and sees what the club has been sent.

import { expect, test } from "@playwright/test";

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

  // The seeded member's waiver is approved and their latest, so the screen
  // derives it as the one in force. (The displayed status is derived, not
  // stored — see docs/waivers.md.)
  const row = page.getByRole("row").filter({ hasText: fixture.personas.member.email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("active");
});
