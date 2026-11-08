// A member gets ready for a grading: everything up to their next belt, one
// topic at a time, and back and forth between that and a belt's own page.
//
// Here rather than only in the unit suite because what it proves is the join:
// the syllabus read on the server, the reader-side filter that keeps a draft
// belt away from a member, the address driving the view, and the router link
// from a belt page's heading into the view. The seed writes yellow and orange
// as published belt pages and green as a managers-only draft
// (scripts/seed-local-club.mjs).
//
// Reading only. Opening a belt page can mark it read, which the tour already
// does for every page, so nothing here needs putting back.

import { expect, step, test } from "../support/test";
import { expectPageRendered } from "../support/page";

test("a member reads breakfalling up to orange, and goes from a belt page into it", async ({
  page,
}) => {
  const upTo = page.getByLabel("Up to", { exact: true });

  await step(page, "the syllabus by topic, up to orange", async () => {
    await page.goto("/kb/syllabus?up_to=orange");
    await expect(page.getByRole("heading", { name: "Syllabus by topic", level: 1 })).toBeVisible();
    await expectPageRendered(page);
    await expect(upTo).toHaveValue("orange");
    await expect(page.getByText("Kneeling breakfalls: forward, backward, sideways")).toBeVisible();
    await expect(page.getByText("Over the belt")).toBeVisible();
    // Green is past orange, and a draft a member cannot see at all.
    await expect(page.getByText("Judo rolls")).toHaveCount(0);
    await expect(upTo.locator("option", { hasText: "Green" })).toHaveCount(0);
  });

  await step(page, "narrowed to one topic, which the address keeps", async () => {
    await page.getByLabel("Topic", { exact: true }).selectOption("breakfalling");
    await expect(page).toHaveURL(/topic=breakfalling/);
    await expect(page.getByRole("heading", { name: "Breakfalling", level: 2 })).toBeVisible();
    await expect(page.getByText("O Goshi")).toHaveCount(0);
  });

  await step(page, "the yellow belt page links each topic into the view", async () => {
    await page.goto("/kb/yellow-belt");
    await expect(
      page.getByRole("heading", { name: "Yellow belt (7th Kyu)", level: 1 }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Throws, every belt up to Yellow" }).click();
    await expect(page).toHaveURL(/\/kb\/syllabus\?.*topic=throws/);
    await expect(page.getByText("Ko Soto Gari")).toBeVisible();
  });
});
