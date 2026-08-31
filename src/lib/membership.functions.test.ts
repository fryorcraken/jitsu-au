// A failed query must never be indistinguishable from "there is nothing there".
//
// Two helpers here are reachable from a unit test, because both are plain
// functions rather than `createServerFn` handlers — a handler called from the
// runner dies on "No Start context found in AsyncLocalStorage" before it reaches
// any of its reads.
//
// `assignTrialMembership`: the same two reads decide whether the club HAS a free
// trial and whether this person has already had one. Swallowing either error
// turns a database blip into a silent product decision: no trial for someone who
// just got approved, or a second free trial for someone who already trained on
// their first.
//
// `reconcileUnmatched`: takes its client as a parameter, so the import path can
// be driven end to end. It is also where the opposite rule is pinned — the count
// taken AFTER the matching has committed degrades to null instead of throwing
// away a reconciliation that worked.
//
// The list screens (`listClubUsers`, the manager agent API) and the guards inside
// `startMembership` share the defect but not the seam; see issue #72 on whether
// route/server-function tests get built.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPaymentReference } from "./validation";

type Result = { data: unknown; error: { message: string } | null };

const ok = (data: unknown): Result => ({ data, error: null });
const fails = (message: string): Result => ({ data: null, error: { message } });

const TRIAL_PLAN = {
  id: "plan-trial",
  code: "trial",
  name: "Free trial",
  kind: "trial",
  is_active: true,
  session_credits: null,
  price_cents: 0,
};

/**
 * A fake service-role client covering exactly the chains the trial assignment
 * walks. Each read is supplied per-test so a single one can be made to fail
 * while the rest succeed — the shape of a real outage.
 *
 * `activePaid`/`rolePlans` are the two reads `syncMemberRole` makes at the end
 * of every activation; `roleWrites` records which way it went so a test can
 * assert on the label without a roles table to inspect.
 */
function fakeAdmin(reads: {
  trialPlans?: Result;
  existingTrial?: Result;
  profile?: Result;
  activePaid?: Result;
  rolePlans?: Result;
  roleWriteFails?: boolean;
}) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const roleWrites: ("grant" | "revoke")[] = [];
  const roleResult = reads.roleWriteFails ? fails("deadlock detected") : ok(null);

  const trialPlans = reads.trialPlans ?? ok([TRIAL_PLAN]);
  const existingTrial = reads.existingTrial ?? ok(null);
  const profile = reads.profile ?? ok({ first_name: "Ada", last_name: "Lovelace" });
  // Default: the trial is all they hold, so the label comes off.
  const activePaid = reads.activePaid ?? ok([]);
  const rolePlans = reads.rolePlans ?? ok([]);
  const inserted = ok({ id: "mem-1", user_id: "user-1", plan_id: TRIAL_PLAN.id, price_cents: 0 });

  const admin = {
    from: (table: string) => ({
      select: () => {
        if (table === "membership_plans") {
          return {
            // The trial-plan lookup...
            eq: () => Promise.resolve(trialPlans),
            // ...and syncMemberRole resolving the kinds behind active invoices.
            in: () => Promise.resolve(rolePlans),
          };
        }
        if (table === "profiles") {
          return { eq: () => ({ maybeSingle: () => Promise.resolve(profile) }) };
        }
        // memberships, reached two ways: the "have they had a trial before"
        // guard (.eq.in.limit.maybeSingle) and syncMemberRole's active-and-paid
        // read (.eq.eq.gt).
        return {
          eq: () => ({
            in: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(existingTrial) }) }),
            eq: () => ({ gt: () => Promise.resolve(activePaid) }),
          }),
        };
      },
      insert: (row: unknown) => {
        inserts.push(row);
        return { select: () => ({ single: () => Promise.resolve(inserted) }) };
      },
      update: (patch: unknown) => {
        updates.push(patch);
        return { eq: () => Promise.resolve(ok(null)) };
      },
      upsert: () => {
        roleWrites.push("grant");
        return Promise.resolve(roleResult);
      },
      delete: () => ({
        eq: () => ({
          eq: () => {
            roleWrites.push("revoke");
            return Promise.resolve(roleResult);
          },
        }),
      }),
    }),
  };

  return { admin, inserts, updates, roleWrites };
}

/** The module under test lazy-imports the admin client; hand it the fake. */
let currentAdmin: unknown;
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentAdmin;
  },
}));

/**
 * The actual send is a server-only network call (`ensureCasualInvoiceEmailed`
 * tests care only about WHICH of the two it reaches for, and with what), so
 * the transport is mocked rather than routed through `LOVABLE_API_KEY`.
 */
const sendMembershipPaymentEmail = vi.fn().mockResolvedValue({ sent: [], skipped: false });
const sendMembershipPaidEmail = vi.fn().mockResolvedValue({ sent: true, skipped: false });
vi.mock("./membership-email.server", () => ({
  sendMembershipPaymentEmail: (...args: unknown[]) => sendMembershipPaymentEmail(...args),
  sendMembershipPaidEmail: (...args: unknown[]) => sendMembershipPaidEmail(...args),
}));

/** 18:05 Sydney on 5 Aug: signed at the door, minutes after the class began. */
const SIGNED_AT = "2026-08-05T08:05:00.000Z";

async function assignTrial(fake: ReturnType<typeof fakeAdmin>, signedAt = SIGNED_AT) {
  currentAdmin = fake.admin;
  const { assignTrialMembership } = await import("./membership.functions");
  return assignTrialMembership("user-1", signedAt);
}

