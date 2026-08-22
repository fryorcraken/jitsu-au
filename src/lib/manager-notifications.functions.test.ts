// The stalled-digest source of the "needs attention" list.
//
// What is worth pinning here is not the SQL but the discrimination: this item
// cannot be dismissed and it accuses the club's email of being broken, so it has
// to be right in both directions. It must fire while the digest has never been
// armed (the state the club is in), and it must NOT fire for a digest that is
// working but has one recipient whose address bounces every night, whose rows
// stay unstamped for good. Both look like "rows with a NULL emailed_at" from a
// distance, which is exactly the trap.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

import { digestBacklogNotifications } from "./manager-notifications.functions";

type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null };

/**
 * A PostgREST chain answering each `from()` with the next queued result and
 * recording the filters it was given. The filters matter as much as the
 * results: the whole check hangs on a cutoff, and a fake that swallowed `.lt()`
 * would let the window silently become "all of time" with every test still
 * green. Thenable because the counts are awaited directly rather than through
 * `.maybeSingle()`.
 */
function fakeAdmin(results: QueryResult[]) {
  const queue = [...results];
  const filters: Array<[string, unknown]> = [];
  let queries = 0;
  const admin = {
    from() {
      queries += 1;
      const result = queue.shift() ?? { data: null, error: null, count: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        is: (col: string, value: unknown) => {
          filters.push([`is:${col}`, value]);
          return chain;
        },
        lt: (col: string, value: unknown) => {
          filters.push([`lt:${col}`, value]);
          return chain;
        },
        gte: (col: string, value: unknown) => {
          filters.push([`gte:${col}`, value]);
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
  return {
    admin: admin as unknown as SupabaseClient<Database>,
    filters,
    queryCount: () => queries,
  };
}

const NOW = new Date("2026-08-21T00:00:00.000Z");
/** 36 hours before NOW, which is what every query below should be bounded by. */
const CUTOFF = "2026-08-19T12:00:00.000Z";

const backlog = (count: number): QueryResult => ({ data: null, error: null, count });
const oldest = (created_at: string): QueryResult => ({ data: { created_at }, error: null });
const failed: QueryResult = { data: null, error: { message: "nope" }, count: null };

describe("digestBacklogNotifications", () => {
  it("says nothing, in one query, while no row is overdue", async () => {
    const { admin, filters, queryCount } = fakeAdmin([backlog(0)]);
    expect(await digestBacklogNotifications(admin, NOW)).toEqual([]);
    // The quiet case is the one that runs on every manager's page load, so it
    // must not pay for the two follow-up reads.
    expect(queryCount()).toBe(1);
    expect(filters).toEqual([
      ["is:emailed_at", null],
      ["lt:created_at", CUTOFF],
    ]);
  });

  it("raises the item when a backlog has aged and nothing has been emailed", async () => {
    // The club's actual state: the digest has never been armed, so there is no
    // evidence anywhere of a run that worked.
    const { admin } = fakeAdmin([backlog(34), backlog(0), oldest("2026-08-05T23:00:00.000Z")]);
    const [n] = await digestBacklogNotifications(admin, NOW);
    expect(n.type).toBe("notification_digest_stalled");
    expect(n.body).toContain("34 notifications");
    expect(n.body).toContain("since 06/08/2026");
  });

  it("stays quiet when the digest is delivering to somebody", async () => {
    // One person's address bounces every night. `sendDailyDigests` swallows that
    // failure and deliberately leaves THEIR rows unstamped so tomorrow retries,
    // which means their backlog ages forever. Without this check the club would
    // carry a permanent, undismissable "the summary has stopped" item on a
    // digest that is working for everybody else.
    const { admin, queryCount } = fakeAdmin([backlog(4), backlog(19)]);
    expect(await digestBacklogNotifications(admin, NOW)).toEqual([]);
    // Stops before reading the oldest row: there is no item to date.
    expect(queryCount()).toBe(2);
  });

  it("bounds the recent-send check by the same window as the backlog", async () => {
    const { admin, filters } = fakeAdmin([backlog(4), backlog(19)]);
    await digestBacklogNotifications(admin, NOW);
    expect(filters).toContainEqual(["gte:emailed_at", CUTOFF]);
  });

  it("says nothing when a read fails, rather than crying wolf", async () => {
    // Telling a manager the club's email is broken on the strength of a query
    // that did not run is worse than saying nothing: the item cannot be
    // dismissed, so a wrong one stays up.
    expect(await digestBacklogNotifications(fakeAdmin([failed]).admin, NOW)).toEqual([]);
    expect(await digestBacklogNotifications(fakeAdmin([backlog(9), failed]).admin, NOW)).toEqual(
      [],
    );
  });

  it("keeps the item when only the oldest row could not be read", async () => {
    // The count is what the item cannot do without. A missing date makes the
    // copy vaguer and must not cost the warning itself.
    const { admin } = fakeAdmin([backlog(9), backlog(0), failed]);
    const [n] = await digestBacklogNotifications(admin, NOW);
    expect(n.type).toBe("notification_digest_stalled");
    expect(n.body).toContain("9 notifications have been waiting to be emailed, and nobody");
    expect(n.body).not.toContain("the oldest");
  });
});
