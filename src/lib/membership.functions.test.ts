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

  it("assigns the trial and activates it", async () => {
    const fake = fakeAdmin({});
    await assignTrial(fake);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({ user_id: "user-1", plan_id: TRIAL_PLAN.id });
    expect(fake.updates[0]).toMatchObject({ status: "active" });
  });

  // The trial records when the entitlement was earned, not when a manager got
  // round to approving it: a form filled in at the gym may be approved hours or
  // days later. So it runs from the start of the SIGNING day (00:00 Sydney on
  // 5 Aug = 4 Aug 14:00 UTC). Coverage does not depend on this -- a credit
  // balance is not date-gated -- but the row should still say something true.
  it("runs the trial from the day the waiver was signed, not the day it was approved", async () => {
    const fake = fakeAdmin({});
    await assignTrial(fake);
    expect(fake.updates[0]).toMatchObject({
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

  // Activation has already committed by the time the label is reconciled, so a
  // failed role write is logged, never thrown: throwing would report a paid-up
  // activation as an error and invite a retry that resets the dates and
  // re-sends the confirmation email.
  it("does not fail the activation when the label cannot be written", async () => {
    const fake = fakeAdmin({ activePaid: ok([]), roleWriteFails: true });
    await expect(assignTrial(fake)).resolves.toBeUndefined();
    expect(fake.updates[0]).toMatchObject({ status: "active" });
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
          // Two readers share this table: reconciliation lists the pending
          // invoices (one `.eq`, awaited), and syncMemberRole narrows to active
          // and paid (`.eq.eq.gt`). The first `.eq` is therefore both awaitable
          // and chainable.
          const pending = reads.pending ?? ok([]);
          return {
            eq: () => ({
              then: (resolve: (v: Result) => unknown) => Promise.resolve(pending).then(resolve),
              eq: () => ({ gt: () => Promise.resolve(reads.activePaid ?? ok([])) }),
            }),
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
          if (col === "id" && val === reads.brokenActivationId) {
            return Promise.resolve(fails("constraint violation"));
          }
          updates.push({ table, patch });
          return Promise.resolve(ok(null));
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
    expect(fake.updates.some((u) => u.table === "memberships" && u.patch.status === "active")).toBe(
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
    expect(fake.updates.some((u) => u.table === "memberships" && u.patch.status === "active")).toBe(
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

  it("activates a dated plan with the plan's own dates, not a rolling window", async () => {
    const fake = fakeReconcileAdmin({
      txns: ok([DATED_TXN]),
      pending: ok([PENDING_DATED]),
      plans: ok([DATED_PLAN]),
    });
    await expect(reconcile(fake)).resolves.toEqual({ matched: 1, unmatched: 0 });
    const activation = fake.updates.find(
      (u) => u.table === "memberships" && u.patch.status === "active",
    );
    expect(activation).toBeTruthy();
    // 00:00 Australia/Sydney on starts_on -> 2026-07-19T14:00:00.000Z (AEST, +10).
    expect(activation!.patch.starts_at).toBe("2026-07-19T14:00:00.000Z");
    // 23:59:59 Australia/Sydney on ends_on, inclusive -> one second before the
    // next day's midnight, not a bare "now + 182 days" instant.
    expect(activation!.patch.ends_at).toBe("2026-11-22T12:59:59.000Z");
  });

  it("activates a rolling plan from the payment instant for duration_days", async () => {
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
      (u) => u.table === "memberships" && u.patch.status === "active",
    );
    expect(activation).toBeTruthy();
    expect(activation!.patch.ends_at).not.toBeNull();
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
      (u) => u.table === "memberships" && u.patch.status === "active",
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
  it("activates both halves of a reference-sharing bundle from one combined transfer", async () => {
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
      (u) => u.table === "memberships" && u.patch.status === "active",
    );
    expect(activations).toHaveLength(2);
    // Insurance activates on the fixed one-year window, not "here indefinitely".
    const insuranceActivation = activations.find((u) => u.patch.ends_at != null);
    expect(insuranceActivation).toBeTruthy();
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
      (u) => u.table === "memberships" && u.patch.status === "active",
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
        // memberships: the reuse lookup (.eq.eq.in[.eq].limit.maybeSingle) and
        // syncMemberRole's tally (.eq.eq.gt).
        return {
          eq: () => ({
            eq: () => ({
              in: () => ({
                limit: () => ({ maybeSingle: () => Promise.resolve(existing) }),
                eq: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(existing) }) }),
              }),
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
        return { eq: () => Promise.resolve(ok(null)) };
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

  it("raises and activates it the first time", async () => {
    const fake = fakeEnrolAdmin(ok(null));
    await expect(enrol(fake)).resolves.toMatchObject({ ok: true, activated: true });
    expect(fake.inserts).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({ status: "active" });
  });

  // The repeat. It must find the ALREADY-ACTIVE row, not just a pending one.
  it("resolves a repeat back to the active membership instead of raising a second", async () => {
    const fake = fakeEnrolAdmin(
      ok({ id: "mem-1", user_id: "user-1", status: "active", price_cents: 0 }),
    );
    await expect(enrol(fake)).resolves.toMatchObject({ ok: true });
    expect(fake.inserts).toHaveLength(0);
  });

  // And having found it, must not re-run activation over it: that resets the
  // dates and credits of a membership somebody may already have trained on.
  it("does not re-activate the membership it resolved back to", async () => {
    const fake = fakeEnrolAdmin(
      ok({ id: "mem-1", user_id: "user-1", status: "active", price_cents: 0 }),
    );
    await enrol(fake);
    expect(fake.updates).toEqual([]);
  });
});
