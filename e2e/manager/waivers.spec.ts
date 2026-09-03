// A manager opens the waivers screen and sees what the club has been sent.

import { expect, test } from "../support/test";
import { readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

test("the manager sidebar reaches the waivers screen", async ({ page }) => {
  await page.goto("/account");

  await page.getByRole("link", { name: "Signed waivers" }).click();

  await expect(page).toHaveURL(/\/manager\/waivers$/);
  await expect(page.getByRole("heading", { name: "Waivers", level: 1 })).toBeVisible();
  await expectPageRendered(page);
});

test("the waivers screen lists the club's submissions", async ({ page }) => {
  const fixture = readClubFixture();
  await page.goto("/manager/waivers");

  // THREE rows carry the member's address, not one. A person on somebody else's
  // account has no address of their own, so the address submitted on their
  // waiver is their guardian's, and the seeded member is a parent of two.
  // That is a fact about the club rather than a bug, and it is exactly why
  // "one row per address" stopped being a safe thing to assert.
  //
  // Derived from the fixture rather than written as `3`, so a seed that gains
  // or loses a child updates this instead of failing it.
  const household = fixture.household;
  if (!household) throw new Error("the seeded club has no household: re-run the seed");
  const children = household.children;
  const rows = page.getByRole("row").filter({ hasText: fixture.personas.member.email });
  await expect(rows).toHaveCount(children.length + 1);

  // The seeded member's own waiver is approved and their latest, so the screen
  // derives it as the one in force. (The displayed status is derived, not
  // stored — see docs/waivers.md.)
  let own = rows;
  for (const child of children) own = own.filter({ hasNotText: child.name.split(" ")[0] });
  await expect(own).toHaveCount(1);
  await expect(own).toContainText("active");

  // And each child's waiver is listed under that child's own name, which is the
  // half a manager needs in order to tell them apart at all. The row also says
  // whose account they are on, which is what the address beside it belongs to.
  const guardianName = household.guardianName;
  for (const child of children) {
    const row = rows.filter({ hasText: child.name.split(" ")[0] });
    await expect(row).toHaveCount(1);
    // WHOSE account, not merely that a caption rendered: a row pointing every
    // child at the wrong guardian would satisfy the weaker assertion.
    await expect(row).toContainText(`On ${guardianName}'s account`);
    // ...and the frozen address is captioned as belonging to that same person.
    await expect(row).toContainText(`(${guardianName}'s)`);
  }
});