describe("assignTrialMembership", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Authorised by the INSERT itself, not by a follow-up update. That ordering
  // is the point: an `active` row with no dates is one `isLive` reads as
  // running forever, and splitting the two left exactly that gap open.
  it("assigns the trial already authorised", async () => {
    const fake = fakeAdmin({});
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({
      user_id: "user-1",
      plan_id: TRIAL_PLAN.id,
      status: "active",
    });
    expect(fake.updates).toHaveLength(0);
  });

  // The free trial is free, so there is no payment to record. Authorising it
  // used to stamp `paid_at`, which is what made a trial read as paid for and
  // therefore undeletable.
  it("records no payment against a free trial", async () => {
    const fake = fakeAdmin({});
    await assignTrial(fake);
    expect(fake.inserts[0]).not.toHaveProperty("paid_at");
  });

  // The trial records when the entitlement was earned, not when a manager got
  // round to approving it: a form filled in at the gym may be approved hours or
  // days later. So it runs from the start of the SIGNING day (00:00 Sydney on
  // 5 Aug = 4 Aug 14:00 UTC). Coverage does not depend on this -- a credit
  // balance is not date-gated -- but the row should still say something true.
  it("runs the trial from the day the waiver was signed, not the day it was approved", async () => {
    const fake = fakeAdmin({});
    await assignTrial(fake);
    expect(fake.inserts[0]).toMatchObject({
      status: "active",
      starts_at: "2026-08-04T14:00:00.000Z",
      ends_at: null,
    });
  });

  it("skips someone who has already had a trial", async () => {
    const fake = fakeAdmin({ existingTrial: ok({ id: "mem-old" }) });
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(0);
  });

  it("skips silently when the club has no trial plan", async () => {
    const fake = fakeAdmin({ trialPlans: ok([]) });
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(0);
  });

  // The two that used to pass silently.
  it("throws rather than granting a second trial when the guard read fails", async () => {
    const fake = fakeAdmin({ existingTrial: fails("connection reset") });
    await expect(assignTrial(fake)).rejects.toThrow("connection reset");
    expect(fake.inserts).toHaveLength(0);
  });

  it("throws rather than skipping the trial when the plan read fails", async () => {
    const fake = fakeAdmin({ trialPlans: fails("permission denied for table membership_plans") });
    await expect(assignTrial(fake)).rejects.toThrow("permission denied");
    expect(fake.inserts).toHaveLength(0);
  });

  it("throws when the profile read fails rather than mislabelling the payment reference", async () => {
    const fake = fakeAdmin({ profile: fails("statement timeout") });
    await expect(assignTrial(fake)).rejects.toThrow("statement timeout");
    expect(fake.inserts).toHaveLength(0);
  });
});

// ---- The `member` label ----
//
// Reconciled at the end of every activation (and, once cancelling and deleting
// exist, after those too). It is a LABEL — the manager directory and the agent
// API's `list_users` read it — not the access gate; members-only areas are gated
// live by the `has_active_paid_membership` SQL helper. Which is exactly why it
// could drift: nothing ever took it back.
describe("syncMemberRole, via activation", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grants the label when a paid, non-trial membership is active", async () => {
    const fake = fakeAdmin({
      activePaid: ok([{ plan_id: PAID_PLAN.id }]),
      rolePlans: ok([{ id: PAID_PLAN.id, kind: "period" }]),
    });
    await assignTrial(fake);
    expect(fake.roleWrites).toEqual(["grant"]);
  });

  // The free trial is not membership. Someone holding only a trial reads as a
  // visitor everywhere else, so the label must agree.
  it("takes the label back when only a trial is active", async () => {
    const fake = fakeAdmin({
      activePaid: ok([{ plan_id: TRIAL_PLAN.id }]),
      rolePlans: ok([{ id: TRIAL_PLAN.id, kind: "trial" }]),
    });
    await assignTrial(fake);
    expect(fake.roleWrites).toEqual(["revoke"]);
  });

  it("takes the label back when nothing is active at all", async () => {
    const fake = fakeAdmin({ activePaid: ok([]) });
    await assignTrial(fake);
    expect(fake.roleWrites).toEqual(["revoke"]);
  });

  // The case that must never become a mass revocation: a read that fell over is
  // not the same answer as "they hold nothing".
  it("leaves the label alone when the membership read fails", async () => {
    const fake = fakeAdmin({ activePaid: fails("connection reset") });
    await assignTrial(fake);
    expect(fake.roleWrites).toEqual([]);
  });

  it("leaves the label alone when the plan read fails", async () => {
    const fake = fakeAdmin({
      activePaid: ok([{ plan_id: PAID_PLAN.id }]),
      rolePlans: fails("statement timeout"),
    });
    await assignTrial(fake);
    expect(fake.roleWrites).toEqual([]);
  });

  // The membership has already committed by the time the label is reconciled,
  // so a failed role write is logged, never thrown: throwing would report a
  // successful assignment as an error and invite a retry.
  it("does not fail the assignment when the label cannot be written", async () => {
    const fake = fakeAdmin({ activePaid: ok([]), roleWriteFails: true });
    await expect(assignTrial(fake)).resolves.toBeUndefined();
    expect(fake.inserts[0]).toMatchObject({ status: "active" });
  });
});

// ---- Bank reconciliation ----

const PAID_PLAN = {
  id: "plan-monthly",
  code: "monthly",
  name: "Monthly",
  kind: "monthly",
  is_active: true,
  session_credits: null,
  price_cents: 5000,
};

/** A pending invoice and the statement line that pays it, by reference + amount. */
const PENDING = {
  id: "mem-1",
  user_id: "user-1",
  plan_id: PAID_PLAN.id,
  status: "pending",
  payment_reference: "MEMSMITHAB12",
  price_cents: 5000,
  payment_method: "bank_transfer",
};
const TXN = {
  id: "txn-1",
  status: "unmatched",
  // Banks reformat references, so the match normalizes both sides.
  description: "OSKO PAYMENT mem-smith ab12",
  reference: null,
  amount_cents: 5000,
};

const counted = (count: number) => ({ count, error: null });
const countFails = (message: string) => ({ count: null, error: { message } });

/**
 * A fake service-role client for the reconciliation path. The `user_emails` RPC
 * always fails, which is the existing deliberate degradation: no address means
 * the confirmation email is skipped, which keeps the email module out of this
 * test without stubbing it.
 */
