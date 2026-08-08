// The register step of the "needs attention" list.
//
// Both functions here take their client as a parameter, which is why they are
// reachable from the runner at all; the `markInterestRegistrationsSeen` wrapper
// around `acknowledgeInterestRegistrations` is a `createServerFn` and dies on
// "No Start context found in AsyncLocalStorage" (see membership.functions.test.ts).
// Pulling the body out was exactly so the watermark could be tested.
//
// What is worth pinning here is the marker, not the SQL. The whole item exists
// to clear itself, and there are three separate ways it could stop doing that:
// a count that ignores the watermark, a stamp that picks the OLDEST row instead
// of the newest (the marker would barely move and the count never reach zero),
// and a row dated in the future, which the clamp in `advanceSeenMarker` can
// never bring under the marker.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null };

/**
 * A PostgREST chain answering each `from()` with the next queued result, and
 * recording the filters and ordering it was given. The ordering matters as much
 * as the filters: a fake that swallowed `.order()` would let `ascending: false`
 * flip to `true` with every test still green, which on the stamp is the
 * difference between a badge that clears and one that never does. Thenable
 * because the count is awaited directly rather than through `.maybeSingle()`.
 */
function fakeAdmin(results: QueryResult[]) {
  const queue = [...results];
  const filters: Array<[string, string, unknown]> = [];
  const orders: Array<[string, string, boolean | undefined]> = [];
  const upserts: unknown[] = [];
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
        lte: (col: string, value: unknown) => {
          filters.push([table, `lte:${col}`, value]);
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orders.push([table, col, opts?.ascending]);
          return chain;
        },
        limit: () => chain,
        upsert: (row: unknown) => {
          upserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: () => Promise.resolve(result),
        then: (
          onFulfilled?: (value: QueryResult) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, filters, orders, upserts, tables };
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

  it("ignores anything dated in the future, on both reads", async () => {
    const { countNewInterestRegistrations } = await import("./leads.functions");
    const { admin, filters, orders } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: null, error: null, count: 1 },
      { data: { name: "Sam Lee", created_at: "2026-08-05T10:00:00.000Z" }, error: null },
    ]);
    await countNewInterestRegistrations(admin);
    // `anon` can INSERT a registration and the RLS check does not constrain
    // `created_at`, so a row stamped 2099 is filable from the browser bundle.
    // The stamp is clamped to the present, so without this upper bound that row
    // would count as new for good, pinning an item that cannot be dismissed.
    const upper = filters.filter(([, f]) => f === "lte:created_at");
    expect(upper).toHaveLength(2);
    for (const [, , value] of upper) {
      expect(new Date(String(value)).getTime()).toBeLessThanOrEqual(Date.now());
    }
    // Newest first, or the item would name whoever registered longest ago.
    expect(orders).toEqual([["interest_registrations", "created_at", false]]);
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

describe("acknowledgeInterestRegistrations", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const NEWEST = "2026-08-06T11:00:00.000Z";
  const rows = [
    { email: "Sam@Example.com", created_at: NEWEST },
    { email: "kim@example.com", created_at: "2026-08-06T09:00:00.000Z" },
  ];

  it("moves the watermark to the NEWEST registration, not the oldest", async () => {
    const { acknowledgeInterestRegistrations } = await import("./leads.functions");
    const { admin, orders, upserts } = fakeAdmin([
      { data: { value: MARKER }, error: null }, // current marker
      { data: rows, error: null }, // the new registrations
      { data: { value: MARKER }, error: null }, // marker re-read inside the stamp
    ]);
    const result = await acknowledgeInterestRegistrations(admin, "manager-1");

    // The one line that decides whether this item can ever be put down. Stamping
    // the oldest row would leave everything after it counted as new on the next
    // visit, forever.
    expect(result.marker).toBe(NEWEST);
    expect(upserts).toEqual([
      expect.objectContaining({
        key: "interest_registrations_seen_at",
        value: NEWEST,
        updated_by: "manager-1",
      }),
    ]);
    expect(orders).toEqual([["interest_registrations", "created_at", false]]);
  });

  it("hands back who the badge was about, normalized, before the marker moves", async () => {
    const { acknowledgeInterestRegistrations } = await import("./leads.functions");
    const { admin, filters } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: rows, error: null },
      { data: { value: MARKER }, error: null },
    ]);
    const result = await acknowledgeInterestRegistrations(admin, "manager-1");

    // Clearing the badge must not destroy the only record of what it meant. The
    // users screen matches these against a person's auth email too, so case and
    // whitespace are normalized the same way the profile identity key is.
    expect(result.newEmails).toEqual(["sam@example.com", "kim@example.com"]);
    // Read strictly after the old marker: a registration the marker already
    // covered was seen on an earlier visit and must not be pilled "new" again.
    expect(filters).toContainEqual(["interest_registrations", "gt:created_at", MARKER]);
  });

  it("writes nothing when there is nothing new", async () => {
    const { acknowledgeInterestRegistrations } = await import("./leads.functions");
    const { admin, upserts } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: [], error: null },
    ]);
    // Stamping `now()` on an empty result is the one way this could mark a
    // registration seen before it arrives.
    expect(await acknowledgeInterestRegistrations(admin, "manager-1")).toEqual({
      marker: MARKER,
      skipped: true,
      newEmails: [],
    });
    expect(upserts).toEqual([]);
  });

  it("throws rather than pretending it acknowledged anything", async () => {
    const { acknowledgeInterestRegistrations } = await import("./leads.functions");
    const { admin, upserts } = fakeAdmin([
      { data: { value: MARKER }, error: null },
      { data: null, error: { message: "boom" } },
    ]);
    // The opposite call from the count next door. Nobody is waiting on this
    // answer, so a failure that silently reported success would move the badge
    // without anybody having seen anything.
    await expect(acknowledgeInterestRegistrations(admin, "manager-1")).rejects.toThrow("boom");
    expect(upserts).toEqual([]);
  });
});
