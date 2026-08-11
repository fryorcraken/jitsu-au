// The credit-moving path, driven end to end against a fake client.
//
// `applyCoverage` and `undoCheckInRow` are plain exported functions that take
// their client as a parameter, for the same reason `reconcileUnmatched` does in
// membership.functions.ts: a `createServerFn` handler cannot be called from the
// runner (it dies on "No Start context found in AsyncLocalStorage"), and these
// are the two places in the app where money's worth of credit actually moves.
//
// The rules pinned here are the ones a reader cannot check by eye: a lost race
// must hand the credit back rather than keep it, attaching the same check-in
// twice must not spend twice, and the membership a check-in just drew on must
// not be closed out from under it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCoverage, undoCheckInRow } from "./checkin.functions";

/**
 * `applyCoverage` reaches for this the moment a casual credit is actually
 * spent (see the doc comment on `applyCoverage` and on
 * `ensureCasualInvoiceEmailed` itself for why: the email `enrolMember` sends
 * when the membership is raised is not a guarantee). Mocked here because what
 * these tests pin is WHETHER and WITH WHAT it is called, not the email
 * machinery underneath it, which `membership.functions.test.ts` covers on its
 * own.
 */
const ensureCasualInvoiceEmailed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/membership.functions", () => ({
  ensureCasualInvoiceEmailed: (...args: unknown[]) => ensureCasualInvoiceEmailed(...args),
}));

type Result = { data: unknown; error: { message: string } | null; count?: number | null };
const ok = (data: unknown): Result => ({ data, error: null });

/** One database call, as the fake saw it. */
type Op = {
  table: string;
  verb: "select" | "insert" | "update" | "delete";
  patch?: Record<string, unknown>;
  filters: [string, string, unknown][];
};

/**
 * A chainable stand-in for the supabase client. Every builder method records its
 * filter and returns itself; awaiting (or `.maybeSingle()`) asks the test's
 * `respond` for a result. That keeps the fake indifferent to call ORDER, so a
 * test pins behaviour rather than the exact query the implementation happens to
 * write today.
 */
function fakeClient(respond: (op: Op, calls: Op[]) => Result) {
  const calls: Op[] = [];

  function chain(op: Op) {
    const settle = () => {
      calls.push(op);
      return Promise.resolve(respond(op, calls));
    };
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (op.filters.push([col, "eq", val]), builder),
      in: (col: string, val: unknown) => (op.filters.push([col, "in", val]), builder),
      order: () => builder,
      limit: () => builder,
      select: (_cols?: string) => builder,
      maybeSingle: () => settle(),
      single: () => settle(),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return builder;
  }

  const admin = {
    from: (table: string) => ({
      select: (_cols?: string) => chain({ table, verb: "select", filters: [] }),
      insert: (patch: Record<string, unknown>) =>
        chain({ table, verb: "insert", patch, filters: [] }),
      update: (patch: Record<string, unknown>) =>
        chain({ table, verb: "update", patch, filters: [] }),
      delete: () => chain({ table, verb: "delete", filters: [] }),
    }),
  };

  // The real client is a deep generated type; the fake only needs the chains the
  // functions under test walk.
  return { admin: admin as never, calls };
}

const PLANS = [
  { id: "plan-trial", name: "Free trial", kind: "trial" },
  { id: "plan-casual", name: "Casual class", kind: "session" },
  { id: "plan-sem", name: "One semester", kind: "period" },
];

const CLASS_AT = "2026-08-05T08:00:00.000Z";