function fakeReconcileAdmin(reads: {
  txns?: Result;
  pending?: Result;
  plans?: Result;
  count?: { count: number | null; error: { message: string } | null };
  // What syncMemberRole sees when it reconciles the label after each activation.
  activePaid?: Result;
  // Forces the `memberships` row with this id to fail its activation update,
  // so a per-row failure can be exercised without a second table to break.
  brokenActivationId?: string;
  /** Makes every payment compare-and-swap lose, as if somebody got there first. */
  paymentLost?: boolean;
}) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];

  const admin = {
    rpc: () => Promise.resolve(fails("user_emails unavailable")),
    from: (table: string) => ({
      select: (_cols: string, opts?: { head?: boolean }) => {
        if (table === "bank_transactions") {
          // The trailing tally is the same table as the initial list; the
          // head/count options are what tell them apart.
          return opts?.head
            ? { eq: () => Promise.resolve(reads.count ?? counted(0)) }
            : { eq: () => Promise.resolve(reads.txns ?? ok([TXN])) };
        }
        if (table === "memberships") {
          // Two readers share this table: reconciliation lists the UNPAID
          // invoices (`.is("paid_at", null).neq("status", ...)`, awaited), and
          // syncMemberRole narrows to active and paid (`.eq.eq.gt`).
          const pending = reads.pending ?? ok([]);
          return {
            // The unpaid pool: .is(paid_at, null).neq(status, cancelled).gt(price_cents, 0)
            is: () => ({ neq: () => ({ gt: () => Promise.resolve(pending) }) }),
            // syncMemberRole's tally: .eq.eq.gt
            eq: () => ({ eq: () => ({ gt: () => Promise.resolve(reads.activePaid ?? ok([])) }) }),
          };
        }
        if (table === "membership_plans")
          return { in: () => Promise.resolve(reads.plans ?? ok([PAID_PLAN])) };
        if (table === "profiles")
          return { eq: () => ({ maybeSingle: () => Promise.resolve(ok(null)) }) };
        throw new Error(`unexpected select on ${table}`);
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: unknown) => {
          const broken = col === "id" && val === reads.brokenActivationId;
          if (!broken) updates.push({ table, patch });
          // Awaitable for the bank_transactions write, and chainable for
          // recordMembershipPayment's compare-and-swap
          // (`.eq("id").is("paid_at", null).select("id")`), whose empty result
          // is how a second caller learns it lost the race.
          return Object.assign(Promise.resolve(broken ? fails("constraint violation") : ok(null)), {
            is: () => ({
              select: () =>
                Promise.resolve(
                  broken
                    ? fails("constraint violation")
                    : ok(reads.paymentLost ? [] : [{ id: val }]),
                ),
            }),
          });
        },
      }),
      upsert: () => Promise.resolve(ok(null)),
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve(ok(null)) }) }),
    }),
  };

  return { admin, updates };
}

async function reconcile(fake: ReturnType<typeof fakeReconcileAdmin>) {
  const { reconcileUnmatched } = await import("./membership.functions");
  return reconcileUnmatched(fake.admin as never);
}

