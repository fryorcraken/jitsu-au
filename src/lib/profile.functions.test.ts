// The self-serve write onto `profiles`, and the gate in front of it.
//
// This is the only path by which one person's click writes another person's
// row, so the rule worth pinning is not what it saves but WHOSE row it lands
// on. Testing the extracted body rather than the `createServerFn` wrapper is
// the point: the wrapper cannot be called from the runner, so a gate left
// inside it could be deleted with the whole suite still green. It was, once,
// which is why this file exists.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { updateProfileForCaller } from "./profile.functions";

const PARENT = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const STRANGER = "aaaaaaaa-0000-4000-8000-000000000003";
const STRANGERS_CHILD = "aaaaaaaa-0000-4000-8000-000000000004";

const HOUSEHOLD = [
  { user_id: PARENT, guardian_user_id: null },
  { user_id: CHILD, guardian_user_id: PARENT },
  { user_id: STRANGER, guardian_user_id: null },
  { user_id: STRANGERS_CHILD, guardian_user_id: STRANGER },
];

/**
 * A `profiles` table that answers the gate's read and records the UPDATE it was
 * given. The filter is recorded rather than swallowed because writing to the
 * wrong `user_id` is the failure this whole module is defending against, and a
 * fake that ignored `.eq()` would stay green through it.
 */
function fakeAdmin() {
  const writes: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const admin = {
    from(table: string) {
      if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => ({
          in: (_column: string, values: string[]) =>
            Promise.resolve({
              data: HOUSEHOLD.filter((r) => values.includes(r.user_id)),
              error: null,
            }),
        }),
        update: (values: Record<string, unknown>) => {
          const record = { values, filters: [] as Array<[string, unknown]> };
          writes.push(record);
          const write: {
            eq: (c: string, v: unknown) => typeof write;
            select: () => Promise<{ data: unknown; error: null }>;
          } = {
            eq: (column: string, value: unknown) => {
              record.filters.push([column, value]);
              return write;
            },
            select: () => Promise.resolve({ data: [{ user_id: value(record) }], error: null }),
          };
          return write;
        },
      };
      return chain;
    },
  };
  const value = (r: { filters: Array<[string, unknown]> }) => r.filters[0]?.[1];
  return { admin: admin as unknown as SupabaseClient<Database>, writes };
}

describe("updateProfileForCaller", () => {
  it("writes the caller's own row when no target is named", async () => {
    const { admin, writes } = fakeAdmin();
    await updateProfileForCaller(admin, PARENT, { phone: "0400 000 111" });
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toEqual([["user_id", PARENT]]);
    expect(writes[0].values).toMatchObject({ phone: "0400 000 111" });
  });

  it("writes a dependant's row when their own guardian names them", async () => {
    const { admin, writes } = fakeAdmin();
    await updateProfileForCaller(admin, PARENT, { userId: CHILD, phone: "0400 000 222" });
    expect(writes[0].filters).toEqual([["user_id", CHILD]]);
  });

  // The mutation this file exists to catch: without the gate, this writes.
  it("refuses somebody else's dependant, and writes NOTHING", async () => {
    const { admin, writes } = fakeAdmin();
    await expect(
      updateProfileForCaller(admin, PARENT, { userId: STRANGERS_CHILD, phone: "0400 000 333" }),
    ).rejects.toThrow(/only see your own account/i);
    expect(writes).toHaveLength(0);
  });

  it("refuses another account holder, and writes NOTHING", async () => {
    const { admin, writes } = fakeAdmin();
    await expect(
      updateProfileForCaller(admin, PARENT, { userId: STRANGER, media_consent: false }),
    ).rejects.toThrow(/only see your own account/i);
    expect(writes).toHaveLength(0);
  });

  // Refused before the patch is even examined, so an empty one cannot be used
  // to find out whether a target would have been accepted.
  it("refuses a forbidden target before deciding the patch is empty", async () => {
    const { admin, writes } = fakeAdmin();
    await expect(
      updateProfileForCaller(admin, PARENT, { userId: STRANGERS_CHILD, phone: undefined }),
    ).rejects.toThrow(/only see your own account/i);
    expect(writes).toHaveLength(0);
  });

  it("never writes `userId` as if it were a column", async () => {
    const { admin, writes } = fakeAdmin();
    await updateProfileForCaller(admin, PARENT, { userId: CHILD, phone: "0400 000 444" });
    expect(writes[0].values).not.toHaveProperty("userId");
  });

  // The provenance names whoever clicked, not who the row is about.
  it("stamps media consent with the person who clicked", async () => {
    const { admin, writes } = fakeAdmin();
    await updateProfileForCaller(admin, PARENT, { userId: CHILD, media_consent: true });
    expect(writes[0].values.media_consent_updated_by).toBe(PARENT);
    expect(writes[0].filters).toEqual([["user_id", CHILD]]);
  });
});
