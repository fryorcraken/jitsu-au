// Asking for a member screen while signed out sends you to sign in, and
// remembers where you were going.

import { expect, test } from "@playwright/test";

test("a signed-out visitor asking for their account is sent to sign in", async ({ page }) => {
  await page.goto("/account");

  await expect(page).toHaveURL(/\/auth\?redirect=%2Faccount$/);
  // The card's "Sign in" title is a div, not a heading, so assert on the form
  // itself. It is the better assertion anyway: it says you can sign in from
  // here, not just that the page is titled as though you could.
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("the sign-in page points people with no login at the waiver", async ({ page }) => {
  await page.goto("/auth");

  await expect(page.getByRole("link", { name: "Sign the training waiver" })).toHaveAttribute(
    "href",
    "/waiver",
  );
});
