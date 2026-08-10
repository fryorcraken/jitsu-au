// A signed-in member opens the member area and finds their own details.

import { expect, test } from "@playwright/test";

import { expectPageRendered } from "../support/page";

test("the member area opens on the member's own account", async ({ page }) => {
  await page.goto("/account");

  await expect(page.getByRole("heading", { name: "Your account", level: 1 })).toBeVisible();
  await expectPageRendered(page);
});

test("a member is not offered the manager screens", async ({ page }) => {
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account", level: 1 })).toBeVisible();

  // Guarded server-side too (see manager.waivers.tsx); this is the half a
  // member can see, and it is what stops them walking into a redirect.
  await expect(page.getByRole("link", { name: "Signed waivers" })).toHaveCount(0);
});