function trialRow(over: Record<string, unknown> = {}) {
  return {
    id: "mem-trial",
    user_id: "u1",
    plan_id: "plan-trial",
    status: "active",
    price_cents: 0,
    sessions_remaining: 2,
    starts_at: "2026-08-01T00:00:00.000Z",
    ends_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** Filter lookup, so assertions read as intent rather than array indices. */
const filterValue = (op: Op, col: string) => op.filters.find(([c]) => c === col)?.[2];
const ofTable = (calls: Op[], table: string, verb: Op["verb"]) =>
  calls.filter((c) => c.table === table && c.verb === verb);

describe("applyCoverage", () => {
  beforeEach(() => {
    ensureCasualInvoiceEmailed.mockClear();
  });

  it("spends the credit and records what paid for the class", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow()]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-trial" }]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });

    const decision = await applyCoverage(admin, {
      checkInId: "chk-1",
      userId: "u1",
      at: CLASS_AT,
    });

    expect(decision.coverage).toBe("trial");
    expect(decision.consumes_credit).toBe(true);

    // The decrement is a compare-and-set on the balance we read, not a blind write.
    const spend = ofTable(calls, "memberships", "update")[0];
    expect(spend.patch).toMatchObject({ sessions_remaining: 1 });
    expect(filterValue(spend, "sessions_remaining")).toBe(2);
    expect(filterValue(spend, "status")).toBe("active");

    // And the check-in row is claimed, not merely written.
    const claim = ofTable(calls, "session_checkins", "update")[0];
    expect(filterValue(claim, "coverage")).toBe("none");
    expect(claim.patch).toMatchObject({ consumed_credit: true, membership_id: "mem-trial" });
  });

  // The regression test for the double-spend: `UNIQUE (event_id, user_id)` only
  // guards CREATING a check-in, so two managers attaching the same existing row
  // would otherwise both resolve and both spend.
  it("hands the credit back when another manager claims the same check-in first", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow()]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-trial" }]);
      // The row was already covered by the other manager: zero rows match.
      if (op.table === "session_checkins") return ok([]);
      return ok([]);
    });

    await expect(
      applyCoverage(admin, { checkInId: "chk-1", userId: "u1", at: CLASS_AT }),
    ).rejects.toThrow(/someone else covered/i);

    const membershipWrites = ofTable(calls, "memberships", "update");
    expect(membershipWrites).toHaveLength(2);
    // The refund puts the balance back exactly where it was, guarded on the
    // value it wrote, so it cannot clobber a concurrent decrement.
    expect(membershipWrites[1].patch).toMatchObject({ sessions_remaining: 2 });
    expect(filterValue(membershipWrites[1], "sessions_remaining")).toBe(1);
  });

  it("reopens the membership it closed when it then loses the claim", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select")
        return ok([trialRow({ sessions_remaining: 1 })]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-trial" }]);
      if (op.table === "session_checkins") return ok([]);
      return ok([]);
    });

    await expect(
      applyCoverage(admin, { checkInId: "chk-1", userId: "u1", at: CLASS_AT }),
    ).rejects.toThrow();

    const writes = ofTable(calls, "memberships", "update");
    expect(writes[0].patch).toMatchObject({ sessions_remaining: 0, status: "expired" });
    expect(writes[1].patch).toMatchObject({ sessions_remaining: 1, status: "active" });
  });

  // Coverage resolves at the CLASS's start, so back-filling an older roster can
  // legitimately spend a pack that has since run out of days. Sweeping it closed
  // in the same call would strand the credit just taken: the decrement guards on
  // `status = 'active'`, so the sweep would make it miss and the class would be
  // recorded uncovered — with an unfixable "another check-in took the session
  // first". A membership ending yesterday, for a class held the day before that.
  it("does not close the lapsed membership it just drew on", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const dayBefore = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const pack = trialRow({
      id: "mem-pack",
      plan_id: "plan-casual",
      sessions_remaining: 4,
      starts_at: "2026-01-01T00:00:00.000Z",
      ends_at: yesterday,
    });
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([pack]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-pack" }]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });

    const decision = await applyCoverage(admin, {
      checkInId: "chk-1",
      userId: "u1",
      at: dayBefore,
    });
    expect(decision.coverage).toBe("session");
    expect(decision.consumes_credit).toBe(true);

    // `closeLapsed` is the only write that filters ids with `in`. There must be
    // none naming the membership this check-in used.
    const sweeps = ofTable(calls, "memberships", "update").filter((c) =>
      c.filters.some(([col, verb]) => col === "id" && verb === "in"),
    );
    expect(sweeps.flatMap((c) => (filterValue(c, "id") as string[]) ?? [])).not.toContain(
      "mem-pack",
    );

    // A casual credit was what paid for this class, so the check-in guarantees
    // it has an invoice or receipt in their inbox.
    expect(ensureCasualInvoiceEmailed).toHaveBeenCalledWith(admin, "mem-pack");
  });

  // The invoice guarantee is specific to a casual (credit) coverage — spending
  // a trial credit or drawing on an unlimited period membership must not fire
  // it, since neither is the "casual session" case this exists for.
  it("does not guarantee an invoice email for a trial or a period membership", async () => {
    const { admin: trialAdmin } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow()]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-trial" }]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });
    const trialDecision = await applyCoverage(trialAdmin, {
      checkInId: "chk-1",
      userId: "u1",
      at: CLASS_AT,
    });
    expect(trialDecision.coverage).toBe("trial");
    expect(ensureCasualInvoiceEmailed).not.toHaveBeenCalled();

    const period = trialRow({
      id: "mem-sem",
      plan_id: "plan-sem",
      sessions_remaining: null,
      starts_at: "2026-01-01T00:00:00.000Z",
    });
    const { admin: periodAdmin } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([period]);
      if (op.table === "session_checkins") return ok([{ id: "chk-2" }]);
      return ok([]);
    });
    const periodDecision = await applyCoverage(periodAdmin, {
      checkInId: "chk-2",
      userId: "u1",
      at: CLASS_AT,
    });
    expect(periodDecision.coverage).toBe("period");
    expect(ensureCasualInvoiceEmailed).not.toHaveBeenCalled();
  });

  it("does not guarantee an invoice email for an uncovered check-in", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });
    const decision = await applyCoverage(admin, { checkInId: "chk-1", userId: "u1", at: CLASS_AT });
    expect(decision.coverage).toBe("none");
    expect(ensureCasualInvoiceEmailed).not.toHaveBeenCalled();
  });

  // ...but a lapsed membership it did NOT use is still closed on sight, which is
  // the only thing in this app that enforces an end date at all.
  it("closes a lapsed membership it did not use", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const stale = trialRow({
      id: "mem-old-sem",
      plan_id: "plan-sem",
      sessions_remaining: null,
      starts_at: "2026-01-01T00:00:00.000Z",
      ends_at: yesterday,
    });
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select")
        return ok([stale, trialRow({ starts_at: "2026-01-01T00:00:00.000Z" })]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "x" }]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });

    // The trial covers this class, so the finished semester is fair game.
    const decision = await applyCoverage(admin, {
      checkInId: "chk-1",
      userId: "u1",
      at: new Date().toISOString(),
    });
    expect(decision.membership_id).toBe("mem-trial");

    const sweeps = ofTable(calls, "memberships", "update").filter((c) =>
      c.filters.some(([col, verb]) => col === "id" && verb === "in"),
    );
    expect(sweeps).toHaveLength(1);
    expect(filterValue(sweeps[0], "id")).toEqual(["mem-old-sem"]);
    expect(sweeps[0].patch).toMatchObject({ status: "expired" });
  });

  it("records a check-in nothing covers rather than refusing it", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });

    const decision = await applyCoverage(admin, {
      checkInId: "chk-1",
      userId: "u1",
      at: CLASS_AT,
    });
    expect(decision.coverage).toBe("none");
    expect(decision.warnings).toContain("no_cover");
    // Nothing was spent, so nothing may be written to memberships.
    expect(ofTable(calls, "memberships", "update")).toHaveLength(0);
    expect(ofTable(calls, "session_checkins", "update")[0].patch).toMatchObject({
      coverage: "none",
      consumed_credit: false,
      membership_id: null,
    });
  });

  it("never touches checked_in_by, so attaching cover cannot rewrite who was on the door", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow()]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-trial" }]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });

    await applyCoverage(admin, { checkInId: "chk-1", userId: "u1", at: CLASS_AT });
    const claim = ofTable(calls, "session_checkins", "update")[0];
    expect(Object.keys(claim.patch ?? {})).not.toContain("checked_in_by");
  });

  it("honours a manager's override, and records no cover when the chosen one cannot pay", async () => {
    const expired = trialRow({ id: "mem-old", status: "expired" });
    const { admin } = fakeClient((op) => {
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow(), expired]);
      if (op.table === "memberships" && op.verb === "update") return ok([{ id: "mem-trial" }]);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      return ok([]);
    });

    const decision = await applyCoverage(admin, {
      checkInId: "chk-1",
      userId: "u1",
      at: CLASS_AT,
      onlyMembershipId: "mem-old",
    });
    expect(decision.coverage).toBe("none");
    expect(decision.membership_id).toBeNull();
  });
});

