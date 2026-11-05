// The check-in actions on the manager agent route: what an agent meets on the
// way in and on the way out.
//
// The shared functions' own rules (what pays for a class, the compare-and-swap
// guards, what each refusal is) are pinned in checkin.functions.test.ts against
// a fake client. What the route owns, and what is pinned here, is the status
// and envelope each refusal becomes, that the two failures which follow a
// release keep their message rather than being masked as a retryable db_error,
// the params it refuses rather than ignores, and the audit line every write
// leaves, failures included, because those failures are the ones somebody will
// reconstruct by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/manager-api-tokens";
import { WEEKDAY_LABELS } from "@/lib/calendar";

const TOKEN = "mat_checkin-route-test-token";
const OWNER = "0f000000-0000-4000-8000-000000000001";
const EVENT = "a1111111-1111-4111-8111-111111111111";
const PERSON = "b2222222-2222-4222-8222-222222222222";
const CHECKIN = "c3333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "d4444444-4444-4444-8444-444444444444";

type Result = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

/** Answers only what `authenticate` asks: the hashed-token lookup and has_role. */
vi.mock("@/integrations/supabase/client.server", () => {
  const tokens = () => {
    let hash: string | null = null;
    const select = {
      eq: (col: string, val: string) => {
        if (col === "token_hash") hash = val;
        return select;
      },
      is: () => select,
      maybeSingle: async () =>
        ok(hash === (await hashToken(TOKEN)) ? { id: "tok-1", created_by: OWNER } : null),
    };
    const stamp = { eq: () => stamp, then: (r: (x: Result) => void) => r(ok(null)) };
    return { select: () => select, update: () => stamp };
  };
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "manager_api_tokens") return tokens();
        throw new Error(`unexpected table ${table}`);
      },
      rpc: (name: string) => {
        if (name === "has_role") return Promise.resolve(ok(true));
        throw new Error(`unexpected rpc ${name}`);
      },
    },
  };
});

const fns = {
  listCheckInEventRows: vi.fn(),
  loadClassAttendance: vi.fn(),
  previewCheckInRow: vi.fn(),
  listUncoveredCheckInRows: vi.fn(),
  checkInPersonRow: vi.fn(),
  undoCheckInRow: vi.fn(),
  attachCheckInRow: vi.fn(),
  transferCheckInRow: vi.fn(),
};
vi.mock("@/lib/checkin.functions", async (importOriginal) => ({
  // The real CheckInError, so the route classifies exactly what the shared
  // functions throw.
  ...(await importOriginal<typeof import("@/lib/checkin.functions")>()),
  listCheckInEventRows: (...a: unknown[]) => fns.listCheckInEventRows(...a),
  loadClassAttendance: (...a: unknown[]) => fns.loadClassAttendance(...a),
  previewCheckInRow: (...a: unknown[]) => fns.previewCheckInRow(...a),
  listUncoveredCheckInRows: (...a: unknown[]) => fns.listUncoveredCheckInRows(...a),
  checkInPersonRow: (...a: unknown[]) => fns.checkInPersonRow(...a),
  undoCheckInRow: (...a: unknown[]) => fns.undoCheckInRow(...a),
  attachCheckInRow: (...a: unknown[]) => fns.attachCheckInRow(...a),
  transferCheckInRow: (...a: unknown[]) => fns.transferCheckInRow(...a),
}));

const { CheckInError } = await import("@/lib/checkin.functions");

type Handler = (ctx: { request: Request }) => Promise<Response>;
async function post(action: string, params: unknown) {
  const { Route } = await import("./agent");
  const h = (Route as unknown as { options: { server: { handlers: { POST: Handler } } } }).options
    .server.handlers;
  const res = await h.POST({
    request: new Request("http://localhost/api/manager/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ action, params }),
    }),
  });
  return { status: res.status, body: await res.json() };
}

const DECISION = {
  membership_id: MEMBERSHIP,
  coverage: "trial",
  plan_name: "Free trial",
  consumes_credit: true,
  sessions_remaining_before: 2,
  sessions_remaining_after: 1,
  closes_membership: false,
  warnings: [],
};

/** Every `[agent.<action>] audit` line logged, parsed. */
function auditLines(spy: { mock: { calls: unknown[][] } }, action: string) {
  return spy.mock.calls
    .filter((c) => c[0] === `[agent.${action}] audit`)
    .map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);
}

