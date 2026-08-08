// The register step of the "needs attention" list.
//
// `countNewInterestRegistrations` is reachable from a unit test because it takes
// its client as a parameter; the `markInterestRegistrationsSeen` handler around
// it is a `createServerFn` and dies on "No Start context found in
// AsyncLocalStorage" when called from the runner (see membership.functions.test.ts).
//
// What is worth pinning here is the marker, not the SQL: the whole item exists
// to clear itself, so a count that ignores the watermark would leave a badge a
// manager can never put down.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null };

/**
 * A PostgREST chain answering each `from()` with the next queued result, and
 * recording the filters it was given so a test can prove the watermark reached
 * the query. Thenable because the count is awaited directly rather than through
 * `.maybeSingle()`.
 */
function fakeAdmin(results: QueryResult[]) {
  const queue = [...results];
  const filters: Array<[string, string, unknown]> = [];
  const tables: string[] = [];
  const admin = {
    from(table: string) {
      tables.push(table);
      const result = queue.shift() ?? { data: null, error: null, count: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          filters.push([table, `eq:${col}`, value]);
          return chain;
        },
        gt: (col: string, value: unknown) => {
          filters.push([table, `gt:${col}`, value]);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        then: (
          onFulfilled?: (value: QueryResult) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, filters, tables };
}

const MARKER = "2026-08-05T09:00:00.000Z";

describe("countNewInterestRegistrations", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("counts only what arrived after the marker, and names the newest", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    const { admin, filters } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: null, error: null, count: 2 },
      { data: { name: "Sam Lee", created_at: "2026-08-05T10:00:00.000Z" }, error: null },
    ]);
    expect(await countNewInterestRegistrations(admin)).toEqual({
      unread: 2,
      latestName: "Sam Lee",
      latestAt: "2026-08-05T10:00:00.000Z",
    });
    // Strictly newer than the marker, on BOTH reads. Naming a registration the
    // marker already covers would report a person who has been seen.
    expect(filters).toContainEqual(["interest_registrations", "gt:created_at", MARKER]);
    expect(
      filters.filter(([t, f]) => t === "interest_registrations" && f === "gt:created_at"),
    ).toHaveLength(2);
  });

  it("counts everything when nobody has ever opened the users list", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    // No `club_settings` row: right on the day this ships, and right again if
    // the marker is ever cleared.
    const { admin, filters } = fakeAdmin([
      { data: null, error: null },
      { data: null, error: null, count: 5 },
      { data: { name: "Sam Lee", created_at: "2026-08-05T10:00:00.000Z" }, error: null },
    ]);
    expect((await countNewInterestRegistrations(admin)).unread).toBe(5);
    expect(filters.filter(([, f]) => f === "gt:created_at")).toEqual([]);
  });

  it("stays quiet without going looking for a name", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    const { admin, tables } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: null, error: null, count: 0 },
    ]);
    expect(await countNewInterestRegistrations(admin)).toEqual({
      unread: 0,
      latestName: null,
      latestAt: null,
    });
    expect(tables).toEqual(["club_settings", "interest_registrations"]);
  });

  it("over-reports rather than going quiet when the marker cannot be read", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    // A failed marker read degrades to "nothing has ever been seen", which
    // nudges a manager to go and look. Reporting zero would hide the very thing
    // the count exists to surface.
    const { admin, filters } = fakeAdmin([
      { data: null, error: { message: "boom" } },
      { data: null, error: null, count: 3 },
      { data: { name: "Sam Lee", created_at: "2026-08-05T10:00:00.000Z" }, error: null },
    ]);
    expect((await countNewInterestRegistrations(admin)).unread).toBe(3);
    expect(filters.filter(([, f]) => f === "gt:created_at")).toEqual([]);
  });

  it("degrades to zero rather than throwing, so one bad read cannot empty the queue", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    const { admin } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: null, error: { message: "boom" }, count: null },
    ]);
    // It runs inside the attention list's Promise.all beside the waiver
    // approvals and the training-dates warning; throwing takes those down too.
    await expect(countNewInterestRegistrations(admin)).resolves.toEqual({
      unread: 0,
      latestName: null,
      latestAt: null,
    });
  });

  it("degrades to a bare count when the newest registration cannot be read", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    const { admin } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: null, error: null, count: 4 },
      { data: null, error: { message: "boom" } },
    ]);
    expect(await countNewInterestRegistrations(admin)).toEqual({
      unread: 4,
      latestName: null,
      latestAt: null,
    });
  });
});