describe("reconcileUnmatched", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches a statement line to its pending invoice and activates it", async () => {
    const fake = fakeReconcileAdmin({ pending: ok([PENDING]) });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    expect(fake.updates.some((u) => u.table === "memberships" && u.patch.paid_at != null)).toBe(
      true,
    );
    expect(
      fake.updates.some((u) => u.table === "bank_transactions" && u.patch.status === "matched"),
    ).toBe(true);
  });

  it("throws rather than answering an import with nothing to match", async () => {
    const fake = fakeReconcileAdmin({ pending: fails("statement timeout") });
    await expect(reconcile(fake)).rejects.toThrow("statement timeout");
  });

  it("throws when the unmatched transactions cannot be read", async () => {
    const fake = fakeReconcileAdmin({ txns: fails("connection reset") });
    await expect(reconcile(fake)).rejects.toThrow("connection reset");
  });

  // The tally runs after the matching has already committed, so it is the one
  // read that must NOT throw: reporting a reconciliation that worked as a failed
  // import would lose the matched count with it.
  it("keeps the matched count and reports an unknown tally when the count fails", async () => {
    const fake = fakeReconcileAdmin({
      pending: ok([PENDING]),
      count: countFails("could not obtain lock"),
    });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: null });
    expect(fake.updates.some((u) => u.table === "memberships" && u.patch.paid_at != null)).toBe(
      true,
    );
  });

  // The case an earlier version of this change would have failed: a dated
  // `period` plan must activate with ITS OWN dates, never a rolling guess —
  // and there is no second table to look them up in any more.
  const DATED_PLAN = {
    id: "plan-semester-2-2026",
    code: "semester_2_2026",
    name: "Semester 2 2026",
    kind: "period",
    is_active: true,
    session_credits: null,
    price_cents: 44500,
    starts_on: "2026-07-20",
    ends_on: "2026-11-22",
    duration_days: null,
  };
  const DATED_REFERENCE = buildPaymentReference("Jones", "user-2", undefined, DATED_PLAN.starts_on);
  const PENDING_DATED = {
    id: "mem-2",
    user_id: "user-2",
    plan_id: DATED_PLAN.id,
    status: "pending",
    payment_reference: DATED_REFERENCE,
    price_cents: 44500,
    payment_method: "bank_transfer",
  };
  const DATED_TXN = {
    id: "txn-2",
    status: "unmatched",
    // Banks reformat references, same as TXN above; the match normalizes both.
    description: `OSKO PAYMENT ${DATED_REFERENCE.toLowerCase()}`,
    reference: null,
    amount_cents: 44500,
  };

  // Reconciliation records money and touches nothing else. A membership's dates
  // were settled when it was raised, and a payment landing must not move them:
  // rewriting the window of a dated plan months into it is how somebody loses
  // the training period they already paid for. (The window itself is pinned by
  // `planMembershipWindow` in membership.test.ts.)
  it("records the payment on a dated plan without touching its window", async () => {
    const fake = fakeReconcileAdmin({
      txns: ok([DATED_TXN]),
      pending: ok([PENDING_DATED]),
      plans: ok([DATED_PLAN]),
    });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    const payment = fake.updates.find((u) => u.table === "memberships" && u.patch.paid_at != null);
    expect(payment).toBeTruthy();
    expect(payment!.patch).toEqual({
      paid_at: expect.any(String),
      payment_method: "bank_transfer",
    });
  });

  it("records the payment on a rolling plan without recomputing its window", async () => {
    const ROLLING_PLAN = {
      id: "plan-insurance-yearly",
      code: "insurance_yearly",
      name: "Yearly insurance",
      kind: "insurance",
      is_active: true,
      session_credits: null,
      price_cents: 6000,
      starts_on: null,
      ends_on: null,
      duration_days: 365,
    };
    const ROLLING_REFERENCE = buildPaymentReference("Ada", "user-6");
    const PENDING_ROLLING = {
      id: "mem-6",
      user_id: "user-6",
      plan_id: ROLLING_PLAN.id,
      status: "pending",
      payment_reference: ROLLING_REFERENCE,
      price_cents: 6000,
      payment_method: "bank_transfer",
    };
    const ROLLING_TXN = {
      id: "txn-6",
      status: "unmatched",
      description: `OSKO PAYMENT ${ROLLING_REFERENCE.toLowerCase()}`,
      reference: null,
      amount_cents: 6000,
    };
    const fake = fakeReconcileAdmin({
      txns: ok([ROLLING_TXN]),
      pending: ok([PENDING_ROLLING]),
      plans: ok([ROLLING_PLAN]),
    });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    const activation = fake.updates.find(
      (u) => u.table === "memberships" && u.patch.paid_at != null,
    );
    expect(activation).toBeTruthy();
    // Only money. The rolling window was set when the membership was raised.
    expect(activation!.patch).not.toHaveProperty("ends_at");
  });

  // One bad invoice's activation failing (e.g. a constraint the update itself
  // trips) must not abort every OTHER transaction in the same statement.
  // Without a per-row guard around the activation call, this one bad invoice
  // would throw out of the whole loop, leaving PENDING's transaction
  // unprocessed too even though nothing is wrong with it.
  it("does not let one broken invoice's activation failure block the rest of the import", async () => {
    const BROKEN_REFERENCE = buildPaymentReference("Broken", "user-3", undefined, undefined);
    const BROKEN_PENDING = {
      id: "mem-3",
      user_id: "user-3",
      plan_id: DATED_PLAN.id,
      status: "pending",
      payment_reference: BROKEN_REFERENCE,
      price_cents: 44500,
      payment_method: "bank_transfer",
    };
    const BROKEN_TXN = {
      id: "txn-3",
      status: "unmatched",
      description: `OSKO PAYMENT ${BROKEN_REFERENCE.toLowerCase()}`,
      reference: null,
      amount_cents: 44500,
    };

    const fake = fakeReconcileAdmin({
      txns: ok([TXN, BROKEN_TXN]),
      pending: ok([PENDING, BROKEN_PENDING]),
      plans: ok([PAID_PLAN, DATED_PLAN]),
      brokenActivationId: "mem-3",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    const activations = fake.updates.filter(
      (u) => u.table === "memberships" && u.patch.paid_at != null,
    );
    expect(activations).toHaveLength(1);
    const matchedTxns = fake.updates.filter(
      (u) => u.table === "bank_transactions" && u.patch.status === "matched",
    );
    expect(matchedTxns).toHaveLength(1);
  });

  // A membership bought with bundled insurance lands as TWO invoices sharing
  // one reference, settled by ONE transfer of the combined amount. Neither
  // invoice's own price matches that amount, and leaving a bundle unpaid just
  // because the member paid in one go would be the daily failure here.
  it("settles both halves of a reference-sharing bundle from one combined transfer", async () => {
    const bundleRef = buildPaymentReference("Nguyen", "user-4", undefined, undefined);
    const membershipRow = {
      id: "mem-4",
      user_id: "user-4",
      plan_id: PAID_PLAN.id,
      status: "pending",
      payment_reference: bundleRef,
      price_cents: 5000,
      payment_method: "bank_transfer",
    };
    const INSURANCE_PLAN = {
      id: "plan-insurance",
      code: "insurance_yearly",
      name: "Yearly insurance",
      kind: "insurance",
      is_active: true,
      session_credits: null,
      price_cents: 6000,
      starts_on: null,
      ends_on: null,
      duration_days: 365,
    };
    const insuranceRow = {
      id: "mem-5",
      user_id: "user-4",
      plan_id: INSURANCE_PLAN.id,
      status: "pending",
      payment_reference: bundleRef,
      price_cents: 6000,
      payment_method: "bank_transfer",
    };
    const BUNDLE_TXN = {
      id: "txn-4",
      status: "unmatched",
      description: `OSKO PAYMENT ${bundleRef.toLowerCase()}`,
      reference: null,
      amount_cents: 11000, // 5000 + 6000, the combined bundle total
    };

    const fake = fakeReconcileAdmin({
      txns: ok([BUNDLE_TXN]),
      pending: ok([membershipRow, insuranceRow]),
      plans: ok([PAID_PLAN, INSURANCE_PLAN]),
    });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    const activations = fake.updates.filter(
      (u) => u.table === "memberships" && u.patch.paid_at != null,
    );
    // Both halves settled by the one transfer, and each recorded as its own
    // payment so neither can be re-billed on its own later.
    expect(activations).toHaveLength(2);
    for (const a of activations) {
      expect(a.patch).toEqual({ paid_at: expect.any(String), payment_method: "bank_transfer" });
    }
  });

  // The same two invoices, but the member paid only the plan price: the bundle
  // rule must NOT fire (the transfer doesn't cover both), and the single
  // invoice match takes it.
  it("does not bundle-match when the transfer only covers one invoice", async () => {
    const bundleRef = buildPaymentReference("Nguyen", "user-4", undefined, undefined);
    const membershipRow = {
      id: "mem-4",
      user_id: "user-4",
      plan_id: PAID_PLAN.id,
      status: "pending",
      payment_reference: bundleRef,
      price_cents: 5000,
      payment_method: "bank_transfer",
    };
    const insuranceRow = {
      id: "mem-5",
      user_id: "user-4",
      plan_id: "plan-insurance",
      status: "pending",
      payment_reference: bundleRef,
      price_cents: 6000,
      payment_method: "bank_transfer",
    };
    const PARTIAL_TXN = {
      id: "txn-5",
      status: "unmatched",
      description: `OSKO PAYMENT ${bundleRef.toLowerCase()}`,
      reference: null,
      amount_cents: 5000, // covers the membership only
    };

    const fake = fakeReconcileAdmin({
      txns: ok([PARTIAL_TXN]),
      pending: ok([membershipRow, insuranceRow]),
      plans: ok([PAID_PLAN]),
    });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    // Exactly one invoice is activated (the membership), never the whole group.
    const activations = fake.updates.filter(
      (u) => u.table === "memberships" && u.patch.paid_at != null,
    );
    expect(activations).toHaveLength(1);
  });
});

