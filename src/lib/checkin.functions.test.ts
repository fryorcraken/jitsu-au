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
import {
  applyCoverage,
  attachCheckInRow,
  CheckInError,
  checkInPersonRow,
  listUncoveredCheckInRows,
  previewCheckInRow,
  transferCheckInRow,
  undoCheckInRow,
} from "./checkin.functions";

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

/**
 * The roster's household lookup (guardian names, contact addresses) reads auth
 * users through an RPC the fake has no use for. Its own rules are tested in
 * household-email.test.ts; here everybody is nobody's dependant.
 */
vi.mock("@/lib/household-email", () => ({
  loadHouseholdContacts: async () => ({
    deliveryEmail: () => null,
    displayEmail: () => ({ onBehalfOf: null }),
  }),
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

/** The refusal a call threw, so a test can assert on its reason. */
async function refusal(run: () => Promise<unknown>): Promise<CheckInError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof CheckInError) return e;
    throw e;
  }
  throw new Error("expected a CheckInError, and the call succeeded");
}

const EVENT = { id: "evt-1", starts_at: CLASS_AT, status: "scheduled" };

describe("checkInPersonRow", () => {
  beforeEach(() => {
    ensureCasualInvoiceEmailed.mockClear();
  });

  it("records who checked them in, and returns the new check-in's id", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok(EVENT);
      if (op.table === "profiles") return ok({ user_id: "u1" });
      if (op.table === "session_checkins" && op.verb === "insert") return ok({ id: "chk-new" });
      if (op.table === "session_checkins") return ok([{ id: "chk-new" }]);
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow()]);
      return ok([{ id: "mem-trial" }]);
    });

    const result = await checkInPersonRow(admin, { event_id: "evt-1", user_id: "u1" }, "mgr-1");
    expect(result).toMatchObject({ already_checked_in: false, checkin_id: "chk-new" });
    expect(result.decision?.coverage).toBe("trial");
    expect(ofTable(calls, "session_checkins", "insert")[0].patch).toMatchObject({
      checked_in_by: "mgr-1",
    });
  });

  // A caller retrying a check-in it never heard back from needs the row it
  // made, to undo or move it; and it must not spend a second credit.
  it("returns the existing check-in's id on a repeat, and spends nothing", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok(EVENT);
      if (op.table === "profiles") return ok({ user_id: "u1" });
      if (op.table === "session_checkins" && op.verb === "insert")
        return { data: null, error: { message: "duplicate", code: "23505" } as never };
      if (op.table === "session_checkins") return ok({ id: "chk-old" });
      return ok([]);
    });

    expect(await checkInPersonRow(admin, { event_id: "evt-1", user_id: "u1" }, "mgr-1")).toEqual({
      already_checked_in: true,
      checkin_id: "chk-old",
      decision: null,
    });
    expect(ofTable(calls, "memberships", "update")).toHaveLength(0);
  });

  it("refuses a cancelled class, writing nothing", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok({ ...EVENT, status: "cancelled" });
      return ok({ user_id: "u1" });
    });

    const e = await refusal(() =>
      checkInPersonRow(admin, { event_id: "evt-1", user_id: "u1" }, "mgr-1"),
    );
    expect(e.reason).toBe("class_cancelled");
    expect(ofTable(calls, "session_checkins", "insert")).toHaveLength(0);
  });

  it("refuses somebody with no waiver on file", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok(EVENT);
      return ok(null);
    });

    const e = await refusal(() =>
      checkInPersonRow(admin, { event_id: "evt-1", user_id: "u-lead" }, "mgr-1"),
    );
    expect(e.reason).toBe("no_waiver");
  });

  it("refuses a class that is not on the calendar", async () => {
    const { admin } = fakeClient(() => ok(null));
    const e = await refusal(() =>
      checkInPersonRow(admin, { event_id: "evt-gone", user_id: "u1" }, "mgr-1"),
    );
    expect(e.reason).toBe("not_found");
  });
});

