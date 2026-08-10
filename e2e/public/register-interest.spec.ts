// The club's front door: a prospective member leaves their details and is
// offered the waiver as the next step.

import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixture";

/**
 * Every address this file has filed, so they can all be cleaned up.
 *
 * The seeded club is shared, and a lead nobody removed shows up on the
 * manager's screens for every later run.
 */
const filed: string[] = [];

test.afterAll(async () => {
  if (filed.length === 0) return;
  await adminClient().from("interest_registrations").delete().in("email", filed);
});

test("registering interest lands the lead and offers the waiver", async ({ page }) => {
  // A fresh address per ATTEMPT, not per file. A retry re-runs this body but
  // not the module around it, and `interest_registrations` has no unique
  // constraint on the address — so a shared one would file the same person
  // twice and the read-back below would find two rows and throw, turning the
  // one flake the retry exists to absorb into a hard failure.
  const email = `e2e-${crypto.randomUUID()}@example.com`;
  filed.push(email);

  await page.goto("/register-interest");

  await page.getByLabel("First name").fill("Jo");
  await page.getByLabel("Last name").fill("Nakamura");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Phone (optional)").fill("0400 000 999");
  await page
    .getByLabel("Got a question, or anything you'd like us to know?")
    .fill("Complete beginner, is Monday alright?");

  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: /You're on the list/ })).toBeVisible();

  // The waiver link carries what was just typed, so nobody types it twice.
  const waiverLink = page.getByRole("link", { name: "Sign my waiver" });
  await expect(waiverLink).toBeVisible();
  await expect(waiverLink).toHaveAttribute("href", new RegExp(encodeURIComponent(email)));

  // The screen says it worked; this is what proves it did. Read back through
  // the service role rather than trusting the confirmation copy.
  const { data } = await adminClient()
    .from("interest_registrations")
    .select("name, phone")
    .eq("email", email)
    .single();
  expect(data).toMatchObject({ name: "Jo Nakamura", phone: "0400 000 999" });
});