// ---- Deleting a membership ----
//
// The only irreversible thing a manager can do to one, so the guards get a test
// at the level that actually runs them: the pure rule is pinned in
// membership.test.ts, this pins that the row is read, the check-ins are counted,
// and nothing is deleted when either says no.

const DELETABLE = {
  id: "mem-9",
  user_id: "user-9",
  status: "pending",
  paid_at: null,
  price_cents: 44500,
};

function fakeDeleteAdmin(reads: {
  membership?: Result;
  checkinCount?: { count: number | null; error: { message: string } | null };
  activePaid?: Result;
}) {
  const deletes: string[] = [];
  const membership = reads.membership ?? ok(DELETABLE);

  const admin = {
    from: (table: string) => ({
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (table === "session_checkins")
          return { eq: () => Promise.resolve(reads.checkinCount ?? counted(0)) };
        if (table === "membership_plans") return { in: () => Promise.resolve(ok([])) };
        void opts;
        // memberships, read two ways: the row under deletion, and
        // syncMemberRole's active-and-paid tally afterwards.
        return {
          eq: () => ({
            maybeSingle: () => Promise.resolve(membership),
            eq: () => ({ gt: () => Promise.resolve(reads.activePaid ?? ok([])) }),
          }),
        };
      },
      // `memberships` deletes with one .eq (the row); `user_roles` with two
      // (user + role), which is syncMemberRole taking the label back afterwards.
      delete: () => ({
        eq: (_col: string, val: unknown) => {
          if (table === "memberships") deletes.push(String(val));
          return Object.assign(Promise.resolve(ok(null)), {
            eq: () => Promise.resolve(ok(null)),
          });
        },
      }),
      upsert: () => Promise.resolve(ok(null)),
    }),
  };
  return { admin, deletes };
}

async function runDelete(fake: ReturnType<typeof fakeDeleteAdmin>, id = DELETABLE.id) {
  const { deleteMembershipRow } = await import("./membership.functions");
  return deleteMembershipRow(fake.admin as never, id);
}

describe("deleteMembershipRow", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes an unpaid, inactive membership nobody trained on", async () => {
    const fake = fakeDeleteAdmin({});
    await expect(runDelete(fake)).resolves.toEqual({ ok: true, id: DELETABLE.id });
    expect(fake.deletes).toContain(DELETABLE.id);
  });

  it("refuses, and deletes nothing, when a class was checked in against it", async () => {
    const fake = fakeDeleteAdmin({ checkinCount: counted(2) });
    await expect(runDelete(fake)).resolves.toEqual({ ok: false, blockers: ["attended"] });
    expect(fake.deletes).toEqual([]);
  });

  it("refuses a paid membership", async () => {
    const fake = fakeDeleteAdmin({
      membership: ok({ ...DELETABLE, paid_at: "2026-08-01T00:00:00Z" }),
    });
    await expect(runDelete(fake)).resolves.toEqual({ ok: false, blockers: ["paid"] });
    expect(fake.deletes).toEqual([]);
  });

  // The rule this codebase repeats everywhere: a failed read must not be
  // answered the same way as "there is nothing there" when the answer permits
  // something irreversible. A count that fell over must never read as
  // "nobody trained on this".
  it("throws rather than deleting when the check-in count cannot be read", async () => {
    const fake = fakeDeleteAdmin({ checkinCount: countFails("statement timeout") });
    await expect(runDelete(fake)).rejects.toThrow("statement timeout");
    expect(fake.deletes).toEqual([]);
  });

  it("throws rather than deleting when the membership itself cannot be read", async () => {
    const fake = fakeDeleteAdmin({ membership: fails("connection reset") });
    await expect(runDelete(fake)).rejects.toThrow("connection reset");
    expect(fake.deletes).toEqual([]);
  });

  it("reports a membership that is already gone rather than claiming a delete", async () => {
    const fake = fakeDeleteAdmin({ membership: ok(null) });
    await expect(runDelete(fake)).rejects.toThrow("Membership not found.");
    expect(fake.deletes).toEqual([]);
  });
});

// ---- Raising an enrolment twice ----
//
// A free plan does not wait for a payment: it is activated before the caller
// hears back. So a repeat — a retried submit, a double press, a reply that got
// lost — must resolve to the SAME row. A pending-only reuse guard would find
// nothing, insert a second membership, activate it, and send a second "your
// membership is active" email under a new id that the idempotency key cannot
// dedupe. Only the trial is caught by the once-ever rule, so a $0 casual or
// period plan had nothing catching it at all.

const FREE_PLAN = {
  id: "plan-free",
  code: "free_week",
  name: "Free intro week",
  kind: "period",
  is_active: true,
  session_credits: null,
  public_price_cents: 0,
  student_price_cents: null,
  starts_on: "2026-07-20",
  ends_on: "2026-11-22",
  duration_days: null,
};

function fakeEnrolAdmin(existing: Result) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];

  const admin = {
    rpc: () => Promise.resolve(fails("user_emails unavailable")),
    from: (table: string) => ({
      select: () => {
        if (table === "profiles")
          return { eq: () => ({ maybeSingle: () => Promise.resolve(ok({ last_name: "Lee" })) }) };
        if (table === "membership_plans") return { in: () => Promise.resolve(ok([])) };
        // memberships, two readers sharing a `.eq.eq` prefix: the reuse lookup
        // (`.is("paid_at", null).neq("status", "cancelled")[.eq(session)]
        // .limit.maybeSingle`) and syncMemberRole's tally (`.gt`).
        const found = { limit: () => ({ maybeSingle: () => Promise.resolve(existing) }) };
        return {
          eq: () => ({
            eq: () => ({
              // reuse: .is(paid_at, null).eq(status, active)[.eq(session_date)]
              is: () => ({ eq: () => ({ ...found, eq: () => found }) }),
              // syncMemberRole's tally
              gt: () => Promise.resolve(ok([])),
            }),
          }),
        };
      },
      insert: (row: unknown) => {
        inserts.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve(ok({ id: "mem-new", user_id: "user-1", price_cents: 0 })),
          }),
        };
      },
      update: (patch: unknown) => {
        updates.push(patch);
        // Two callers, two shapes: syncMemberRole awaits `.eq(...)` directly,
        // while the reuse path that moves a start date reads the moved row back
        // with `.eq(...).select("*").single()`. A thenable carrying `select`
        // serves both without the fake having to guess which one is calling.
        return {
          eq: () => {
            const p = Promise.resolve(ok(null)) as Promise<Result> & {
              select?: () => { single: () => Promise<Result> };
            };
            p.select = () => ({
              single: () =>
                Promise.resolve(
                  ok({
                    id: "mem-1",
                    user_id: "user-1",
                    price_cents: 0,
                    ...(patch as Record<string, unknown>),
                  }),
                ),
            });
            return p;
          },
        };
      },
      upsert: () => Promise.resolve(ok(null)),
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve(ok(null)) }) }),
    }),
  };
  return { admin, inserts, updates };
}

