// The manager calendar's reads and writes, driven against a fake client.
//
// Each function here is a plain export taking its client, pulled out of its
// `createServerFn` handler so the manager Calendar screen and the manager agent
// API run the same code (a server function cannot be called from the runner: it
// dies on "No Start context found in AsyncLocalStorage").
//
// The rules pinned here are the ones an agent leans on and a reader cannot check
// by eye. A refusal says WHICH refusal it is (`CalendarEntryError.reason`, which
// the API turns into a status code), so a missing date is never reported as a
// one-off, nor as a quiet success that changed nothing. A retried create does
// not put the same class on the calendar twice. And stopping a repeat switches
// it off before it clears a single date.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CalendarEntryError,
  cancelEventRows,
  createCalendarEntryRow,
  deleteEventRow,
  listEventRsvpRows,
  listManagerEventRows,
  stopRepeatingSeries,
  updateCalendarEntryRow,
} from "./calendar.functions";
import type { CreateCalendarEntryInput } from "./validation";

type Result = { data: unknown; error: { message: string } | null; count?: number | null };
const ok = (data: unknown): Result => ({ data, error: null });

/** One database call, as the fake saw it. */
type Op = {
  table: string;
  verb: "select" | "insert" | "update" | "delete" | "rpc";
  /** What a select read, or what a write asked to have handed back. */
  columns?: string;
  /** A select's `{ count, head }` options. */
  count?: string;
  head?: boolean;
  patch?: unknown;
  filters: [string, string, unknown][];
};

/**
 * A chainable stand-in for the supabase client. Every builder method records its
 * filter and returns itself; awaiting (or `.maybeSingle()` / `.single()`) asks
 * the test's `respond` for a result. That keeps the fake indifferent to call
 * ORDER, so a test pins behaviour rather than the exact query the
 * implementation happens to write today. `calls` is in the order the awaits
 * landed, for the one rule here that IS about order.
 */