// Coverage is the trainee's own. A foreign membership id resolves to "nothing
// eligible", so without the guard an attach would land uncovered without
// saying why, and a move would first refund the real cover and then land
// uncovered. The screens cannot send one; the agent API can.
describe("naming somebody else's membership", () => {
  const uncovered = { id: "chk-1", user_id: "u1", event_id: "evt-1", coverage: "none" };
  const covered = {
    ...uncovered,
    coverage: "trial",
    membership_id: "mem-trial",
    consumed_credit: true,
    closed_membership: false,
    checked_in_at: CLASS_AT,
  };
  /** The guard's lookup is by id; coverage resolution reads by user_id. */
  const isGuardLookup = (op: Op) =>
    op.table === "memberships" && op.verb === "select" && filterValue(op, "id") !== undefined;

  it("is refused on attach before any credit moves", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(uncovered);
      if (isGuardLookup(op)) return ok({ id: "mem-theirs", user_id: "u-sibling" });
      return ok([]);
    });

    const e = await refusal(() =>
      attachCheckInRow(admin, { id: "chk-1", membership_id: "mem-theirs" }),
    );
    expect(e.reason).toBe("not_their_membership");
    expect(ofTable(calls, "memberships", "update")).toHaveLength(0);
    expect(ofTable(calls, "session_checkins", "update")).toHaveLength(0);
  });

  it("is refused on move before the check-in is released or refunded", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(covered);
      if (isGuardLookup(op)) return ok({ id: "mem-theirs", user_id: "u-sibling" });
      return ok([]);
    });

    const e = await refusal(() =>
      transferCheckInRow(admin, { id: "chk-1", membership_id: "mem-theirs" }),
    );
    expect(e.reason).toBe("not_their_membership");
    expect(ofTable(calls, "session_checkins", "update")).toHaveLength(0);
    expect(ofTable(calls, "memberships", "update")).toHaveLength(0);
  });

  it("is not_found for a membership that does not exist", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins") return ok(uncovered);
      if (isGuardLookup(op)) return ok(null);
      return ok([]);
    });

    const e = await refusal(() => attachCheckInRow(admin, { id: "chk-1", membership_id: "mem-x" }));
    expect(e.reason).toBe("not_found");
  });

  it("lets the person's own named membership pay", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins" && op.verb === "select") return ok(uncovered);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      if (isGuardLookup(op)) return ok({ id: "mem-trial", user_id: "u1" });
      if (op.table === "calendar_events") return ok({ starts_at: CLASS_AT });
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships" && op.verb === "select") return ok([trialRow()]);
      return ok([{ id: "mem-trial" }]);
    });

    const { decision } = await attachCheckInRow(admin, { id: "chk-1", membership_id: "mem-trial" });
    expect(decision).toMatchObject({ coverage: "trial", membership_id: "mem-trial" });
  });
});

describe("attach and move refuse the wrong one of the two", () => {
  it("sends a covered check-in to move, not attach", async () => {
    const { admin } = fakeClient(() =>
      ok({ id: "chk-1", user_id: "u1", event_id: "evt-1", coverage: "trial" }),
    );
    expect((await refusal(() => attachCheckInRow(admin, { id: "chk-1" }))).reason).toBe(
      "already_covered",
    );
  });

  it("sends an uncovered check-in to attach, not move", async () => {
    const { admin } = fakeClient(() =>
      ok({ id: "chk-1", user_id: "u1", event_id: "evt-1", coverage: "none", membership_id: null }),
    );
    expect(
      (await refusal(() => transferCheckInRow(admin, { id: "chk-1", membership_id: "mem-a" })))
        .reason,
    ).toBe("not_covered");
  });

  it("refuses a move onto the membership it is already on", async () => {
    const { admin, calls } = fakeClient(() =>
      ok({
        id: "chk-1",
        user_id: "u1",
        event_id: "evt-1",
        coverage: "trial",
        membership_id: "mem-a",
      }),
    );
    expect(
      (await refusal(() => transferCheckInRow(admin, { id: "chk-1", membership_id: "mem-a" })))
        .reason,
    ).toBe("same_membership");
    expect(ofTable(calls, "session_checkins", "update")).toHaveLength(0);
  });
});