async function enrol(fake: ReturnType<typeof fakeEnrolAdmin>) {
  const { enrolMember } = await import("./membership.functions");
  return enrolMember(fake.admin as never, {
    userId: "user-1",
    plan: FREE_PLAN as never,
    utsStudentNumber: null,
    insurancePlan: null,
  });
}

describe("enrolMember on a free plan", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Raised and authorised in one INSERT, with its window already on it, and
  // never a second UPDATE to finish the job.
  it("raises it already authorised, in one write", async () => {
    const fake = fakeEnrolAdmin(ok(null));
    await expect(enrol(fake)).resolves.toMatchObject({ ok: true, authorised: true });
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({
      status: "active",
      starts_at: expect.any(String),
    });
    expect(fake.updates).toEqual([]);
  });

  // Nothing is owed on a free plan, so nothing is recorded as paid either. This
  // is what used to make an auto-assigned trial permanently undeletable.
  it("records no payment on a free plan", async () => {
    const fake = fakeEnrolAdmin(ok(null));
    await enrol(fake);
    expect(fake.inserts[0]).not.toHaveProperty("paid_at");
  });

  // The repeat — a retried submit, a double press, a reply that got lost. It
  // has to find the UNPAID row, which is now `active` like every other
  // membership; a pending-only guard would find nothing and raise a second.
  it("resolves a repeat back to the existing membership instead of raising a second", async () => {
    const fake = fakeEnrolAdmin(
      ok({ id: "mem-1", user_id: "user-1", status: "active", paid_at: null, price_cents: 0 }),
    );
    await expect(enrol(fake)).resolves.toMatchObject({ ok: true });
    expect(fake.inserts).toHaveLength(0);
  });

  // And having found it, must not re-authorise it: that would recompute the
  // dates and credits of a membership somebody may already have trained on.
  it("does not re-authorise the membership it resolved back to", async () => {
    const fake = fakeEnrolAdmin(
      ok({ id: "mem-1", user_id: "user-1", status: "active", paid_at: null, price_cents: 0 }),
    );
    await enrol(fake);
    expect(fake.updates).toEqual([]);
  });
});

// ---- Setting the day a membership starts ----
//
// The yearly insurance is the one plan whose start is a real choice: it runs a
// fixed number of days from wherever it is placed. A manager writing down cover
// that began in February needs to say so, and the two ways that can go wrong are
// a date silently ignored (the invoice looks backdated and is not) and a date
// accepted on a plan whose dates belong to everyone who buys it.

const INSURANCE_PLAN = {
  id: "plan-insurance",
  code: "insurance_yearly",
  name: "Yearly insurance",
  kind: "insurance",
  is_active: true,
  session_credits: null,
  public_price_cents: 0,
  student_price_cents: null,
  starts_on: null,
  ends_on: null,
  duration_days: 365,
};

async function enrolFrom(
  fake: ReturnType<typeof fakeEnrolAdmin>,
  plan: unknown,
  startsOn?: string,
) {
  const { enrolMember } = await import("./membership.functions");
  return enrolMember(fake.admin as never, {
    userId: "user-1",
    plan: plan as never,
    utsStudentNumber: null,
    insurancePlan: null,
    startsOn,
  });
}

describe("enrolMember with a start date", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 00:00 Sydney on 1 February is 13:00 UTC on 31 January (AEDT, +11), and the
  // year of cover is measured from there rather than from the moment a manager
  // happened to type it in.
  it("dates a rolling plan from the start of the chosen club day", async () => {
    const fake = fakeEnrolAdmin(ok(null));
    await enrolFrom(fake, INSURANCE_PLAN, "2026-02-01");
    expect(fake.inserts[0]).toMatchObject({
      starts_at: "2026-01-31T13:00:00.000Z",
      ends_at: "2027-01-31T13:00:00.000Z",
    });
  });

  it("still runs from today when no start date is given", async () => {
    const fake = fakeEnrolAdmin(ok(null));
    const before = Date.now();
    await enrolFrom(fake, INSURANCE_PLAN);
    const starts = new Date((fake.inserts[0] as { starts_at: string }).starts_at).getTime();
    expect(starts).toBeGreaterThanOrEqual(before - 1000);
  });

  // Refused, not ignored. A dropped date reads as a backdated enrolment that
  // never happened, and nothing later would show the difference.
  it("refuses a start date on a plan whose dates belong to the plan", async () => {
    const fake = fakeEnrolAdmin(ok(null));
    await expect(enrolFrom(fake, FREE_PLAN, "2026-02-01")).rejects.toThrow(/no start date to set/);
    expect(fake.inserts).toEqual([]);
  });

  // The reuse path has no second `authorisedFields` in it, so without this a
  // manager who re-raised the insurance with the right date would be told it
  // worked while the window sat where it was.
  it("moves an existing unpaid invoice's window when the start date differs", async () => {
    const fake = fakeEnrolAdmin(
      ok({
        id: "mem-1",
        user_id: "user-1",
        status: "active",
        paid_at: null,
        price_cents: 0,
        // Club midnight to club midnight, spelled as PostgREST renders a
        // TIMESTAMPTZ: 00:00 on 1 May in Sydney is 14:00 the day before in UTC.
        starts_at: "2026-04-30T14:00:00+00:00",
        ends_at: "2027-04-30T14:00:00+00:00",
      }),
    );
    await enrolFrom(fake, INSURANCE_PLAN, "2026-02-01");
    expect(fake.inserts).toEqual([]);
    expect(fake.updates[0]).toMatchObject({
      starts_at: "2026-01-31T13:00:00.000Z",
      // Moved, not resized: still 365 days, as sold.
      ends_at: "2027-01-31T13:00:00.000Z",
    });
  });

  // Spelled as PostgREST returns a TIMESTAMPTZ, not as JS writes one: the same
  // instant in two spellings is exactly what a string compare gets wrong, and a
  // fixture in the write format would pass with the guard deleted.
  it("writes nothing when the reused invoice already starts on that day", async () => {
    const fake = fakeEnrolAdmin(
      ok({
        id: "mem-1",
        user_id: "user-1",
        status: "active",
        paid_at: null,
        price_cents: 0,
        starts_at: "2026-01-31T13:00:00+00:00",
        ends_at: "2027-01-31T13:00:00+00:00",
      }),
    );
    await enrolFrom(fake, INSURANCE_PLAN, "2026-02-01");
    expect(fake.updates).toEqual([]);
  });
});