function fakeClient(respond: (op: Op, calls: Op[]) => Result) {
  const calls: Op[] = [];

  function chain(op: Op) {
    const settle = () => {
      calls.push(op);
      return Promise.resolve(respond(op, calls));
    };
    const filter = (kind: string) => (col: string, val: unknown) => (
      op.filters.push([col, kind, val]),
      builder
    );
    const builder: Record<string, unknown> = {
      eq: filter("eq"),
      neq: filter("neq"),
      in: filter("in"),
      gte: filter("gte"),
      lte: filter("lte"),
      is: filter("is"),
      not: (col: string, operator: string, val: unknown) => (
        op.filters.push([col, `not.${operator}`, val]),
        builder
      ),
      order: () => builder,
      limit: () => builder,
      // After a write, `.select(cols)` asks for the changed rows back.
      select: (cols?: string) => ((op.columns = cols ?? "*"), builder),
      maybeSingle: () => settle(),
      single: () => settle(),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return builder;
  }

  const admin = {
    from: (table: string) => ({
      select: (columns?: string, opts?: { count?: string; head?: boolean }) =>
        chain({
          table,
          verb: "select",
          columns,
          count: opts?.count,
          head: opts?.head,
          filters: [],
        }),
      insert: (patch: unknown) => chain({ table, verb: "insert", patch, filters: [] }),
      update: (patch: unknown) => chain({ table, verb: "update", patch, filters: [] }),
      delete: () => chain({ table, verb: "delete", filters: [] }),
    }),
    rpc: (fn: string, args: unknown) => {
      const op: Op = { table: fn, verb: "rpc", patch: args, filters: [] };
      calls.push(op);
      return Promise.resolve(respond(op, calls));
    },
  };

  // The real client is a deep generated type; the fake only needs the chains the
  // functions under test walk.
  return { admin: admin as never, calls };
}

/** Filter lookup, so assertions read as intent rather than array indices. */
const filterValue = (op: Op, col: string, kind = "eq") =>
  op.filters.find(([c, k]) => c === col && k === kind)?.[2];
const ofTable = (calls: Op[], table: string, verb: Op["verb"]) =>
  calls.filter((c) => c.table === table && c.verb === verb);
const writes = (calls: Op[]) => calls.filter((c) => c.verb !== "select" && c.verb !== "rpc");

/** The refusal a call rejected with; fails the test if it was anything else. */
async function refusal(promise: Promise<unknown>): Promise<CalendarEntryError> {
  const thrown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(CalendarEntryError);
  return thrown as CalendarEntryError;
}

/** 11am Monday 2 November in Sydney (AEDT, +11:00). */
const NOW = "2026-11-02T00:00:00.000Z";
const TODAY = "2026-11-02";
/** 6pm Wednesday that week, Sydney time. */
const NEXT_CLASS = "2026-11-04T07:00:00.000Z";
const NEXT_CLASS_END = "2026-11-04T09:00:00.000Z";
/** 6pm the Wednesday before: it has happened. */
const LAST_CLASS = "2026-10-28T07:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("deleteEventRow", () => {
  it("refuses a date that does not exist, and deletes nothing", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select") return ok(null);
      return { data: null, error: null, count: 0 };
    });

    const e = await refusal(deleteEventRow(admin, { id: "evt-gone" }));
    expect(e.reason).toBe("not_found");
    expect(writes(calls)).toHaveLength(0);
  });

  // The next horizon top-up would only put a deleted weekly date back.
  it("refuses one date of a weekly entry, and names the repeat to stop instead", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ id: "evt-1", series_id: "series-1" });
      return { data: null, error: null, count: 0 };
    });

    const e = await refusal(deleteEventRow(admin, { id: "evt-1" }));
    expect(e.reason).toBe("repeating_date");
    expect(e.details).toEqual({ series_id: "series-1" });
    expect(writes(calls)).toHaveLength(0);
  });

  // Once the class is gone its check-ins go too, as clean-up (the foreign key
  // cascades), and the count tells the manager how many went with it.
  it("deletes a class people were checked in to, and says how many check-ins went", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ id: "evt-1", series_id: null });
      if (op.table === "session_checkins") return { data: null, error: null, count: 3 };
      return ok(null);
    });

    const result = await deleteEventRow(admin, { id: "evt-1" });
    expect(result).toEqual({ ok: true, id: "evt-1", checkins_removed: 3 });
    const deletes = ofTable(calls, "calendar_events", "delete");
    expect(deletes).toHaveLength(1);
    expect(filterValue(deletes[0], "id")).toBe("evt-1");

    const tally = ofTable(calls, "session_checkins", "select")[0];
    expect(tally).toMatchObject({ count: "exact", head: true });
    expect(filterValue(tally, "event_id")).toBe("evt-1");
  });

  it("deletes a one-off nobody was checked in to", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ id: "evt-1", series_id: null });
      if (op.table === "session_checkins") return { data: null, error: null, count: 0 };
      return ok(null);
    });

    expect(await deleteEventRow(admin, { id: "evt-1" })).toEqual({
      ok: true,
      id: "evt-1",
      checkins_removed: 0,
    });
    const deletes = ofTable(calls, "calendar_events", "delete");
    expect(deletes).toHaveLength(1);
    expect(filterValue(deletes[0], "id")).toBe("evt-1");
  });
});

describe("cancelEventRows", () => {
  it("refuses a date that does not exist rather than reporting a cancel that changed nothing", async () => {
    const { admin } = fakeClient(() => ok([]));

    const e = await refusal(
      cancelEventRows(admin, { scope: "event", id: "evt-gone", cancelled: true }),
    );
    expect(e.reason).toBe("not_found");
  });

  it("calls a missing date missing, not a one-off, when asked for every future date", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select") return ok(null);
      return ok([]);
    });

    const e = await refusal(
      cancelEventRows(admin, { scope: "series", id: "evt-gone", cancelled: true }),
    );
    expect(e.reason).toBe("not_found");
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses every future date of a one-off, which has no future dates", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ series_id: null, starts_at: NEXT_CLASS });
      return ok([]);
    });

    const e = await refusal(
      cancelEventRows(admin, { scope: "series", id: "evt-1", cancelled: true }),
    );
    expect(e.reason).toBe("not_repeating");
    expect(writes(calls)).toHaveLength(0);
  });

  it("cancels the clicked date and every later one of its repeat, and says how many", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ series_id: "series-1", starts_at: NEXT_CLASS });
      if (op.table === "calendar_events" && op.verb === "update")
        return ok([{ id: "evt-1" }, { id: "evt-2" }, { id: "evt-3" }]);
      return ok([]);
    });

    const result = await cancelEventRows(admin, { scope: "series", id: "evt-1", cancelled: true });
    expect(result).toMatchObject({ ok: true, id: "evt-1", cancelled: true, updated: 3 });

    const update = ofTable(calls, "calendar_events", "update")[0];
    expect(update.patch).toMatchObject({ status: "cancelled" });
    expect(filterValue(update, "series_id")).toBe("series-1");
    // From the CLICKED date, not from today: dates between are left alone.
    expect(filterValue(update, "starts_at", "gte")).toBe(NEXT_CLASS);
    expect(update.columns).toBe("id");
  });

  it("restores one date and reports the one row it changed", async () => {
    const { admin, calls } = fakeClient(() => ok([{ id: "evt-1" }]));

    const result = await cancelEventRows(admin, { scope: "event", id: "evt-1", cancelled: false });
    expect(result).toMatchObject({ cancelled: false, updated: 1 });
    const update = ofTable(calls, "calendar_events", "update")[0];
    expect(update.patch).toMatchObject({ status: "scheduled" });
    expect(filterValue(update, "id")).toBe("evt-1");
  });
});

