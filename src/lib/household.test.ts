// The household gate. What is pinned here is WHO may act for whom, because
// every server function that grows an optional target defers to this and none
// of them re-derives the rule.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assertActingFor, contactUserIdFor, isDependant, listHousehold } from "./household";

type Row = {
  user_id: string;
  guardian_user_id: string | null;
  first_name?: string;
  last_name?: string | null;
  preferred_name?: string | null;
  date_of_birth?: string | null;
};

/** A parent, their two children, and an unrelated family. */
const PARENT: Row = { user_id: "parent", guardian_user_id: null, first_name: "Ada" };
const CHILD: Row = { user_id: "child", guardian_user_id: "parent", first_name: "Bea" };
const SIBLING: Row = { user_id: "sibling", guardian_user_id: "parent", first_name: "Ali" };
const STRANGER: Row = { user_id: "stranger", guardian_user_id: null, first_name: "Cy" };
const THEIR_CHILD: Row = { user_id: "their-child", guardian_user_id: "stranger", first_name: "Di" };

const EVERYONE = [PARENT, CHILD, SIBLING, STRANGER, THEIR_CHILD];

/** Fake admin serving `rows` through the two query shapes this module uses. */
function admin(rows: Row[]) {
  return {
    from: () => ({
      select: () => ({
        in: (column: keyof Row, values: string[]) =>
          Promise.resolve({
            data: rows.filter((r) => values.includes(r[column] as string)),
            error: null,
          }),
        eq: (column: keyof Row, value: string) => {
          const matched = rows.filter((r) => r[column] === value);
          return {
            maybeSingle: () => Promise.resolve({ data: matched[0] ?? null, error: null }),
            order: (column2: keyof Row) =>
              Promise.resolve({
                data: [...matched].sort((a, b) =>
                  String(a[column2]).localeCompare(String(b[column2])),
                ),
                error: null,
              }),
          };
        },
      }),
    }),
  } as unknown as SupabaseClient<Database>;
}

/** Fake admin whose profiles read comes back as a PostgREST error. */
const erroringAdmin = {
  from: () => ({
    select: () => ({
      in: () => Promise.resolve({ data: null, error: { message: "boom" } }),
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        order: () => Promise.resolve({ data: null, error: { message: "boom" } }),
      }),
    }),
  }),
} as unknown as SupabaseClient<Database>;

describe("isDependant", () => {
  it("is the guardian link and nothing else", () => {
    expect(isDependant(CHILD)).toBe(true);
    expect(isDependant(PARENT)).toBe(false);
  });
});

describe("contactUserIdFor", () => {
  // A dependant's own address is reserved and non-deliverable, so "who do we
  // write to" can never resolve to the dependant themselves.
  it("sends a dependant's mail to their guardian", () => {
    expect(contactUserIdFor(CHILD)).toBe("parent");
  });

  it("sends an account holder's mail to themselves", () => {
    expect(contactUserIdFor(PARENT)).toBe("parent");
  });
});

describe("assertActingFor", () => {
  const db = admin(EVERYONE);

  it("lets somebody act for themselves", async () => {
    await expect(assertActingFor(db, "parent", "parent")).resolves.toBeUndefined();
  });

  it("lets a guardian act for their own dependant", async () => {
    await expect(assertActingFor(db, "parent", "child")).resolves.toBeUndefined();
    await expect(assertActingFor(db, "parent", "sibling")).resolves.toBeUndefined();
  });

  it("refuses somebody else's dependant", async () => {
    await expect(assertActingFor(db, "parent", "their-child")).rejects.toThrow(
      /only see your own account/i,
    );
  });

  it("refuses another account holder", async () => {
    await expect(assertActingFor(db, "parent", "stranger")).rejects.toThrow(
      /only see your own account/i,
    );
  });

  // A dependant has no login at all, so a session claiming to be one should not
  // exist. It is refused for everybody, itself included, rather than trusted.
  it("refuses a dependant acting for anyone, including themselves", async () => {
    await expect(assertActingFor(db, "child", "child")).rejects.toThrow(
      /only see your own account/i,
    );
    await expect(assertActingFor(db, "child", "sibling")).rejects.toThrow(
      /only see your own account/i,
    );
    await expect(assertActingFor(db, "child", "parent")).rejects.toThrow(
      /only see your own account/i,
    );
  });

  // The one-level rule. The database enforces only "nobody is their own
  // guardian", so a chain is refused here or nowhere.
  it("never walks a second level, even when a bad row builds one", async () => {
    const grandchild: Row = { user_id: "grandchild", guardian_user_id: "child", first_name: "Eve" };
    const chained = admin([...EVERYONE, grandchild]);
    await expect(assertActingFor(chained, "child", "grandchild")).rejects.toThrow(
      /only see your own account/i,
    );
    // ...and it is not reachable by skipping a generation either.
    await expect(assertActingFor(chained, "parent", "grandchild")).rejects.toThrow(
      /only see your own account/i,
    );
  });

  // Otherwise the gate answers "is this a real person at the club?" to anybody
  // who can type a uuid.
  it("refuses an unknown target in the same words as a forbidden one", async () => {
    const unknown = await assertActingFor(db, "parent", "nobody").catch((e: Error) => e.message);
    const forbidden = await assertActingFor(db, "parent", "their-child").catch(
      (e: Error) => e.message,
    );
    expect(unknown).toBe(forbidden);
  });

  it("refuses a caller with no profile row", async () => {
    await expect(assertActingFor(db, "ghost", "ghost")).rejects.toThrow(
      /only see your own account/i,
    );
  });

  // A dropped read is not permission to proceed, and it is not a refusal
  // either: it says what actually happened.
  it("surfaces a failed read rather than reading it as allowed or denied", async () => {
    await expect(assertActingFor(erroringAdmin, "parent", "child")).rejects.toThrow("boom");
  });
});

describe("listHousehold", () => {
  const db = admin(EVERYONE);

  it("puts the account holder first, then their dependants by name", async () => {
    expect((await listHousehold(db, "parent")).map((m) => m.user_id)).toEqual([
      "parent",
      "sibling",
      "child",
    ]);
  });

  it("does not reach into another family", async () => {
    expect((await listHousehold(db, "stranger")).map((m) => m.user_id)).toEqual([
      "stranger",
      "their-child",
    ]);
  });

  // Truthful under the one-level rule: a dependant has no dependants of their
  // own. Who may ASK this is `assertActingFor`'s business, not this function's.
  it("returns a dependant on their own", async () => {
    expect((await listHousehold(db, "child")).map((m) => m.user_id)).toEqual(["child"]);
  });

  it("returns nobody for an id with no profile row", async () => {
    expect(await listHousehold(db, "ghost")).toEqual([]);
  });

  it("surfaces a failed read", async () => {
    await expect(listHousehold(erroringAdmin, "parent")).rejects.toThrow("boom");
  });
});
