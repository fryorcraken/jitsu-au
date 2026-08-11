// A manager works the club's money: seeing invoices, raising one, recording a
// payment, and cancelling/reopening a membership.

import { expect, test } from "@playwright/test";

import { adminClient, applicantUserId, readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

/** Every membership these tests create or arrange, removed once in afterAll. */
const createdMembershipIds: string[] = [];

let applicantId: string;

test.beforeAll(async () => {
  applicantId = await applicantUserId();
});

test.afterAll(async () => {
  if (createdMembershipIds.length === 0) return;
  await adminClient().from("memberships").delete().in("id", createdMembershipIds);
});

test("the manager sidebar reaches the memberships screen", async ({ page }) => {
  await page.goto("/account");

  await page.getByRole("link", { name: "Memberships" }).click();

  await expect(page).toHaveURL(/\/manager\/memberships$/);
  await expect(page.getByRole("heading", { name: "Memberships", level: 1 })).toBeVisible();
  await expectPageRendered(page);
});

test("the memberships screen lists the club's invoices", async ({ page }) => {
  const fixture = readClubFixture();
  await page.goto("/manager/memberships");

  // The seeded member's period-plan invoice: active, and already paid.
  const row = page.getByRole("row").filter({ hasText: "JITSU-000101" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(fixture.personas.member.email);
  await expect(row).toContainText("active");
});

test("a manager can raise a membership, mark it paid, and then can't delete it", async ({
  page,
}) => {
  await page.goto(`/manager/users/${applicantId}`);

  await page.getByRole("button", { name: "Add a membership" }).click();
  // Selected by the plan's stable code rather than its formatted label (name
  // + price), which would otherwise tie this to a price nobody is testing.
  await page.getByLabel("Plan").selectOption("casual_session");
  await page.getByRole("checkbox", { name: "Email them the payment instructions" }).uncheck();
  await page.getByRole("button", { name: "Add membership" }).click();

  // Tracked before any assertion that could throw, so a failed assertion
  // below still leaves this row queued for afterAll to remove.
  const { data: created } = await adminClient()
    .from("memberships")
    .select("id, payment_reference")
    .eq("user_id", applicantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!created) throw new Error("raising the membership did not create a row");
  createdMembershipIds.push(created.id);

  // Matched on the reference rather than the plan name: text like "Casual
  // class" can also turn up elsewhere on this page (another membership's
  // "Move to..." dropdown lists every plan by name), but a reference is
  // unique to this one row.
  const row = page.getByRole("row").filter({ hasText: created.payment_reference });
  await expect(row).toHaveCount(1);

  await row.getByRole("button", { name: "Mark as paid" }).click();
  const payDialog = page.getByRole("alertdialog");
  await expect(payDialog).toContainText("Record payment for Casual class?");
  await payDialog.getByRole("button", { name: "Mark as paid" }).click();

  // Paid, so the button that recorded it is gone...
  await expect(row.getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  // ...and the record is now permanent: only Cancel can close it from here.
  const deleteButton = row.getByRole("button", { name: "Delete" });
  await expect(deleteButton).toBeDisabled();
  await expect(deleteButton).toHaveAttribute(
    "title",
    /a payment is recorded against it.*Cancel it instead/,
  );
});

test("a manager can cancel and reopen a membership", async ({ page }) => {
  const { data: plan } = await adminClient()
    .from("membership_plans")
    .select("id")
    .eq("code", "casual_session")
    .single();
  if (!plan) throw new Error("no seeded casual_session plan");

  const reference = `E2E-CANCEL-${crypto.randomUUID().slice(0, 8)}`;
  const { data: created, error } = await adminClient()
    .from("memberships")
    .insert({
      user_id: applicantId,
      plan_id: plan.id,
      status: "active",
      price_cents: 3000,
      payment_reference: reference,
      payment_method: "bank_transfer",
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`could not arrange a membership: ${error?.message}`);
  createdMembershipIds.push(created.id);

  await page.goto("/manager/memberships");
  const row = page.getByRole("row").filter({ hasText: reference });

  await row.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel membership" }).click();
  await expect(row).toContainText("cancelled");

  await row.getByRole("button", { name: "Reopen" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Reopen" }).click();
  await expect(row).toContainText("active");
});