describe("updateCalendarEntryRow", () => {
  // Invite only is a badge (docs/calendar.md), so one date's badge is that
  // date's business: turning it off on one date of a weekly entry that carries
  // it is an ordinary edit, not something the entry's setting can veto.
  describe("invite only on one date of a weekly entry", () => {
    it("takes the badge off that date alone, without asking the entry", async () => {
      // The entry still says invite only, and the edit goes through anyway: the
      // entry's setting has no say over one date's badge.
      const { admin, calls } = fakeClient((op) => {
        if (op.table === "calendar_series" && op.verb === "select")
          return ok({ invite_only: true });
        if (op.table === "calendar_events" && op.verb === "select")
          return ok({ series_id: "series-1", starts_at: NEXT_CLASS });
        if (op.verb === "update") return ok([{ id: "evt-1" }]);
        return ok(null);
      });

      const result = await updateCalendarEntryRow(admin, {
        scope: "event",
        id: "evt-1",
        invite_only: false,
      });
      expect(result).toEqual({ ok: true, id: "evt-1", updated: 1 });

      const updates = ofTable(calls, "calendar_events", "update");
      expect(updates).toHaveLength(1);
      expect(updates[0].patch).toMatchObject({ invite_only: false });
      expect(filterValue(updates[0], "id")).toBe("evt-1");
      // Nothing about the weekly entry is read or written.
      expect(calls.filter((c) => c.table === "calendar_series")).toEqual([]);
    });

    it("takes it off the whole entry from this date on", async () => {
      const { admin, calls } = fakeClient((op) => {
        if (op.table === "calendar_events" && op.verb === "select")
          return ok({ series_id: "series-1", starts_at: NEXT_CLASS });
        if (op.verb === "update") return ok([{ id: "evt-1" }]);
        return ok(null);
      });

      await updateCalendarEntryRow(admin, { scope: "series", id: "evt-1", invite_only: false });
      expect(ofTable(calls, "calendar_series", "update")[0].patch).toMatchObject({
        invite_only: false,
      });
    });
  });

  it("refuses a date that does not exist rather than reporting an edit that changed nothing", async () => {
    const { admin } = fakeClient(() => ok([]));

    const e = await refusal(
      updateCalendarEntryRow(admin, { scope: "event", id: "evt-gone", title: "Open mat" }),
    );
    expect(e.reason).toBe("not_found");
  });

  it("calls a missing date missing, not a one-off, when asked for every future date", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select") return ok(null);
      return ok([]);
    });

    const e = await refusal(
      updateCalendarEntryRow(admin, { scope: "series", id: "evt-gone", title: "Open mat" }),
    );
    expect(e.reason).toBe("not_found");
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses every future date of a one-off, and writes nothing", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ series_id: null, starts_at: NEXT_CLASS });
      return ok([]);
    });

    const e = await refusal(
      updateCalendarEntryRow(admin, { scope: "series", id: "evt-1", title: "Open mat" }),
    );
    expect(e.reason).toBe("not_repeating");
    expect(writes(calls)).toHaveLength(0);
  });

  it("does nothing at all when there is nothing to change", async () => {
    const { admin, calls } = fakeClient(() => ok([]));

    expect(await updateCalendarEntryRow(admin, { scope: "series", id: "evt-1" })).toEqual({
      ok: true,
      id: "evt-1",
      updated: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("rewrites the repeat and its dates from the clicked one onward", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ series_id: "series-1", starts_at: NEXT_CLASS });
      if (op.table === "calendar_events" && op.verb === "update")
        return ok([{ id: "evt-1" }, { id: "evt-2" }]);
      return ok(null);
    });

    const result = await updateCalendarEntryRow(admin, {
      scope: "series",
      id: "evt-1",
      title: "Open mat",
    });
    expect(result).toEqual({ ok: true, id: "evt-1", updated: 2 });

    const rule = ofTable(calls, "calendar_series", "update")[0];
    expect(filterValue(rule, "id")).toBe("series-1");
    expect(rule.patch).toMatchObject({ title: "Open mat" });

    const dates = ofTable(calls, "calendar_events", "update")[0];
    expect(dates.patch).toMatchObject({ title: "Open mat" });
    expect(filterValue(dates, "series_id")).toBe("series-1");
    expect(filterValue(dates, "starts_at", "gte")).toBe(NEXT_CLASS);
  });

  it("never rewrites a date that has already happened, even the one clicked", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok({ series_id: "series-1", starts_at: LAST_CLASS });
      return ok([]);
    });

    await updateCalendarEntryRow(admin, { scope: "series", id: "evt-0", title: "Open mat" });
    const dates = ofTable(calls, "calendar_events", "update")[0];
    expect(filterValue(dates, "starts_at", "gte")).toBe(NOW);
  });
});