// ---- Guaranteeing a casual credit was actually invoiced ----
//
// `applyCoverage` in checkin.functions.ts calls this the moment a casual
// credit is spent, precisely because the email `enrolMember` sends when the
// membership is RAISED is not a guarantee: `send_email: false` can suppress
// it, and every email in this lifecycle is best-effort. These pin what a
// check-in reaches for once a credit has actually been drawn on.

const CASUAL_PLAN = {
  id: "plan-casual",
  code: "casual_session",
  name: "Casual class",
  kind: "session",
  session_credits: 1,
  ends_on: null,
};

/** One database call, as the fake saw it — same shape as checkin.functions.test.ts's. */
type InvoiceOp = { table: string; filters: [string, string, unknown][] };

/**
 * Chainable, because `ensureCasualInvoiceEmailed` reads `memberships` and
 * `membership_plans` two different ways: once by id (`.eq("id", …)`, single
 * row) for the credit that was actually spent, and — only when it needs to
 * fold in a bundled sibling invoice — once by `payment_reference` / `.in(…)`
 * (a list). Distinguishing on the filters actually used, like
 * checkin.functions.test.ts's fake, is what lets one fake client serve both.
 */
/** A candidate row sharing the primary membership's payment_reference. */
type SiblingRow = {
  id: string;
  price_cents: number;
  plan_id: string;
  status: string;
  paid_at: string | null;
};

function fakeInvoiceEmailAdmin(
  over: {
    membership?: Result;
    bundled?: Result;
    /**
     * The FULL candidate set sharing the reference, including rows the
     * production query is expected to filter out (paid, cancelled, or the
     * primary row itself). Unlike `bundled` — a canned response returned
     * as-is — this is run through the SAME predicates the real query sends
     * (recorded in `op.filters`), so a regression that drops one of those
     * filters actually changes what a test sees, rather than the fake
     * silently trusting the code to have filtered correctly.
     */
    siblings?: SiblingRow[];
    plan?: Result;
    siblingPlans?: Result;
    profile?: Result;
    emails?: Result;
    /** The `profiles` rows the household lookup reads, as guardian links. */
    household?: Result;
  } = {},
) {
  const membership =
    over.membership ??
    ok({
      id: "mem-casual",
      user_id: "user-1",
      plan_id: CASUAL_PLAN.id,
      price_cents: 3000,
      payment_reference: "JITSU-ADA-1234",
      paid_at: null,
    });
  const bundled = over.bundled ?? ok([]);
  const siblings = over.siblings;
  const plan = over.plan ?? ok(CASUAL_PLAN);
  const siblingPlans = over.siblingPlans ?? ok([]);
  const profile =
    over.profile ?? ok({ first_name: "Ada", middle_name: null, last_name: "Lovelace" });
  const emails =
    over.emails ?? ok([{ user_id: "user-1", email: "ada@example.com", email_confirmed_at: null }]);
  // The guardian links `loadHouseholdContacts` reads before it resolves an
  // address. Modelled rather than ignored: an invoice's recipient is now "the
  // contact person for this member", and a fake that answered the name lookup
  // for every profiles read would let a dependant's invoice silently resolve
  // to nobody while the test stayed green.
  const household = over.household ?? ok([{ user_id: "user-1", guardian_user_id: null }]);

  const byId = (filters: InvoiceOp["filters"]) =>
    filters.some(([col, verb]) => col === "id" && verb === "eq");

  /** Apply the bundled query's own recorded predicates to `siblings`. */
  function filterSiblings(filters: InvoiceOp["filters"]): Result {
    if (!siblings) return bundled;
    const excludedId = filters.find(([c, v]) => c === "id" && v === "neq")?.[2];
    const excludeCancelled = filters.some(
      ([c, v, val]) => c === "status" && v === "neq" && val === "cancelled",
    );
    const paidOnlyNull = filters.some(([c, v]) => c === "paid_at" && v === "is");
    return ok(
      siblings.filter((s) => {
        if (excludedId != null && s.id === excludedId) return false;
        if (excludeCancelled && s.status === "cancelled") return false;
        if (paidOnlyNull && s.paid_at !== null) return false;
        return true;
      }),
    );
  }

  function chain(op: InvoiceOp) {
    const settle = () => {
      if (op.table === "memberships")
        return Promise.resolve(byId(op.filters) ? membership : filterSiblings(op.filters));
      if (op.table === "membership_plans")
        return Promise.resolve(byId(op.filters) ? plan : siblingPlans);
      // Two different reads of `profiles`: the household link lookup filters
      // `user_id` with `.in()` and wants rows, the name lookup uses `.eq()`
      // and wants one.
      if (op.table === "profiles" && op.filters.some(([c, v]) => c === "user_id" && v === "in"))
        return Promise.resolve(household);
      return Promise.resolve(profile);
    };
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (op.filters.push([col, "eq", val]), builder),
      neq: (col: string, val: unknown) => (op.filters.push([col, "neq", val]), builder),
      in: (col: string, val: unknown) => (op.filters.push([col, "in", val]), builder),
      is: (col: string, val: unknown) => (op.filters.push([col, "is", val]), builder),
      maybeSingle: () => settle(),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return builder;
  }

  return {
    rpc: () => Promise.resolve(emails),
    from: (table: string) => ({ select: () => chain({ table, filters: [] }) }),
  };
}

