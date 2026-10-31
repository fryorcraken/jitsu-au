// A visitor reads the blog: the articles sit on top and stay there, the club
// updates run underneath them newest first, and each post says which it is.
//
// The seeded article is older than both seeded updates on purpose
// (scripts/seed-local-club.mjs), so "on top" here means on top because it is an
// article, not because it happens to be the newest post.

import { expect, step, test } from "../support/test";
import { expectPageRendered } from "../support/page";

const ARTICLE = "Why we train against resistance";
const UPDATE = "Welcome to semester two";

test("the blog keeps articles on top of the club news", async ({ page }) => {
  await step(page, "the blog: articles on top, club news below", async () => {
    await page.goto("/blog");
    await expectPageRendered(page);

    const articles = page.getByRole("region", { name: "Articles" });
    const updates = page.getByRole("region", { name: "Club news" });

    await expect(articles.getByRole("link", { name: ARTICLE })).toBeVisible();
    await expect(articles).toContainText("min read");
    await expect(updates.getByRole("link", { name: UPDATE })).toBeVisible();
    // An article is listed once, in its own section, not again among the news.
    await expect(updates.getByRole("link", { name: ARTICLE })).toHaveCount(0);

    // Articles first in the page, whatever their date.
    const articlesTop = (await articles.boundingBox())!.y;
    const updatesTop = (await updates.boundingBox())!.y;
    expect(articlesTop).toBeLessThan(updatesTop);
  });

  await step(page, "an article: labelled, with its reading time", async () => {
    await page
      .getByRole("region", { name: "Articles" })
      .getByRole("link", { name: ARTICLE })
      .click();

    await expect(page).toHaveURL(/\/blog\/why-we-train-against-resistance$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ARTICLE);
    // The label above the title, read as one line so a regression to the
    // wrong label fails rather than passing on some other "Article" on the page.
    await expect(page.getByText("Blog/Article", { exact: true })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Club update");
    await expect(page.getByRole("main")).toContainText(/\d+ min read/);
    await expectPageRendered(page);
  });

  await step(page, "a club update: labelled, with its date", async () => {
    await page.goto("/blog");
    await page
      .getByRole("region", { name: "Club news" })
      .getByRole("link", { name: UPDATE })
      .click();

    await expect(page).toHaveURL(/\/blog\/welcome-to-semester-two$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(UPDATE);
    await expect(page.getByText("Blog/Club update", { exact: true })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("min read");
    await expectPageRendered(page);
  });
});
