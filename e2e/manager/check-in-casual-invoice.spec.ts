// A casual credit gets spent at the door, and the check-in guarantees an
// invoice for it — even though this credit was already raised (and could
// already have had its own email skipped or lost) before the person walked in.
//
// The suite has no email transport to assert against (no `LOVABLE_API_KEY` in
// the local stack, by design — see docs/e2e-tests.md), so what this proves is
// the part that IS observable end to end: `applyCoverage` resolves the casual
// credit, spends it, and reaches `ensureCasualInvoiceEmailed` without the door
// screen failing or stalling. `membership.functions.test.ts` pins which email
// that reaches for and with what.

import { expect, test } from "@playwright/test";

import { adminClient, readClubFixture } from "../support/fixture";
import { expectPageRendered } from "../support/page";

test("checking in on a casual credit spends it and never fails the door", async ({ page }) => {
  const fixture = readClubFixture();
  const admin = adminClient();

  const { data: plan, error: planErr } = await admin
    .from("membership_plans")
    .select("id, name, public_price_cents")
    .eq("code", "casual_session")
    .maybeSingle();
  if (planErr || !plan) throw new Error(`no casual_session plan seeded: ${planErr?.message}`);

  // A casual invoice exactly as `enrolMember` raises one — unpaid, one credit —
  // arranged directly so this test proves what the CHECK-IN does with it, not
  // how it got there. The seeded member otherwise holds an unlimited semester,
  // which the door would draw on instead if this credit did not outrank it.
  const { data: membership, error: insErr } = await admin
    .from("memberships")
    .insert({
      user_id: fixture.personas.member.userId,
      plan_id: plan.id,
      status: "active",
      price_cents: plan.public_price_cents,
      payment_reference: `E2E-CASUAL-${crypto.randomUUID()}`,
      payment_method: "bank_transfer",
      sessions_remaining: 1,
      session_date: new Date().toISOString().slice(0, 10),
    })
    .select("id")
    .single();
  if (insErr || !membership) throw new Error(`could not seed a casual credit: ${insErr?.message}`);

  try {
    await page.goto("/manager/check-in");
    await expect(page.getByRole("heading", { name: "Check in", level: 1 })).toBeVisible();
    await expectPageRendered(page);

    // The class picker fills in once `listCheckInEvents` resolves; only then is
    // there a roster to search.
    await expect(page.locator("#class-picker")).not.toHaveValue("", { timeout: 15_000 });

    await page.getByPlaceholder("Search by name or email").fill(fixture.personas.member.email);
    const checkInButton = page.getByRole("button", { name: "Check in" });
    await expect(checkInButton).toHaveCount(1);
    await checkInButton.click();

    // The door's own confirmation that the casual credit, not the semester
    // pass, is what paid for this — durable in the "Here now" table, unlike the
    // toast that follows it.
    const hereNow = page.locator("div.space-y-2", {
      has: page.getByRole("heading", { name: /^Here now/ }),
    });
    const coveredRow = hereNow.getByRole("row").filter({ hasText: plan.name });
    await expect(coveredRow).toHaveCount(1);

    // What the door screen cannot show: the credit this check-in just spent
    // reached `ensureCasualInvoiceEmailed` cleanly. Read back the same way
    // `applyCoverage` writes it.
    const { data: checkin } = await admin
      .from("session_checkins")
      .select("coverage, membership_id, consumed_credit")
      .eq("user_id", fixture.personas.member.userId)
      .eq("membership_id", membership.id)
      .maybeSingle();
    expect(checkin).toMatchObject({
      coverage: "session",
      membership_id: membership.id,
      consumed_credit: true,
    });

    // The credit is spent, and a one-credit casual closes itself.
    const { data: spent } = await admin
      .from("memberships")
      .select("sessions_remaining, status")
      .eq("id", membership.id)
      .maybeSingle();
    expect(spent).toMatchObject({ sessions_remaining: 0, status: "expired" });
  } finally {
    // The seeded club is shared: leave nothing behind for the next run to trip
    // over — a stale check-in would collide with `UNIQUE (event_id, user_id)`
    // the next time this member is checked in, on any class.
    await admin.from("session_checkins").delete().eq("membership_id", membership.id);
    await admin.from("memberships").delete().eq("id", membership.id);
  }
});