async function ensureInvoiceEmailed(admin: unknown, membershipId = "mem-casual") {
  const { ensureCasualInvoiceEmailed } = await import("./membership.functions");
  return ensureCasualInvoiceEmailed(admin as never, membershipId);
}

describe("ensureCasualInvoiceEmailed", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendMembershipPaymentEmail.mockClear();
    sendMembershipPaidEmail.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the pay-this invoice for an unpaid casual credit", async () => {
    await ensureInvoiceEmailed(fakeInvoiceEmailAdmin({}));
    expect(sendMembershipPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-casual",
        memberEmail: "ada@example.com",
        planName: "Casual class",
        amount: "$30",
        reference: "JITSU-ADA-1234",
      }),
    );
    expect(sendMembershipPaidEmail).not.toHaveBeenCalled();
  });

  it("sends the receipt instead when the credit was already paid for", async () => {
    const admin = fakeInvoiceEmailAdmin({
      membership: ok({
        id: "mem-casual",
        user_id: "user-1",
        plan_id: CASUAL_PLAN.id,
        price_cents: 3000,
        payment_reference: "JITSU-ADA-1234",
        paid_at: "2026-08-05T00:00:00.000Z",
      }),
    });
    await ensureInvoiceEmailed(admin);
    expect(sendMembershipPaidEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-casual",
        memberEmail: "ada@example.com",
        planName: "Casual class",
        amount: "$30",
      }),
    );
    expect(sendMembershipPaymentEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for a comped, zero-priced casual", async () => {
    const admin = fakeInvoiceEmailAdmin({
      membership: ok({
        id: "mem-casual",
        user_id: "user-1",
        plan_id: CASUAL_PLAN.id,
        price_cents: 0,
        payment_reference: "JITSU-ADA-1234",
        paid_at: null,
      }),
    });
    await ensureInvoiceEmailed(admin);
    expect(sendMembershipPaymentEmail).not.toHaveBeenCalled();
    expect(sendMembershipPaidEmail).not.toHaveBeenCalled();
  });

  // A mandatory insurance invoice can ride on the SAME payment_reference as
  // the casual credit (`enrolMember`'s bundling). If the combined send never
  // went out — the `send_email: false` backfill this whole guarantee exists
  // for — sending only the casual amount would tell the member they owe less
  // than they actually do.
  it("folds an unpaid bundled invoice (e.g. insurance) into the amount and plan name", async () => {
    const admin = fakeInvoiceEmailAdmin({
      bundled: ok([{ price_cents: 6000, plan_id: "plan-insurance" }]),
      siblingPlans: ok([{ id: "plan-insurance", name: "Yearly insurance" }]),
    });
    await ensureInvoiceEmailed(admin);
    expect(sendMembershipPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-casual",
        planName: "Casual class + Yearly insurance",
        amount: "$90",
      }),
    );
  });

  // A manager can cancel one invoice on a shared reference without touching
  // the other (see docs/memberships.md) — a cancelled insurance invoice next
  // to a still-unpaid casual credit, say, because the member turned out to
  // already have cover elsewhere. `isUnpaid` and `reconcileUnmatched` both
  // treat "cancelled" as owed nothing; this guarantee has to agree, or it
  // bills the member for a charge that was deliberately withdrawn. Uses
  // `siblings` rather than `bundled`, so the fake actually applies the query's
  // own `.neq("status", "cancelled")` predicate instead of the test just
  // trusting the production code got it right.
  it("excludes a cancelled sibling from what it folds in", async () => {
    const admin = fakeInvoiceEmailAdmin({
      siblings: [
        {
          id: "sib-insurance",
          price_cents: 6000,
          plan_id: "plan-insurance",
          status: "cancelled",
          paid_at: null,
        },
      ],
      siblingPlans: ok([{ id: "plan-insurance", name: "Yearly insurance" }]),
    });
    await ensureInvoiceEmailed(admin);
    expect(sendMembershipPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-casual",
        planName: "Casual class",
        amount: "$30",
      }),
    );
  });

  // A comped casual bundled with paid-for insurance still owes the insurance
  // half, so the zero-price row on its own must not short-circuit the send —
  // only a genuinely zero TOTAL (nothing bundled, or everything bundled is
  // also free) should.
  it("still invoices a bundled sibling even when the casual credit itself is free", async () => {
    const admin = fakeInvoiceEmailAdmin({
      membership: ok({
        id: "mem-casual",
        user_id: "user-1",
        plan_id: CASUAL_PLAN.id,
        price_cents: 0,
        payment_reference: "JITSU-ADA-1234",
        paid_at: null,
      }),
      bundled: ok([{ price_cents: 6000, plan_id: "plan-insurance" }]),
      siblingPlans: ok([{ id: "plan-insurance", name: "Yearly insurance" }]),
    });
    await ensureInvoiceEmailed(admin);
    expect(sendMembershipPaymentEmail).toHaveBeenCalledWith(
      expect.objectContaining({ planName: "Casual class + Yearly insurance", amount: "$60" }),
    );
  });

  it("sends nothing when the membership no longer exists", async () => {
    await ensureInvoiceEmailed(fakeInvoiceEmailAdmin({ membership: ok(null) }));
    expect(sendMembershipPaymentEmail).not.toHaveBeenCalled();
    expect(sendMembershipPaidEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when the person has no resolvable email, rather than throwing", async () => {
    await ensureInvoiceEmailed(fakeInvoiceEmailAdmin({ emails: ok([]) }));
    expect(sendMembershipPaymentEmail).not.toHaveBeenCalled();
    expect(sendMembershipPaidEmail).not.toHaveBeenCalled();
  });

  it("never lets a failed send escape — the check-in it guards must never fail", async () => {
    sendMembershipPaymentEmail.mockRejectedValueOnce(new Error("Lovable is down"));
    await expect(ensureInvoiceEmailed(fakeInvoiceEmailAdmin({}))).resolves.toBeUndefined();
  });
});
