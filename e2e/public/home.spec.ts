// A prospective member arrives on the home page and finds their way around.

import { expect, test } from "../support/test";
import { expectPageRendered, siteNavLink } from "../support/page";

test("the home page tells you what the club is and where", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Learn practical self-defence",
  );
  await expectPageRendered(page);
});

test("the header takes you to the class schedule", async ({ page }) => {
  await page.goto("/");

  await (await siteNavLink(page, "Classes")).click();

  await expect(page).toHaveURL(/\/classes$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Train with us in Ultimo");
  await expectPageRendered(page);
});

test("the call to action starts the free trial", async ({ page }) => {
  await page.goto("/");

  // The hero's button, not the header's: this is the one a person scrolling the
  // page presses, and it is the only copy that is visible at phone width.
  await page.getByRole("main").getByRole("link", { name: "Start your free trial" }).first().click();

  await expect(page).toHaveURL(/\/register-interest$/);
  await expect(page.getByRole("heading", { name: "Start your free trial" })).toBeVisible();
});
