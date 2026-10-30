// A member reading one article peeks at another through a link in it.
//
// Here rather than only in the unit suite because the card is a floating layer
// positioned by the browser, fed by a server function, and opened by a real
// pointer: jsdom can prove the tap logic, but not that a card actually appears
// over the article with the other article's words in it. The seeded welcome
// article links to the mat etiquette one for exactly this.
//
// Opening a preview writes nothing. Opening an article can mark it read, which
// the tour already does for every article, so nothing here needs putting back.
//
// The link is matched EXACTLY: the sidebar lists "Mat etiquette" too, and a
// case-insensitive substring match would find both.

import { devices } from "@playwright/test";
import { expect, step, test } from "../support/test";
import { expectPageRendered } from "../support/page";

const PREVIEW_TEXT = "A few habits keep training safe and quick to run.";

test("hovering a link to another article shows a preview of it", async ({ page }) => {
  const link = page.getByRole("link", { name: "mat etiquette", exact: true });

  await step(page, "a member reads the welcome article", async () => {
    await page.goto("/kb/welcome");
    await expect(
      page.getByRole("heading", { name: "Welcome to the club", level: 1 }),
    ).toBeVisible();
    await expectPageRendered(page);
    await expect(link).toBeVisible();
  });

  await step(page, "hovering the link shows what the other article says", async () => {
    await link.hover();
    await expect(page.getByText(PREVIEW_TEXT)).toBeVisible();
    // Still on the article they were reading.
    await expect(page).toHaveURL(/\/kb\/welcome$/);
  });
});

test.describe("on a phone", () => {
  // The phone the public projects are walked on, keeping the member's session.
  // Not a bare spread of the device: it carries `defaultBrowserType`, which
  // Playwright refuses inside a describe group.
  const phone = devices["Pixel 5"];
  test.use({
    viewport: phone.viewport,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
    isMobile: phone.isMobile,
    hasTouch: phone.hasTouch,
  });

  test("the first tap previews the link and the second one follows it", async ({ page }) => {
    const link = page.getByRole("link", { name: "mat etiquette", exact: true });

    await step(page, "a member reads the welcome article on their phone", async () => {
      await page.goto("/kb/welcome");
      await expect(
        page.getByRole("heading", { name: "Welcome to the club", level: 1 }),
      ).toBeVisible();
      await expectPageRendered(page);
    });

    await step(page, "one tap shows the preview and stays on the page", async () => {
      await link.tap();
      await expect(page.getByText(PREVIEW_TEXT)).toBeVisible();
      await expect(page).toHaveURL(/\/kb\/welcome$/);
    });

    await step(page, "the card's own button opens the article", async () => {
      await page.getByRole("link", { name: "Read the article" }).tap();
      await expect(page).toHaveURL(/\/kb\/mat-etiquette$/);
      await expect(page.getByRole("heading", { name: "Mat etiquette", level: 1 })).toBeVisible();
    });
  });
});
