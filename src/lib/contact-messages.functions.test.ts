// The delete on the contact inbox.
//
// `deleteContactMessageRow` takes its client as a parameter, which is why it is
// reachable from the runner at all; the `deleteContactMessage` wrapper around it
// is a `createServerFn` and dies on "No Start context found in AsyncLocalStorage"
// (see leads.functions.test.ts). Pulling the body out was exactly so the guard
// below could be tested.
//
// What is worth pinning is that the function never reports a delete it did not
// do. There is no copy of a contact message anywhere else in the product, so a
// manager who is told one is gone has no way to check, and the three ways this
// could go wrong are all silent: a filter that matched nothing reported as a
// success, a database error swallowed, and a match on the wrong column.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MESSAGE_ALREADY_GONE, deleteContactMessageRow } from "./contact-messages.functions";

type QueryResult = { data: unknown; error: { message: string } | null };

/**
 * A PostgREST chain that answers the delete with a queued result and records the
 * table and filter it was given. The filter is recorded rather than ignored
 * because matching the wrong column is the failure that destroys a stranger's
 * message, and a fake that swallowed `.eq()` would keep every test green while
 * the code deleted by something else.
 */
function fakeAdmin(result: QueryResult) {
  const calls: Array<{ table: string; deleted: boolean; filters: Array<[string, unknown]> }> = [];
  const admin = {
    from(table: string) {
      const record = { table, deleted: false, filters: [] as Array<[string, unknown]> };
      calls.push(record);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        delete: () => {
          record.deleted = true;
          return chain;
        },
        eq: (col: string, value: unknown) => {
          record.filters.push([col, value]);
          return chain;
        },
        select: () => Promise.resolve(result),
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, calls };
}

const ID = "11111111-1111-1111-1111-111111111111";

describe("deleteContactMessageRow", () => {
  it("deletes the row matching the id, and says which one went", async () => {
    const { admin, calls } = fakeAdmin({ data: [{ id: ID }], error: null });

    await expect(deleteContactMessageRow(admin, ID)).resolves.toEqual({ id: ID });

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("contact_messages");
    expect(calls[0].deleted).toBe(true);
    // By id, and by nothing else. Deleting on a name or an address would take
    // every message that person ever sent, not the one that was on screen.
    expect(calls[0].filters).toEqual([["id", ID]]);
  });

  it("refuses to report a delete when the filter matched nothing", async () => {
    // PostgREST returns no error for a delete that hit no rows, so without the
    // guard this path reported success over a message that was never there.
    // Almost always a second manager who got there first.
    const { admin } = fakeAdmin({ data: [], error: null });

    await expect(deleteContactMessageRow(admin, ID)).rejects.toThrow(MESSAGE_ALREADY_GONE);
  });

  it("refuses to report a delete when the row came back null", async () => {
    const { admin } = fakeAdmin({ data: null, error: null });

    await expect(deleteContactMessageRow(admin, ID)).rejects.toThrow(MESSAGE_ALREADY_GONE);
  });

  it("fails closed on a database error rather than claiming the message went", async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: "permission denied" } });

    await expect(deleteContactMessageRow(admin, ID)).rejects.toThrow("permission denied");
  });
});
