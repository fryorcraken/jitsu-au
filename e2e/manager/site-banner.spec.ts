// A manager puts a notice across the top of the public site, and a visitor sees
// it. The rules (one line, link text and address together, no unsafe links)
// are proved in `src/lib/validation.test.ts`; this is the part a unit test
// cannot see: the save goes through the manager screen, and the public pages
// read it back through the service-role read that keeps the table itself
// manager-only.

import { expect, step, test } from "../support/test";
import { adminClient } from "../support/fixture";

const MESSAGE = "We're training at a temporary location, so free trials are paused for now.";

// The banner is club-wide, so it must not outlive this test: every later page
// photographed would carry it.
test.afterAll(async () => {
  await adminClient().from("club_settings").delete().eq("key", "site_banner");
});

test("a manager turns the site banner on and a visitor sees it", async ({ page }) => {
  await page.goto("/manager/site-banner");
  await expect(page.getByRole("heading", { name: "Site banner" })).toBeVisible();

  await step(page, "writes the notice and its link", async () => {
    await expect(page.getByRole("status").getByText("Off.")).toBeVisible();
    await page.getByRole("switch", { name: "Show the banner" }).click();
    await page.getByLabel("Message").fill(MESSAGE);
    await page.getByLabel("Link text").fill("Register your interest");
    await page.getByLabel("Where it goes").fill("/register-interest");
  });

  await step(page, "saves it, and it is live", async () => {
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").getByText("On.")).toBeVisible();
  });

  await step(page, "a visitor sees it at the top of the home page", async () => {
    await page.goto("/");
    const banner = page.getByRole("link", { name: `${MESSAGE} Register your interest` });
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("href", "/register-interest");
  });

  await step(page, "closing it keeps it closed", async () => {
    await page.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(page.getByText(MESSAGE)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(MESSAGE)).toHaveCount(0);
  });
});
