// A signed-in member opens the member area and finds their own details.

import { expect, test } from "../support/test";
import { expectPageRendered } from "../support/page";

test("the member area opens on the member's own account", async ({ page }) => {
  await page.goto("/account");

  await expect(page.getByRole("heading", { name: "Your account", level: 1 })).toBeVisible();
  await expectPageRendered(page);
});

test("a member who lands on a manager screen is sent back to their account", async ({ page }) => {
  await page.goto("/manager/waivers");

  // Guarded server-side too, but this is the half a member can see: rather than
  // an empty screen or an error, they end up somewhere they can use.
  //
  // Asserted as a redirect rather than as "the manager link is absent": the
  // roles query resolves after the page paints, so a missing-link assertion
  // would pass before the answer arrived, and would keep passing if members
  // were shown the manager nav.
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your account", level: 1 })).toBeVisible();
});
