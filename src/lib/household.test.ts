// The household gate. What is pinned here is WHO may act for whom, because
// every server function that grows an optional target defers to this and none
// of them re-derives the rule.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  assertActingFor,
  assertMayHaveDependants,
  contactUserIdFor,
  householdTargetSchema,
  isDependant,
  listHousehold,
  mayActFor,
  resolveSubject,
} from "./household";

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

/**
 * Fake admin serving `rows` through the two query shapes this module uses.
 *
 * It answers only for `profiles` and returns only the columns actually named in
 * `.select()`, because a fake that ignored either would stay green if the code
 * were pointed at the wrong table or stopped selecting `guardian_user_id` --
 * and the second of those is the whole discriminator the gate reads.
 */
function admin(rows: Row[]) {
  const pick = (columns: string, row: Row) => {
    const names = columns.split(",").map((c) => c.trim());
    return Object.fromEntries(
      names.map((n) => [n, (row as Record<string, unknown>)[n]]),
    ) as unknown as Row;
  };
  return {
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
      return {
        select: (columns: string) => ({
          in: (column: keyof Row, values: string[]) =>
            Promise.resolve({
              data: rows
                .filter((r) => values.includes(r[column] as string))
                .map((r) => pick(columns, r)),
              error: null,
            }),
          eq: (column: keyof Row, value: string) => {
            const matched = rows.filter((r) => r[column] === value).map((r) => pick(columns, r));
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
      };
    },
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

describe("assertMayHaveDependants", () => {
  // The other half of the one-level rule, for the moment BEFORE a dependant
  // exists: `assertActingFor` can only answer "may A act for B", and creating a
  // child has no B yet.
  it("allows an account holder", async () => {
    await expect(assertMayHaveDependants(admin(EVERYONE), "parent")).resolves.toBeUndefined();
  });

  it("allows an account holder who has no dependants yet", async () => {
    // The first child on an account has to be creatable, or the feature can
    // never start.
    await expect(assertMayHaveDependants(admin(EVERYONE), "stranger")).resolves.toBeUndefined();
  });

  it("refuses a dependant, so a household can never be more than one deep", async () => {
    await expect(assertMayHaveDependants(admin(EVERYONE), "child")).rejects.toThrow(
      /only see or change your own account/i,
    );
  });

  it("refuses somebody with no profile row, in the same words", async () => {
    // Fails closed, and says nothing about whether the id is a real person:
    // the same sentence whatever the cause, exactly as `assertActingFor` does.
    await expect(assertMayHaveDependants(admin(EVERYONE), "nobody")).rejects.toThrow(
      /only see or change your own account/i,
    );
  });

  it("is case-insensitive about the id it is given", async () => {
    await expect(
      assertMayHaveDependants(admin(EVERYONE), "PARENT".toLowerCase()),
    ).resolves.toBeUndefined();
  });

  it("surfaces a failed read rather than reading it as allowed or denied", async () => {
    // A database that cannot answer must not be mistaken for a yes, and the
    // refusal sentence would be a lie about why.
    await expect(assertMayHaveDependants(erroringAdmin, "parent")).rejects.toThrow("boom");
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

  // A gate that can refuse somebody their own account page is an outage, not a
  // gate. Nobody is reaching past themselves, so nothing needs checking, and
  // that must not depend on a query that can fail or on a row that may be
  // missing.
  it("never asks the database about somebody acting for themselves", async () => {
    await expect(assertActingFor(erroringAdmin, "parent", "parent")).resolves.toBeUndefined();
    await expect(assertActingFor(db, "ghost", "ghost")).resolves.toBeUndefined();
  });

  it("lets a guardian act for their own dependant", async () => {
    await expect(assertActingFor(db, "parent", "child")).resolves.toBeUndefined();
    await expect(assertActingFor(db, "parent", "sibling")).resolves.toBeUndefined();
  });

  it("refuses somebody else's dependant", async () => {
    await expect(assertActingFor(db, "parent", "their-child")).rejects.toThrow(
      /only see or change your own account/i,
    );
  });

  it("refuses another account holder", async () => {
    await expect(assertActingFor(db, "parent", "stranger")).rejects.toThrow(
      /only see or change your own account/i,
    );
  });

  // A dependant cannot sign in at all, so this is defence in depth. It refuses
  // them everybody else, including their own guardian and their sibling, while
  // still letting them see themselves: locking a person out of their own
  // account page buys nothing and costs everything.
  it("refuses a dependant everyone except themselves", async () => {
    await expect(assertActingFor(db, "child", "sibling")).rejects.toThrow(
      /only see or change your own account/i,
    );
    await expect(assertActingFor(db, "child", "parent")).rejects.toThrow(
      /only see or change your own account/i,
    );
    await expect(assertActingFor(db, "child", "child")).resolves.toBeUndefined();
  });

  // The one-level rule. The database enforces only "nobody is their own
  // guardian", so a chain is refused here or nowhere.
  it("never walks a second level, even when a bad row builds one", async () => {
    const grandchild: Row = { user_id: "grandchild", guardian_user_id: "child", first_name: "Eve" };
    const chained = admin([...EVERYONE, grandchild]);
    await expect(assertActingFor(chained, "child", "grandchild")).rejects.toThrow(
      /only see or change your own account/i,
    );
    // ...and it is not reachable by skipping a generation either.
    await expect(assertActingFor(chained, "parent", "grandchild")).rejects.toThrow(
      /only see or change your own account/i,
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

  it("refuses a caller with no profile row reaching for anybody else", async () => {
    await expect(assertActingFor(db, "ghost", "child")).rejects.toThrow(
      /only see or change your own account/i,
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

// The uuid a route param or a hand-typed link arrives as is not always the one
// Postgres hands back: `z.string().uuid()` accepts uppercase, Postgres compares
// uuids by value and returns them lowercase, and this module compares strings.
describe("uuid case", () => {
  const UPPER = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  const lower = UPPER.toLowerCase();

  it("normalises a target the schema accepts", () => {
    expect(householdTargetSchema.parse({ userId: UPPER }).userId).toBe(lower);
  });

  it("still recognises a person acting for themselves", async () => {
    const db = admin([{ user_id: lower, guardian_user_id: null }]);
    await expect(assertActingFor(db, lower, UPPER)).resolves.toBeUndefined();
  });

  // Fails closed, so this was never a hole. It was a guardian being told they
  // could not see their own child, on a query that would have matched fine.
  it("still finds a guardian's own dependant", async () => {
    const db = admin([
      { user_id: lower, guardian_user_id: null },
      { user_id: "kid", guardian_user_id: lower },
    ]);
    await expect(assertActingFor(db, UPPER, "kid")).resolves.toBeUndefined();
    await expect(assertActingFor(db, lower, "KID".toLowerCase())).resolves.toBeUndefined();
  });
});

// `resolveSubject` is the seam the handlers actually call. It exists so that
// getting the subject IS going through the gate, rather than two lines that
// have to agree.
describe("resolveSubject", () => {
  const db = admin(EVERYONE);

  it("answers the caller when no target was named", async () => {
    await expect(resolveSubject(db, "parent", undefined)).resolves.toBe("parent");
  });

  // The failure this shape rules out: gate one id, then read another.
  it("answers the target it just checked, never the caller", async () => {
    await expect(resolveSubject(db, "parent", "child")).resolves.toBe("child");
  });

  it("refuses rather than quietly falling back to the caller", async () => {
    await expect(resolveSubject(db, "parent", "their-child")).rejects.toThrow(
      /only see or change your own account/i,
    );
    await expect(resolveSubject(db, "parent", "nobody")).rejects.toThrow(
      /only see or change your own account/i,
    );
  });

  it("does not consult the database for a caller asking about themselves", async () => {
    await expect(resolveSubject(erroringAdmin, "parent", undefined)).resolves.toBe("parent");
    await expect(resolveSubject(erroringAdmin, "parent", "parent")).resolves.toBe("parent");
  });
});

describe("mayActFor", () => {
  // The same gate as `assertActingFor`, answered instead of thrown. It exists
  // for the one caller whose refusal has to say something else, so what matters
  // is that the two never disagree: `assertActingFor` is defined in terms of
  // this, and these cases hold both to the same answers.
  it("agrees with assertActingFor on every case", async () => {
    const db = admin(EVERYONE);
    const cases: [string, string, boolean][] = [
      ["parent", "parent", true],
      ["parent", "child", true],
      ["parent", "sibling", true],
      ["parent", "their-child", false],
      ["parent", "stranger", false],
      ["child", "parent", false],
      ["child", "sibling", false],
      ["stranger", "child", false],
      ["parent", "nobody", false],
      ["nobody", "child", false],
    ];
    for (const [caller, target, allowed] of cases) {
      expect(await mayActFor(db, caller, target)).toBe(allowed);
      const assertion = assertActingFor(db, caller, target);
      if (allowed) await expect(assertion).resolves.toBeUndefined();
      else await expect(assertion).rejects.toThrow(/only see or change your own account/);
    }
  });

  it("throws on a failed read rather than answering no", async () => {
    // "We could not ask" is not "no". Flattening it would turn an outage into a
    // refusal at every call site.
    await expect(mayActFor(erroringAdmin, "parent", "child")).rejects.toThrow("boom");
  });
});
