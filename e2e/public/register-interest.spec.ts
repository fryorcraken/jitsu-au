// The club's front door: a prospective member leaves their details and is
// offered the waiver as the next step.

import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixture";

/**
 * A fresh address per run, so a re-run against a local stack that was never
 * torn down is not filed as the same person twice.
 */
const email = `e2e-${crypto.randomUUID()}@example.com`;

// The seeded club is shared, and a lead nobody removed shows up on the
// manager's screens for every later run.
test.afterAll(async () => {
  await adminClient().from("interest_registrations").delete().eq("email", email);
});

test("registering interest lands the lead and offers the waiver", async ({ page }) => {
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
