// A member replaces the private calendar link they subscribe to.
//
// This is here rather than in a unit test because the proof is what the two
// URLs do afterwards: the token lives in the path of a feed that a calendar app
// fetches with no session at all, so only a real request against the real route
// can show that the old address has stopped carrying events and the new one has
// started. The route reads no session, only the token in the path, which is why
// fetching the URL is a complete test of it.
//
// It cleans up after itself by construction: the member ends the test holding
// one live link, the same as they started with.

import { expect, step, test } from "../support/test";
import { expectPageRendered } from "../support/page";

test("a member replaces their calendar link and the old one stops working", async ({ page }) => {
  // Lazy, so the same locator reads the new link after it has been replaced.
  const linkText = page.locator("code", { hasText: "/api/calendar/" }).first();

  const oldUrl = await step(
    page,
    "a member finds their calendar link on their account",
    async () => {
      await page.goto("/account");
      await expect(page.getByRole("heading", { name: "Your account", level: 1 })).toBeVisible();
      await expectPageRendered(page);
      const url = await linkText.innerText();
      expect(url).toContain("/api/calendar/");

      // Proves the starting state is real: a working subscription, not just a
      // string on a page.
      const before = await page.request.get(url);
      expect(before.status()).toBe(200);
      expect(await before.text()).toContain("BEGIN:VCALENDAR");
      return url;
    },
  );

  await step(page, "the confirm says what replacing it will break", async () => {
    await page.getByRole("button", { name: "Replace link" }).click();
    // Irreversible, and it stops a subscription they already have, so the
    // dialog says that in words before the click. This step's photograph is it.
    await expect(page.getByRole("alertdialog")).toContainText(
      "Your current link stops working straight away",
    );
  });

  const newUrl = await step(
    page,
    "the new link is on screen, ready to subscribe with",
    async () => {
      await page.getByRole("alertdialog").getByRole("button", { name: "Replace link" }).click();
      await expect(page.getByText("This is your new link.")).toBeVisible();
      await expect(linkText).not.toHaveText(oldUrl);
      return await linkText.innerText();
    },
  );

  await step(page, "the old link has stopped, and the new one works", async () => {
    // The whole point of the feature. `page.request` does send the context's
    // cookies, so this is not proof that an anonymous caller is refused; it does
    // not need to be, because the feed route reads no session at all and
    // resolves everything from the token in the path.
    const retired = await page.request.get(oldUrl);
    expect(retired.status()).toBe(410);
    expect(await retired.text()).toContain("replaced");

    const fresh = await page.request.get(newUrl);
    expect(fresh.status()).toBe(200);
    expect(await fresh.text()).toContain("BEGIN:VCALENDAR");
  });
});