describe("stopRepeatingSeries", () => {
  /** The repeat, and the future dates a delete of them would hand back. */
  function club(opts: { series: unknown; future: string[] }) {
    return fakeClient((op) => {
      if (op.table === "calendar_series" && op.verb === "select") return ok(opts.series);
      if (op.table === "calendar_events" && op.verb === "delete")
        return ok(opts.future.map((id) => ({ id })));
      return ok(null);
    });
  }

  it("refuses a repeat that does not exist, and writes nothing", async () => {
    const { admin, calls } = club({ series: null, future: ["evt-1"] });

    const e = await refusal(stopRepeatingSeries(admin, { series_id: "series-gone" }));
    expect(e.reason).toBe("not_found");
    expect(writes(calls)).toHaveLength(0);
  });

  // Off first, so a horizon top-up running alongside cannot add dates back
  // after they have been cleared.
  it("switches the repeat off before it clears a single date", async () => {
    const { admin, calls } = club({
      series: { starts_on: "2026-09-02", is_active: true },
      future: ["evt-1", "evt-2"],
    });

    const result = await stopRepeatingSeries(admin, { series_id: "series-1" });
    expect(result).toEqual({ ok: true, already_stopped: false, removed: 2 });

    const off = calls.findIndex((c) => c.table === "calendar_series" && c.verb === "update");
    const del = calls.findIndex((c) => c.table === "calendar_events" && c.verb === "delete");
    expect(off).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(off);
    expect(calls[off].patch).toMatchObject({ is_active: false, ends_on: TODAY });
    expect(filterValue(calls[off], "id")).toBe("series-1");

    // Only dates still to start go; past ones happened.
    expect(filterValue(calls[del], "series_id")).toBe("series-1");
    expect(filterValue(calls[del], "starts_at", "gte")).toBe(NOW);
  });

  // Once a class is gone its check-ins go too, as clean-up, so nothing reads
  // them first to spare a date.
  it("removes every future date, checked in to or not, without reading check-ins", async () => {
    const { admin, calls } = club({
      series: { starts_on: "2026-09-02", is_active: true },
      future: ["evt-1", "evt-2", "evt-3"],
    });

    const result = await stopRepeatingSeries(admin, { series_id: "series-1" });
    expect(result).toMatchObject({ removed: 3 });
    expect(ofTable(calls, "session_checkins", "select")).toHaveLength(0);
  });

  // `ends_on` has a CHECK against `starts_on`.
  it("ends a repeat stopped before its first date on that first date", async () => {
    const { admin, calls } = club({
      series: { starts_on: "2026-12-02", is_active: true },
      future: [],
    });

    await stopRepeatingSeries(admin, { series_id: "series-1" });
    expect(ofTable(calls, "calendar_series", "update")[0].patch).toMatchObject({
      ends_on: "2026-12-02",
    });
  });

  it("clears dates left behind on a repeat already stopped, without rewriting the repeat", async () => {
    const { admin, calls } = club({
      series: { starts_on: "2026-09-02", is_active: false },
      future: ["evt-9"],
    });

    const result = await stopRepeatingSeries(admin, { series_id: "series-1" });
    expect(result).toMatchObject({ already_stopped: true, removed: 1 });
    // The date it was first stopped on stays the date on record.
    expect(ofTable(calls, "calendar_series", "update")).toHaveLength(0);
    expect(ofTable(calls, "calendar_events", "delete")).toHaveLength(1);
  });
});