describe("undoCheckInRow", () => {
  const deletedRow = (over: Record<string, unknown> = {}) => ({
    id: "chk-1",
    membership_id: "mem-trial",
    consumed_credit: true,
    closed_membership: false,
    ...over,
  });

  it("gives the session back", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(deletedRow());
      if (op.table === "memberships" && op.verb === "select")
        return ok({ id: "mem-trial", status: "active", sessions_remaining: 1, ends_at: null });
      return ok([{ id: "mem-trial" }]);
    });

    expect(await undoCheckInRow(admin, "chk-1")).toMatchObject({ removed: true, refunded: true });
    const refund = ofTable(calls, "memberships", "update")[0];
    expect(refund.patch).toMatchObject({ sessions_remaining: 2 });
    // Guarded on the balance read, so a concurrent decrement is not clobbered.
    expect(filterValue(refund, "sessions_remaining")).toBe(1);
  });

  it("reopens a membership this check-in closed", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(deletedRow({ closed_membership: true }));
      if (op.table === "memberships" && op.verb === "select")
        return ok({ id: "mem-trial", status: "expired", sessions_remaining: 0, ends_at: null });
      return ok([{ id: "mem-trial" }]);
    });

    expect(await undoCheckInRow(admin, "chk-1")).toMatchObject({ refunded: true, reopened: true });
    expect(ofTable(calls, "memberships", "update")[0].patch).toMatchObject({ status: "active" });
  });

  // A manager who ended a membership by hand must not have it resurrected by an
  // unrelated undo.
  it("leaves a membership somebody else expired alone", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(deletedRow());
      if (op.table === "memberships" && op.verb === "select")
        return ok({ id: "mem-trial", status: "expired", sessions_remaining: 1, ends_at: null });
      return ok([{ id: "mem-trial" }]);
    });

    expect(await undoCheckInRow(admin, "chk-1")).toMatchObject({ reopened: false });
    expect(Object.keys(ofTable(calls, "memberships", "update")[0].patch ?? {})).not.toContain(
      "status",
    );
  });

  it("does not reopen a membership whose end date has also passed", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(deletedRow({ closed_membership: true }));
      if (op.table === "memberships" && op.verb === "select")
        return ok({
          id: "mem-trial",
          status: "expired",
          sessions_remaining: 0,
          ends_at: "2020-01-01T00:00:00.000Z",
        });
      return ok([{ id: "mem-trial" }]);
    });

    expect(await undoCheckInRow(admin, "chk-1")).toMatchObject({ reopened: false });
  });

  it("reports a no-op when somebody else already undid it", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(null);
      return ok([]);
    });

    expect(await undoCheckInRow(admin, "chk-1")).toEqual({ removed: false, refunded: false });
    expect(ofTable(calls, "memberships", "update")).toHaveLength(0);
  });

  it("refunds nothing for a check-in that never spent a credit", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins")
        return ok(deletedRow({ consumed_credit: false, membership_id: "mem-sem" }));
      return ok([]);
    });

    expect(await undoCheckInRow(admin, "chk-1")).toEqual({ removed: true, refunded: false });
    expect(ofTable(calls, "memberships", "update")).toHaveLength(0);
  });
});