let info: { mock: { calls: unknown[][] } };
beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("manager agent route: check-in refusals", () => {
  it.each([
    ["not_found", 404],
    ["no_waiver", 422],
    ["class_cancelled", 409],
    ["already_covered", 409],
    ["not_covered", 409],
    ["same_membership", 409],
    ["claim_lost", 409],
    ["not_their_membership", 422],
  ] as const)("answers %s as %i, with the shared function's own words", async (reason, status) => {
    fns.attachCheckInRow.mockRejectedValue(new CheckInError(reason, `Refused: ${reason}.`));
    const { status: got, body } = await post("attach_check_in", { id: CHECKIN });
    expect(got).toBe(status);
    expect(body.error).toEqual({ code: reason, message: `Refused: ${reason}.` });
  });

  // Both follow a release, so a retry finds nothing to undo or an uncovered
  // check-in. db_error would mask the message as "try again shortly".
  it.each(["refund_failed", "move_incomplete"] as const)(
    "keeps %s's message rather than masking it as a retryable db_error",
    async (reason) => {
      fns.transferCheckInRow.mockRejectedValue(
        new CheckInError(reason, "The class is uncovered for now: attach it."),
      );
      const { status, body } = await post("move_check_in", {
        id: CHECKIN,
        membership_id: MEMBERSHIP,
      });
      expect(status).toBe(500);
      expect(body.error.code).toBe(reason);
      expect(body.error.message).toBe("The class is uncovered for now: attach it.");
    },
  );

  it("masks anything else as db_error, keeping the database's own text out", async () => {
    fns.undoCheckInRow.mockRejectedValue(new Error('relation "session_checkins" is locked'));
    const { status, body } = await post("undo_check_in", { id: CHECKIN });
    expect(status).toBe(500);
    expect(body.error.code).toBe("db_error");
    expect(body.error.message).not.toMatch(/session_checkins/);
  });
});

describe("manager agent route: check-in params", () => {
  it("refuses a filter the lists do not have, rather than return everything", async () => {
    for (const action of ["list_check_in_classes", "list_uncovered_check_ins"]) {
      const { status, body } = await post(action, { event_id: EVENT });
      expect(status).toBe(400);
      expect(body.error.code).toBe("invalid_params");
    }
    expect(fns.listCheckInEventRows).not.toHaveBeenCalled();
    expect(fns.listUncoveredCheckInRows).not.toHaveBeenCalled();
  });

  it("refuses a misspelt membership on attach, rather than letting the door choose", async () => {
    const { status } = await post("attach_check_in", { id: CHECKIN, membershipId: MEMBERSHIP });
    expect(status).toBe(400);
    expect(fns.attachCheckInRow).not.toHaveBeenCalled();
  });
});

describe("manager agent route: check-in reads", () => {
  it("lists one class's attendance from Here now's own read, in club time", async () => {
    fns.loadClassAttendance.mockResolvedValue({
      event: {
        id: EVENT,
        title: "Gi",
        instructor_name: null,
        location: null,
        // 07:30 on 5 November in Sydney, which is still the 4th in UTC.
        starts_at: "2026-11-04T20:30:00.000Z",
        ends_at: "2026-11-04T21:30:00.000Z",
        status: "scheduled",
      },
      checkins: [{ id: CHECKIN, user_id: PERSON, coverage: "trial" }],
    });
    const { body } = await post("list_attendance", { event_id: EVENT });
    expect(body.result).toMatchObject({
      count: 1,
      event: { weekday: WEEKDAY_LABELS[4], starts_local: "2026-11-05T07:30", checked_in_count: 1 },
      checkins: [{ id: CHECKIN }],
    });
  });
});

describe("manager agent route: check-in audit", () => {
  it("records who checked somebody in, and passes them on as checked_in_by", async () => {
    fns.checkInPersonRow.mockResolvedValue({
      already_checked_in: false,
      checkin_id: CHECKIN,
      decision: DECISION,
    });
    const { body } = await post("check_in", { event_id: EVENT, user_id: PERSON });
    expect(body.result.checkin_id).toBe(CHECKIN);
    expect(fns.checkInPersonRow.mock.calls[0][2]).toBe(OWNER);
    expect(auditLines(info, "check_in")).toEqual([
      expect.objectContaining({
        eventId: EVENT,
        userId: PERSON,
        checkinId: CHECKIN,
        consumedCredit: true,
        actor: OWNER,
      }),
    ]);
  });

  // The failures that leave records wrong are the ones somebody reconstructs
  // by hand, so they are the last place to be missing an actor.
  it("logs a failed undo with the check-in, the actor and why", async () => {
    fns.undoCheckInRow.mockRejectedValue(new CheckInError("refund_failed", "One session short."));
    await post("undo_check_in", { id: CHECKIN });
    expect(auditLines(info, "undo_check_in")).toEqual([
      { checkinId: CHECKIN, failed: "refund_failed", actor: OWNER },
    ]);
  });

  it("logs a failed move with what was asked for", async () => {
    fns.transferCheckInRow.mockRejectedValue(new CheckInError("move_incomplete", "Uncovered."));
    await post("move_check_in", { id: CHECKIN, membership_id: MEMBERSHIP });
    expect(auditLines(info, "move_check_in")).toEqual([
      { checkinId: CHECKIN, asked: MEMBERSHIP, failed: "move_incomplete", actor: OWNER },
    ]);
  });

  it("leaves no audit line for a request it refused before anything ran", async () => {
    await post("undo_check_in", { id: "not-a-uuid" });
    expect(auditLines(info, "undo_check_in")).toEqual([]);
  });
});