describe("createCalendarEntryRow", () => {
  const MANAGER = "manager-1";

  const oneOff: CreateCalendarEntryInput = {
    title: "Grading",
    location: "UTS Ultimo",
    visibility: "public",
    invite_only: false,
    repeat: { type: "never", starts_at: NEXT_CLASS, ends_at: NEXT_CLASS_END },
  };
  const weekly: CreateCalendarEntryInput = {
    title: "Wednesday class",
    visibility: "public",
    invite_only: false,
    repeat: {
      type: "weekly",
      weekday: 3,
      start_time: "18:00",
      duration_minutes: 120,
      starts_on: TODAY,
    },
  };
  /** The same Wednesday class, over the dates given. */
  const wednesdays = (starts_on: string, ends_on: string | null): CreateCalendarEntryInput => ({
    ...weekly,
    repeat: {
      type: "weekly",
      weekday: 3,
      start_time: "18:00",
      duration_minutes: 120,
      starts_on,
      ends_on,
    },
  });

  it("refuses a one-off already on the calendar at that time, and adds nothing", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok([{ id: "evt-1", series_id: null, status: "scheduled", ends_at: NEXT_CLASS_END }]);
      return ok(null);
    });

    const e = await refusal(createCalendarEntryRow(admin, oneOff, MANAGER));
    expect(e.reason).toBe("already_on_calendar");
    expect(e.details).toEqual({ event_id: "evt-1", series_id: null, status: "scheduled" });
    expect(writes(calls)).toHaveLength(0);

    const lookup = ofTable(calls, "calendar_events", "select")[0];
    expect(filterValue(lookup, "title")).toBe("Grading");
    expect(filterValue(lookup, "starts_at")).toBe(NEXT_CLASS);
  });

  it("points at restoring a cancelled one rather than adding it again", async () => {
    const { admin } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok([
          { id: "evt-1", series_id: "series-1", status: "cancelled", ends_at: NEXT_CLASS_END },
        ]);
      return ok(null);
    });

    const e = await refusal(createCalendarEntryRow(admin, oneOff, MANAGER));
    expect(e.reason).toBe("already_on_calendar");
    expect(e.message).toMatch(/cancelled/);
    expect(e.message).toMatch(/restore it/i);
    expect(e.details).toMatchObject({ event_id: "evt-1", status: "cancelled" });
  });

  // PostgREST hands a timestamptz back as "+00:00" where the input said "Z".
  it("matches a cancelled date's end as an instant, not as a string", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok([
          {
            id: "evt-1",
            series_id: "series-1",
            status: "cancelled",
            ends_at: "2026-11-04T09:00:00+00:00",
          },
        ]);
      return ok(null);
    });

    const e = await refusal(createCalendarEntryRow(admin, oneOff, MANAGER));
    expect(e.reason).toBe("already_on_calendar");
    expect(writes(calls)).toHaveLength(0);
  });

  // "Cancel this date and add a one-off" is how a single class is made longer,
  // and the one-off starts where the cancelled date did.
  it("adds a longer one-off where a date was cancelled at the same start", async () => {
    const longer = "2026-11-04T10:00:00.000Z";
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok([
          { id: "evt-1", series_id: "series-1", status: "cancelled", ends_at: NEXT_CLASS_END },
        ]);
      if (op.table === "calendar_events" && op.verb === "insert")
        return ok({ id: "evt-new", series_id: null, status: "scheduled", ...(op.patch as object) });
      return ok(null);
    });

    const result = await createCalendarEntryRow(
      admin,
      { ...oneOff, repeat: { type: "never", starts_at: NEXT_CLASS, ends_at: longer } },
      MANAGER,
    );
    expect(result).toMatchObject({ ok: true, id: "evt-new", generated: 1 });
    const inserts = ofTable(calls, "calendar_events", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].patch).toMatchObject({ starts_at: NEXT_CLASS, ends_at: longer });
  });

  // The scheduled one is what is actually on the calendar, and restoring the
  // cancelled one would put the class on twice.
  it("names the scheduled match, not the cancelled one, when both are there", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select")
        return ok([
          { id: "evt-old", series_id: "series-1", status: "cancelled", ends_at: NEXT_CLASS_END },
          {
            id: "evt-longer",
            series_id: null,
            status: "scheduled",
            ends_at: "2026-11-04T10:00:00.000Z",
          },
        ]);
      return ok(null);
    });

    const e = await refusal(createCalendarEntryRow(admin, oneOff, MANAGER));
    expect(e.reason).toBe("already_on_calendar");
    expect(e.details).toEqual({ event_id: "evt-longer", series_id: null, status: "scheduled" });
    expect(e.message).not.toMatch(/restore/i);
    expect(e.message).not.toMatch(/cancelled/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("refuses a weekly entry that already repeats at that time, and adds nothing", async () => {
    const { admin, calls } = fakeClient((op) => {
      // The shape the real select returns: a run that started in September
      // and is still going, so it holds every Wednesday the new one would.
      if (op.table === "calendar_series" && op.verb === "select")
        return ok([{ id: "series-1", starts_on: "2026-09-02", ends_on: null }]);
      return ok(null);
    });

    const e = await refusal(createCalendarEntryRow(admin, weekly, MANAGER));
    expect(e.reason).toBe("already_on_calendar");
    expect(e.details).toEqual({ series_id: "series-1" });
    expect(writes(calls)).toHaveLength(0);

    // Only a repeat still running counts: a stopped one may be started again.
    const lookup = ofTable(calls, "calendar_series", "select")[0];
    expect(filterValue(lookup, "is_active")).toBe(true);
    expect(filterValue(lookup, "title")).toBe("Wednesday class");
    expect(filterValue(lookup, "weekday")).toBe(3);
    expect(filterValue(lookup, "start_time")).toBe("18:00");
  });

  // The semester ends on Friday 27 November, so its last Wednesday is the 25th.
  describe("against this semester's Wednesday class, which runs to Friday 27 November", () => {
    function club() {
      return fakeClient((op) => {
        if (op.table === "calendar_series" && op.verb === "select")
          return ok([{ id: "series-now", starts_on: "2026-07-15", ends_on: "2026-11-27" }]);
        if (op.table === "calendar_series" && op.verb === "insert")
          return ok({ id: "series-new", is_active: true, ...(op.patch as object) });
        if (op.table === "calendar_events" && op.verb === "select") return ok([]);
        if (op.table === "calendar_events" && op.verb === "insert")
          return ok(
            (op.patch as Record<string, unknown>[]).map((row, i) => ({
              id: `evt-${i}`,
              status: "scheduled",
              ...row,
            })),
          );
        return ok(null);
      });
    }

    // Added while this semester's run is still on, and not a duplicate of it.
    it("adds next semester's run", async () => {
      const { admin, calls } = club();

      const result = await createCalendarEntryRow(
        admin,
        wednesdays("2027-02-24", "2027-06-02"),
        MANAGER,
      );
      expect(result).toMatchObject({ ok: true, id: "series-new", repeats: true });
      expect(ofTable(calls, "calendar_series", "insert")).toHaveLength(1);
    });

    // The typed dates overlap on that Friday; the Wednesdays do not.
    it("adds a run starting the day the semester ends", async () => {
      const { admin, calls } = club();

      await createCalendarEntryRow(admin, wednesdays("2026-11-27", null), MANAGER);
      expect(ofTable(calls, "calendar_series", "insert")).toHaveLength(1);
    });

    it("refuses a run that would put a second class on one of its Wednesdays", async () => {
      const { admin, calls } = club();

      const e = await refusal(
        createCalendarEntryRow(admin, wednesdays("2026-11-18", null), MANAGER),
      );
      expect(e.reason).toBe("already_on_calendar");
      expect(e.details).toEqual({ series_id: "series-now" });
      expect(writes(calls)).toHaveLength(0);
    });
  });

  // Saved, it would be reported as added and never put a class on the
  // calendar. Refused before anything is read, let alone written.
  it("refuses a weekly entry whose last date has passed, without touching the database", async () => {
    const { admin, calls } = fakeClient(() => ok([]));

    const e = await refusal(
      createCalendarEntryRow(admin, wednesdays("2026-07-15", "2026-10-28"), MANAGER),
    );
    expect(e.reason).toBe("no_dates");
    expect(e.message).toMatch(/Wednesday/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a weekly entry whose dates hold no such weekday, without touching the database", async () => {
    const { admin, calls } = fakeClient(() => ok([]));

    // Thursday 5 to Tuesday 10 November: no Wednesday in it.
    const e = await refusal(
      createCalendarEntryRow(admin, wednesdays("2026-11-05", "2026-11-10"), MANAGER),
    );
    expect(e.reason).toBe("no_dates");
    expect(calls).toHaveLength(0);
  });

  // Until mid-morning in Sydney the UTC date is still yesterday. Measured in
  // UTC, a run that ended yesterday at the club would still count as live.
  it("measures a run's last date against today at the club, not in UTC", async () => {
    // 8am Monday 2 November in Sydney, still Sunday 1 November in UTC.
    vi.setSystemTime(new Date("2026-11-01T21:00:00.000Z"));
    const { admin, calls } = fakeClient(() => ok([]));
    const sundays: CreateCalendarEntryInput = {
      ...weekly,
      repeat: {
        type: "weekly",
        weekday: 0,
        start_time: "18:00",
        duration_minutes: 120,
        starts_on: "2026-10-25",
        ends_on: "2026-11-01",
      },
    };

    const e = await refusal(createCalendarEntryRow(admin, sundays, MANAGER));
    expect(e.reason).toBe("no_dates");
    expect(calls).toHaveLength(0);
  });

  // A one-off for the same class already sits on that Wednesday: the repeat
  // leaves it be rather than put a second copy on top of it.
  it("does not put a second copy over a scheduled date of the same class at the same time", async () => {
    let inserted: Record<string, unknown>[] = [];
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_series" && op.verb === "select") return ok([]);
      if (op.table === "calendar_series" && op.verb === "insert")
        return ok({ id: "series-new", is_active: true, ...(op.patch as object) });
      if (op.table === "calendar_events" && op.verb === "select")
        // Only the same-title lookup finds it: it is not one of this repeat's dates.
        return ok(filterValue(op, "title") ? [{ starts_at: "2026-11-04T07:00:00+00:00" }] : []);
      if (op.table === "calendar_events" && op.verb === "insert") {
        inserted = op.patch as Record<string, unknown>[];
        return ok(inserted.map((r, i) => ({ id: `evt-${i}`, starts_at: r.starts_at })));
      }
      return ok(null);
    });

    const result = await createCalendarEntryRow(admin, wednesdays(TODAY, null), MANAGER);
    const starts = inserted.map((r) => r.starts_at);
    expect(starts).not.toContain(NEXT_CLASS);
    expect(starts[0]).toBe("2026-11-11T07:00:00.000Z");
    expect(result.dates[0]).toMatchObject({ id: "evt-0", starts_at: "2026-11-11T07:00:00.000Z" });

    // A cancelled date at that time is not the class, so it does not count.
    const sameClass = ofTable(calls, "calendar_events", "select").find((c) =>
      filterValue(c, "title"),
    )!;
    expect(filterValue(sameClass, "title")).toBe("Wednesday class");
    expect(filterValue(sameClass, "status", "neq")).toBe("cancelled");
  });

  it("adds a fresh one-off as the acting manager, and hands back the date it added", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events" && op.verb === "select") return ok([]);
      if (op.table === "calendar_events" && op.verb === "insert")
        return ok({
          id: "evt-new",
          series_id: null,
          status: "scheduled",
          ...(op.patch as object),
        });
      return ok(null);
    });

    const result = await createCalendarEntryRow(admin, oneOff, MANAGER);
    expect(result).toMatchObject({ ok: true, id: "evt-new", repeats: false, generated: 1 });
    expect(result.dates).toEqual([
      {
        id: "evt-new",
        series_id: null,
        title: "Grading",
        description: null,
        instructor_name: null,
        location: "UTS Ultimo",
        starts_at: NEXT_CLASS,
        ends_at: NEXT_CLASS_END,
        status: "scheduled",
        visibility: "public",
        invite_only: false,
      },
    ]);
    expect(ofTable(calls, "calendar_events", "insert")[0].patch).toMatchObject({
      created_by: MANAGER,
    });
  });

  it("adds a fresh weekly entry and reports exactly the dates it put on the calendar", async () => {
    let inserted: Record<string, unknown>[] = [];
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_series" && op.verb === "select") return ok([]);
      if (op.table === "calendar_series" && op.verb === "insert")
        return ok({ id: "series-new", is_active: true, ...(op.patch as object) });
      // None of its dates exist yet.
      if (op.table === "calendar_events" && op.verb === "select") return ok([]);
      if (op.table === "calendar_events" && op.verb === "insert") {
        inserted = (op.patch as Record<string, unknown>[]).map((row, i) => ({
          id: `evt-${i}`,
          status: "scheduled",
          ...row,
        }));
        // Handed back out of order, as nothing promises otherwise.
        return ok([...inserted].reverse());
      }
      return ok(null);
    });

    const result = await createCalendarEntryRow(admin, weekly, MANAGER);
    expect(result).toMatchObject({ ok: true, id: "series-new", repeats: true });
    expect(result.dates.length).toBeGreaterThan(0);
    expect(result.generated).toBe(result.dates.length);
    expect(result.dates).toHaveLength(inserted.length);
    expect(result.dates.every((d) => d.series_id === "series-new")).toBe(true);

    const starts = result.dates.map((d) => d.starts_at);
    expect(starts).toEqual([...starts].sort());
    // Wednesday 6pm Sydney, the first one after today.
    expect(starts[0]).toBe(NEXT_CLASS);

    expect(ofTable(calls, "calendar_series", "insert")[0].patch).toMatchObject({
      created_by: MANAGER,
    });
  });
});

