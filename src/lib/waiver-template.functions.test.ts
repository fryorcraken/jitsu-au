// Promoting a waiver version, driven against a fake client.
//
// `promoteWaiverTemplate` takes its client as a parameter for the same reason
// `applyCoverage` does in checkin.functions.ts: a `createServerFn` handler dies
// in the runner on "No Start context found in AsyncLocalStorage".
//
// What makes this worth pinning: the partial unique index allows exactly one
// `is_current = true`, so promoting is necessarily clear-then-set with a gap in
// between where the club has NO live waiver and `/waiver` refuses to render.
// The rules below are the ones that keep that gap from becoming an outage
// nobody notices — never open it needlessly, and never leave it silently.
import { describe, expect, it, vi } from "vitest";
import { promoteWaiverTemplate } from "./waiver.functions";

type Result = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

type Op = {
  verb: "select" | "update";
  patch?: Record<string, unknown>;
  filters: [string, unknown][];
};

function fakeClient(respond: (op: Op, calls: Op[]) => Result) {
  const calls: Op[] = [];
  function chain(op: Op) {
    const settle = () => {
      calls.push(op);
      return Promise.resolve(respond(op, calls));
    };
    const builder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (op.filters.push([col, val]), builder),
      select: () => builder,
      maybeSingle: () => settle(),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return builder;
  }
  const admin = {
    from: () => ({
      select: () => chain({ verb: "select", filters: [] }),
      update: (patch: Record<string, unknown>) => chain({ verb: "update", patch, filters: [] }),
    }),
  };
  return { admin: admin as never, calls };
}

const updates = (calls: Op[]) => calls.filter((c) => c.verb === "update");
/** The write that would clear the live flag, i.e. the one that opens the gap. */
const clears = (calls: Op[]) => updates(calls).filter((c) => c.patch?.is_current === false).length;

describe("promoteWaiverTemplate", () => {
  it("promotes, clearing the old live version first", async () => {
    const { admin, calls } = fakeClient((op, all) => {
      if (op.verb === "select" && all.filter((c) => c.verb === "select").length === 1)
        return ok({ id: "v2", version: 2, is_current: false });
      if (op.verb === "select") return ok({ id: "v1" });
      return ok(null);
    });
    await expect(promoteWaiverTemplate(admin, "v2")).resolves.toEqual({ version: 2 });
    const writes = updates(calls);
    expect(writes[0].patch).toEqual({ is_current: false });
    expect(writes[1].patch).toEqual({ is_current: true });
    expect(writes[1].filters).toContainEqual(["id", "v2"]);
  });

  it("refuses an unknown version without clearing anything", async () => {
    // The check has to come first. Clearing and then discovering the target does
    // not exist would cost the club its live waiver for a mistyped id.
    const { admin, calls } = fakeClient(() => ok(null));
    await expect(promoteWaiverTemplate(admin, "gone")).rejects.toThrow("no longer exists");
    expect(clears(calls)).toBe(0);
  });

  it("does nothing when the target is already live", async () => {
    const { admin, calls } = fakeClient(() => ok({ id: "v2", version: 2, is_current: true }));
    await expect(promoteWaiverTemplate(admin, "v2")).resolves.toEqual({ version: 2 });
    expect(updates(calls)).toHaveLength(0);
  });

  it("puts the previous version back when the promotion fails", async () => {
    const { admin, calls } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      // The post-failure re-read: nothing is live, so this is a real failure
      // rather than another manager having won the race.
      if (op.verb === "select") return ok(null);
      if (op.patch?.is_current === true && op.filters.some(([, v]) => v === "v2"))
        return { data: null, error: { message: "boom" } };
      return ok(null);
    });
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow("boom");
    const restore = updates(calls).at(-1);
    expect(restore?.patch).toEqual({ is_current: true });
    expect(restore?.filters).toContainEqual(["id", "v1"]);
  });

  it("explains a lost race instead of surfacing the constraint", async () => {
    // Another manager promoted while we were between our own two writes, so our
    // set hit the unique index. Something IS live, so nothing is broken — but
    // "duplicate key value violates unique constraint" tells a manager nothing.
    const { admin } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok({ id: "v3" });
      if (op.patch?.is_current === true)
        return { data: null, error: { message: "duplicate key value violates unique constraint" } };
      return ok(null);
    });
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow(
      /Someone else changed the live waiver/,
    );
  });

  it("says the signing page is down when the restore also fails", async () => {
    // Both writes failed and nothing is live. A generic error would be shrugged
    // at; this is the one case where a manager has to act immediately.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeClient((op, all) => {
      const selects = all.filter((c) => c.verb === "select").length;
      if (op.verb === "select" && selects === 1)
        return ok({ id: "v2", version: 2, is_current: false });
      if (op.verb === "select" && selects === 2) return ok({ id: "v1" });
      if (op.verb === "select") return ok(null);
      // The clear succeeds — that is what opens the gap. Both writes that could
      // close it again fail.
      if (op.patch?.is_current === false) return ok(null);
      return { data: null, error: { message: "boom" } };
    });
    await expect(promoteWaiverTemplate(admin, "v2")).rejects.toThrow(/no live waiver/);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