// The agent's preview is the board's roster row for one person, built for that
// person only: reading the whole club for one answer also meant somebody past
// the roster's cap was told they had no waiver.
describe("previewCheckInRow", () => {
  const PROFILE = {
    user_id: "u1",
    first_name: "Sam",
    middle_name: null,
    last_name: "Example",
    preferred_name: null,
    date_of_birth: "1990-01-01",
  };

  it("reports what the door would spend, reading only that person", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok({ ...EVENT, title: "Gi" });
      if (op.table === "profiles") return ok(PROFILE);
      if (op.table === "session_checkins") return ok(null);
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships") return ok([trialRow()]);
      return ok([]);
    });

    const preview = await previewCheckInRow(admin, { event_id: "evt-1", user_id: "u1" });
    expect(preview.row).toMatchObject({
      user_id: "u1",
      name: "Sam Example",
      coverage: "trial",
      sessions_remaining_before: 2,
      consumes_credit: true,
    });
    expect(preview.checkin).toBeNull();
    // An adult's age answers nothing at the door, so it is withheld here too.
    expect(preview.row.age).toBeNull();
    expect(filterValue(ofTable(calls, "memberships", "select")[0], "user_id")).toEqual(["u1"]);
    // Nothing is written by a preview.
    expect(calls.every((c) => c.verb === "select")).toBe(true);
  });

  it("names their check-in when they are already in", async () => {
    const existing = {
      id: "chk-1",
      user_id: "u1",
      checked_in_at: CLASS_AT,
      coverage: "trial",
      membership_id: "mem-trial",
      consumed_credit: true,
      warnings: [],
      note: null,
    };
    const { admin } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok(EVENT);
      if (op.table === "profiles") return ok(PROFILE);
      if (op.table === "session_checkins") return ok(existing);
      if (op.table === "membership_plans") return ok(PLANS);
      if (op.table === "memberships") return ok([trialRow({ sessions_remaining: 1 })]);
      return ok([]);
    });

    const { checkin } = await previewCheckInRow(admin, { event_id: "evt-1", user_id: "u1" });
    expect(checkin).toMatchObject({ id: "chk-1", plan_name: "Free trial", name: "Sam Example" });
  });

  // check_in would refuse both, so a preview of a spend that cannot happen
  // would be the one thing the manager confirms that is not so.
  it("refuses a cancelled class, as check_in does", async () => {
    const { admin } = fakeClient((op) =>
      op.table === "calendar_events" ? ok({ ...EVENT, status: "cancelled" }) : ok(PROFILE),
    );
    expect(
      (await refusal(() => previewCheckInRow(admin, { event_id: "evt-1", user_id: "u1" }))).reason,
    ).toBe("class_cancelled");
  });

  it("refuses somebody with no waiver on file, as check_in does", async () => {
    const { admin } = fakeClient((op) => (op.table === "calendar_events" ? ok(EVENT) : ok(null)));
    expect(
      (await refusal(() => previewCheckInRow(admin, { event_id: "evt-1", user_id: "u-lead" })))
        .reason,
    ).toBe("no_waiver");
  });
});

// After a release there is nothing left to retry: undo finds no row, and a move
// finds an uncovered check-in. Each failure past that point says what state it
// left behind instead of reading as a database hiccup worth retrying.
describe("a failure after the check-in is released", () => {
  it("is refund_failed when an undo cannot give the session back", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins")
        return ok({
          id: "chk-1",
          membership_id: "mem-trial",
          consumed_credit: true,
          closed_membership: false,
        });
      if (op.table === "memberships" && op.verb === "select")
        return ok({ id: "mem-trial", status: "active", sessions_remaining: 1, ends_at: null });
      return { data: null, error: { message: "connection reset" } };
    });

    const e = await refusal(() => undoCheckInRow(admin, "chk-1"));
    expect(e.reason).toBe("refund_failed");
    expect(e.message).not.toMatch(/try again/i);
  });

  it("is refund_failed when the balance keeps moving under both attempts", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins")
        return ok({
          id: "chk-1",
          membership_id: "mem-trial",
          consumed_credit: true,
          closed_membership: false,
        });
      if (op.table === "memberships" && op.verb === "select")
        return ok({ id: "mem-trial", status: "active", sessions_remaining: 1, ends_at: null });
      return ok([]);
    });

    expect((await refusal(() => undoCheckInRow(admin, "chk-1"))).reason).toBe("refund_failed");
  });

  it("is move_incomplete when a move cannot put the class on the new membership", async () => {
    const covered = {
      id: "chk-1",
      user_id: "u1",
      event_id: "evt-1",
      coverage: "period",
      membership_id: "mem-sem",
      consumed_credit: false,
      closed_membership: false,
      checked_in_at: CLASS_AT,
    };
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins" && op.verb === "select") return ok(covered);
      if (op.table === "session_checkins") return ok([{ id: "chk-1" }]);
      if (op.table === "memberships" && filterValue(op, "id") !== undefined)
        return ok({ id: "mem-trial", user_id: "u1" });
      if (op.table === "calendar_events") return ok({ starts_at: CLASS_AT });
      // Coverage resolution cannot read the plans.
      return { data: null, error: { message: "connection reset" } };
    });

    const e = await refusal(() =>
      transferCheckInRow(admin, { id: "chk-1", membership_id: "mem-trial" }),
    );
    expect(e.reason).toBe("move_incomplete");
    expect(e.message).toMatch(/attach/);
  });
});

describe("listUncoveredCheckInRows", () => {
  // A row with no class would be answered against when they were checked in
  // rather than when the class ran, and reported as fact.
  it("fails rather than report rows it could not fill", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "session_checkins")
        return ok([
          {
            id: "chk-1",
            event_id: "evt-1",
            user_id: "u1",
            checked_in_at: CLASS_AT,
            warnings: [],
            note: null,
          },
        ]);
      if (op.table === "calendar_events") return { data: null, error: { message: "timeout" } };
      if (op.table === "membership_plans") return ok(PLANS);
      return ok([]);
    });

    await expect(listUncoveredCheckInRows(admin)).rejects.toThrow("timeout");
  });
});