describe("listManagerEventRows", () => {
  /** A listed date, with only the columns that matter here varied. */
  const date = (id: string, series_id: string | null, invite_only: boolean) => ({
    id,
    series_id,
    title: "Wednesday class",
    description: null,
    instructor_name: null,
    location: "UTS Ultimo",
    starts_at: NEXT_CLASS,
    ends_at: NEXT_CLASS_END,
    status: "scheduled",
    visibility: "public",
    invite_only,
  });

  // Invite only is a badge and hides nothing (docs/calendar.md), so a date's
  // weekly entry has no say in how the date is listed: what the list reports is
  // the date's own flag, the one an edit of that date writes and the calendar
  // page and calendar apps show.
  it("reports each date's own invite only flag, and nothing about its weekly entry", async () => {
    const { admin, calls } = fakeClient((op) => {
      // Asked which entries are invite only, the answer would be this one. The
      // horizon top-up asks only for active entries and is told there are
      // none, so it adds nothing and stays out of the way.
      if (op.table === "calendar_series" && op.verb === "select")
        return filterValue(op, "invite_only") === true ? ok([{ id: "series-invite" }]) : ok([]);
      if (op.table === "calendar_events" && op.verb === "select")
        return ok([
          date("evt-of-invite-entry", "series-invite", false),
          date("evt-badged", "series-invite", true),
          date("evt-one-off", null, false),
        ]);
      if (op.table === "event_rsvps") return ok([]);
      return ok(null);
    });

    const rows = await listManagerEventRows(admin);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.invite_only]))).toEqual({
      "evt-of-invite-entry": false,
      "evt-badged": true,
      "evt-one-off": false,
    });
    for (const row of rows) expect(row).not.toHaveProperty("series_invite_only");
    expect(
      ofTable(calls, "calendar_series", "select").filter((op) =>
        op.filters.some(([col]) => col === "invite_only"),
      ),
    ).toEqual([]);
  });
});

describe("listEventRsvpRows", () => {
  it("refuses a date that does not exist, without reading anybody's replies", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok(null);
      return ok([]);
    });

    const e = await refusal(listEventRsvpRows(admin, { event_id: "evt-gone" }));
    expect(e.reason).toBe("not_found");
    expect(calls.filter((c) => c.table === "event_rsvps")).toHaveLength(0);
  });

  it("answers an empty list only for a date that exists and nobody has replied to", async () => {
    const { admin, calls } = fakeClient((op) => {
      if (op.table === "calendar_events") return ok({ id: "evt-1" });
      return ok([]);
    });

    expect(await listEventRsvpRows(admin, { event_id: "evt-1" })).toEqual([]);
    expect(filterValue(ofTable(calls, "event_rsvps", "select")[0], "event_id")).toBe("evt-1");
  });
});
