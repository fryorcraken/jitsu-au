// Asking for a member screen while signed out sends you to sign in, and
// remembers where you were going. The other half of that: a public page must
// not point someone at the gate in the first place, because there is no
// self-serve sign-up behind it.

import { expect, test } from "../support/test";

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

// /membership is behind the auth gate and a login only exists once the club has
// approved your waiver, so the pricing page's call to action has to read who is
// looking at it. Sending a prospect who just decided on the price to a sign-in
// box is losing them at the best moment they will ever have.
test("the pricing page sends a signed-out visitor to the joining funnel, not the gate", async ({
  page,
}) => {
  await page.goto("/pricing");

  await page.getByRole("main").getByRole("link", { name: "Join the club" }).click();

  await expect(page).toHaveURL(/\/register-interest$/);
  await expect(page.getByRole("heading", { name: "Start your free trial" })).toBeVisible();
});

test("a member who is signed out can still get from pricing to their membership", async ({
  page,
}) => {
  await page.goto("/pricing");

  await page.getByRole("main").getByRole("link", { name: "Sign in" }).click();

  // The link asks to come back to /membership rather than dropping them on
  // their account to find it again. Only the URL is asserted here: what /auth
  // then does with the parameter is SignInForms' business, and it currently
  // honours it on the password form but not on the emailed magic link.
  await expect(page).toHaveURL(/\/auth\?redirect=%2Fmembership$/);
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
});
