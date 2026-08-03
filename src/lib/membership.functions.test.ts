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
  duration_days: 30,
  session_credits: null,
  price_cents: 0,
};

/**
 * A fake service-role client covering exactly the chains the trial assignment
 * walks. Each read is supplied per-test so a single one can be made to fail
 * while the rest succeed — the shape of a real outage.
 */
function fakeAdmin(reads: { trialPlans?: Result; existingTrial?: Result; profile?: Result }) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];

  const trialPlans = reads.trialPlans ?? ok([TRIAL_PLAN]);
  const existingTrial = reads.existingTrial ?? ok(null);
  const profile = reads.profile ?? ok({ first_name: "Ada", last_name: "Lovelace" });
  const inserted = ok({ id: "mem-1", user_id: "user-1", plan_id: TRIAL_PLAN.id, price_cents: 0 });

  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: unknown) => {
          if (table === "membership_plans") return Promise.resolve(trialPlans);
          if (table === "profiles") return { maybeSingle: () => Promise.resolve(profile) };
          // memberships: the "have they had a trial before" guard.
          return {
            in: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(existingTrial) }) }),
          };
        },
      }),
      insert: (row: unknown) => {
        inserts.push(row);
        return { select: () => ({ single: () => Promise.resolve(inserted) }) };
      },
      update: (patch: unknown) => {
        updates.push(patch);
        return { eq: () => Promise.resolve(ok(null)) };
      },
    }),
  };

  return { admin, inserts, updates };
}

/** The module under test lazy-imports the admin client; hand it the fake. */
let currentAdmin: unknown;
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentAdmin;
  },
}));

async function assignTrial(fake: ReturnType<typeof fakeAdmin>) {
  currentAdmin = fake.admin;
  const { assignTrialMembership } = await import("./membership.functions");
  return assignTrialMembership("user-1");
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

// ---- Bank reconciliation ----

const PAID_PLAN = {
  id: "plan-monthly",
  code: "monthly",
  name: "Monthly",
  kind: "monthly",
  is_active: true,
  duration_days: 30,
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
  semester?: Result;
  count?: { count: number | null; error: { message: string } | null };
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
        if (table === "memberships") return { eq: () => Promise.resolve(reads.pending ?? ok([])) };
        if (table === "membership_plans")
          return { in: () => Promise.resolve(reads.plans ?? ok([PAID_PLAN])) };
        if (table === "club_semesters")
          return { eq: () => ({ maybeSingle: () => Promise.resolve(reads.semester ?? ok(null)) }) };
        if (table === "profiles")
          return { eq: () => ({ maybeSingle: () => Promise.resolve(ok(null)) }) };
        throw new Error(`unexpected select on ${table}`);
      },
      update: (patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return { eq: () => Promise.resolve(ok(null)) };
      },
      upsert: () => Promise.resolve(ok(null)),
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

  // The case an earlier version of this change would have failed: a
  // semester-anchored plan must activate with the CHOSEN SEMESTER's dates, not
  // "now + duration_days" (duration_days is even left non-null on this fixture,
  // matching how the migration leaves it until the follow-up contract phase, to
  // prove the code branches on period_basis rather than falling back to it).
  const SEMESTER_PLAN = {
    id: "plan-semester",
    code: "semester",
    name: "One semester",
    kind: "period",
    is_active: true,
    duration_days: 182,
    session_credits: null,
    period_basis: "semester",
    price_cents: 44500,
  };
  const SEMESTER = {
    id: "sem-2026-s2",
    code: "2026-s2",
    name: "Semester 2 2026",
    starts_on: "2026-07-20",
    ends_on: "2026-11-22",
  };
  const SEMESTER_REFERENCE = buildPaymentReference("Jones", "user-2", undefined, SEMESTER.code);
  const PENDING_SEMESTER = {
    id: "mem-2",
    user_id: "user-2",
    plan_id: SEMESTER_PLAN.id,
    semester_id: SEMESTER.id,
    status: "pending",
    payment_reference: SEMESTER_REFERENCE,
    price_cents: 44500,
    payment_method: "bank_transfer",
  };
  const SEMESTER_TXN = {
    id: "txn-2",
    status: "unmatched",
    // Banks reformat references, same as TXN above; the match normalizes both.
    description: `OSKO PAYMENT ${SEMESTER_REFERENCE.toLowerCase()}`,
    reference: null,
    amount_cents: 44500,
  };

  it("activates a semester-anchored plan with the chosen semester's dates, not now + duration_days", async () => {
    const fake = fakeReconcileAdmin({
      txns: ok([SEMESTER_TXN]),
      pending: ok([PENDING_SEMESTER]),
      plans: ok([SEMESTER_PLAN]),
      semester: ok(SEMESTER),
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

  // A semester-basis row with no semester_id (activateMembershipRow refuses
  // it rather than silently defaulting to a rolling window) must not abort
  // every OTHER transaction in the same statement import. Without a per-row
  // guard around the activation call, this one bad invoice would throw out of
  // the whole loop, leaving PENDING's transaction unprocessed too even though
  // nothing is wrong with it.
  it("does not let one broken invoice's activation failure block the rest of the import", async () => {
    const BROKEN_SEMESTER_REFERENCE = buildPaymentReference(
      "Broken",
      "user-3",
      undefined,
      undefined,
    );
    const BROKEN_PENDING = {
      id: "mem-3",
      user_id: "user-3",
      plan_id: SEMESTER_PLAN.id,
      semester_id: null, // never set -- e.g. a row from before this code existed
      status: "pending",
      payment_reference: BROKEN_SEMESTER_REFERENCE,
      price_cents: 44500,
      payment_method: "bank_transfer",
    };
    const BROKEN_TXN = {
      id: "txn-3",
      status: "unmatched",
      description: `OSKO PAYMENT ${BROKEN_SEMESTER_REFERENCE.toLowerCase()}`,
      reference: null,
      amount_cents: 44500,
    };

    const fake = fakeReconcileAdmin({
      txns: ok([TXN, BROKEN_TXN]),
      pending: ok([PENDING, BROKEN_PENDING]),
      plans: ok([PAID_PLAN, SEMESTER_PLAN]),
      // No `semester` reply needed -- activateMembershipRow throws on the
      // missing semester_id before it ever reads club_semesters.
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
});
