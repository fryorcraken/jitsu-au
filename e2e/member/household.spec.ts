// A parent and their family: the flow #102 exists to make possible.
//
// The member persona is a parent of two children, neither of whom has a login.
// What is proved here is the part no unit test can: that a real signed-in
// parent can reach a child's records from their own account page and buy that
// child a plan, and that the invoice it raises is the CHILD's, delivered to the
// parent.
//
// The two children share a surname and a guardian on purpose. A family with one
// child never exercises the thing that went wrong: two people who look alike in
// a list.

import { expect, test } from "../support/test";
import { adminClient, readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

/**
 * Clean up after the purchase test.
 *
 * Keyed on the CHILDREN rather than on references collected as the test goes:
 * a failure between the two purchases would leave the first one behind, and
 * this file's whole subject is that there are two of them. `casual_session` is
 * the only plan bought here, and the seeded children hold none of their own, so
 * this removes exactly what the run added. The insurance the bundle raises
 * alongside it shares the same reference, so it goes too.
 */
test.afterAll(async () => {
  const admin = adminClient();
  const fixture = readClubFixture();
  const children = fixture.household?.children ?? [];
  if (children.length === 0) return;
  const { data: rows } = await admin
    .from("memberships")
    .select("payment_reference")
    .in(
      "user_id",
      children.map((c) => c.userId),
    );
  const references = [...new Set((rows ?? []).map((r) => r.payment_reference))];
  if (references.length === 0) return;
  await admin.from("memberships").delete().in("payment_reference", references);
});

/** The seeded family, or a failure that says which half of the setup is missing. */
function household() {
  const fixture = readClubFixture();
  if (!fixture.household) {
    throw new Error(
      "the seeded club has no household: re-run scripts/seed-local-club.mjs to write one",
    );
  }
  return fixture.household;
}

test("a parent sees both children on their account", async ({ page }) => {
  const { children } = household();

  await page.goto("/account");

  // Located by its own words rather than by role: `Card` is a plain <div> and
  // `CardTitle` is not a heading, so there is no `region` to scope to.
  await expect(page.getByText("People on your account")).toBeVisible();
  for (const child of children) {
    await expect(page.getByRole("link", { name: new RegExp(child.name) })).toBeVisible();
  }
  await expectPageRendered(page);
});

test("a parent opens a child and gets that child's records, not their own", async ({ page }) => {
  const [child] = household().children;

  await page.goto("/account");
  await page
    .getByRole("link", { name: new RegExp(child.name) })
    .first()
    .click();

  await expect(page).toHaveURL(new RegExp(`/account/${child.userId}$`));
  // The page speaks ABOUT the child rather than to them: a nine-year-old is not
  // reading this, and a card that said "your details" over a child's record is
  // how a parent comes to answer a question as though it were about themselves.
  await expect(page.getByRole("heading", { name: child.name, level: 1 })).toBeVisible();
  await expectPageRendered(page);
});

/** Buy the casual plan for one named child, through the page. */
async function buyCasualFor(page: import("@playwright/test").Page, childName: string) {
  await page.goto("/membership");

  // The question comes before the plans, so this is the first thing a parent
  // answers. Choosing a child re-points the whole page at them.
  const who = page.getByRole("group", { name: "Who is this for?" });
  await expect(who).toBeVisible();
  const firstName = childName.split(" ")[0];
  await who.getByRole("button", { name: firstName }).click();

  // Asserted BEFORE buying: a purchase made while the page still said "You"
  // would be the parent's, and the screen afterwards looks identical either way.
  await expect(who.getByRole("button", { name: firstName })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const heading = page.getByRole("heading", { name: "Casual class", level: 3 });
  const card = heading.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
  // Named for the child, not "Choose & pay by transfer": the whole page takes
  // the subject's voice, so the button a parent presses says whose plan it is.
  // Asserting the child's name here is the point rather than an inconvenience.
  await card.getByRole("button", { name: `Choose for ${firstName} & pay by transfer` }).click();

  // Buying for somebody else ASKS first, and buying for yourself does not, which
  // is why `member/membership.spec.ts` has no equivalent of this. The dialog is
  // the point: a plan raised against the wrong child is an invoice, an email and
  // a membership under the wrong name, so the confirm says whose it is before
  // the money exists. Asserting its wording is asserting that guarantee.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`This is for ${firstName}, not for you.`);
  await dialog.getByRole("button", { name: `Yes, for ${firstName}` }).click();

  await expect(page.getByText("How to pay")).toBeVisible();
}

test("a parent buys for both children, and each gets their own invoice", async ({ page }) => {
  // #102's "done when", end to end: two children on one email produce two
  // people, two invoices, and two DIFFERENT payment references. A parent making
  // two transfers has to be able to say which is which, and a manager matching
  // a bank line has to land on the right child.
  const { children } = household();
  const { data: casualPlan } = await adminClient()
    .from("membership_plans")
    .select("id")
    .eq("code", "casual_session")
    .single();
  if (!casualPlan) throw new Error("no seeded casual_session plan");

  for (const child of children) await buyCasualFor(page, child.name);

  // What proves it. Each row has to belong to the CHILD it was bought for: a
  // membership raised against the parent, or both against the same child, is
  // exactly the bug #102 is about, and the screen looks identical either way.
  const { data: rows } = await adminClient()
    .from("memberships")
    .select("user_id, price_cents, payment_reference, created_at")
    .in(
      "user_id",
      children.map((c) => c.userId),
    )
    .eq("plan_id", casualPlan.id)
    .order("created_at", { ascending: false });
  if (!rows) throw new Error("could not read back the invoices");

  const byChild = new Map<string, string>();
  for (const child of children) {
    const row = rows.find((r) => r.user_id === child.userId);
    expect(row, `no invoice was raised for ${child.name}`).toBeTruthy();
    expect(row!.price_cents).toBe(3000);
    byChild.set(child.userId, row!.payment_reference);
  }

  // `buildPaymentReference` mixes in `stableCode(userId)`, so two siblings on
  // one plan sharing a surname still get references that differ. This is the
  // assertion that would fail if the second child had quietly attached to the
  // first person record, which is the whole failure #102 describes.
  expect(new Set(byChild.values()).size).toBe(byChild.size);

  await expectPageRendered(page);
});
