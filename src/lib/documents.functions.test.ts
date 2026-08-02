// `authorNames` / `managerAuthorNames` are the pieces of documents.functions.ts
// reachable from a unit test without a Start request context (the
// `createServerFn` handlers die on "No Start context found in
// AsyncLocalStorage" when called from the runner — see
// blog-comments.functions.test.ts / waiver.functions.test.ts). They take
// their db client as a parameter for exactly that reason.
import { describe, expect, it } from "vitest";
import type { DocumentClient } from "@/lib/document-types";
import { authorNames, managerAuthorNames } from "./documents.functions";

type ProfileRow = {
  user_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  display_name: string | null;
};

/**
 * A fake `profiles` table that actually honours the `.select()` column list,
 * the way PostgREST does — a query that forgets to select a column gets
 * `undefined` back for it, not whatever the fixture happened to hold. Without
 * this, a regression that drops a column from the real `.select()` call would
 * pass every test here silently.
 */
function fakeDb(profiles: ProfileRow[], opts: { error?: { message: string } } = {}) {
  const db = {
    from(table: string) {
      if (table !== "profiles") throw new Error(`fakeDb: unexpected table ${table}`);
      return {
        select: (columns: string) => {
          const wanted = columns.split(",").map((c) => c.trim());
          return {
            in: (_column: string, ids: string[]) => {
              if (opts.error) return Promise.resolve({ data: null, error: opts.error });
              const rows = profiles
                .filter((p) => ids.includes(p.user_id))
                .map((p) => Object.fromEntries(wanted.map((c) => [c, p[c as keyof ProfileRow]])));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
  return db as unknown as DocumentClient;
}

const ADA = "11111111-1111-1111-1111-111111111111";
const ADA_2 = "22222222-2222-2222-2222-222222222222";

const ADA_ROW: ProfileRow = {
  user_id: ADA,
  first_name: "Ada",
  middle_name: null,
  last_name: "Lovelace",
  preferred_name: "Addy",
  display_name: "The Countess",
};

describe("authorNames (member-facing)", () => {
  it("prefers the display_name override over everything else", async () => {
    const db = fakeDb([ADA_ROW]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("The Countess");
  });

  it("falls back to preferred name + last initial when there's no override", async () => {
    const db = fakeDb([{ ...ADA_ROW, display_name: null }]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Addy L.");
  });

  it("falls back to first name + last initial when there's no preferred name either", async () => {
    const db = fakeDb([{ ...ADA_ROW, display_name: null, preferred_name: null }]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Ada L.");
  });

  it("shows just the base name when there's no last name", async () => {
    const db = fakeDb([{ ...ADA_ROW, display_name: null, preferred_name: null, last_name: null }]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Ada");
  });

  it("never leaks the full legal name: it does not select middle_name", async () => {
    // A regression that widened the select to `*` (or re-added middle_name)
    // would not be caught by the happy-path tests above, since
    // commentDisplayName never reads middle_name either way. Assert the query
    // itself stays narrow.
    let requestedColumns = "";
    const db = {
      from: () => ({
        select: (columns: string) => {
          requestedColumns = columns;
          return { in: () => Promise.resolve({ data: [], error: null }) };
        },
      }),
    } as unknown as DocumentClient;
    await authorNames(db, [ADA]);
    expect(requestedColumns).not.toMatch(/middle_name/);
  });

  it("gives two same-first-name authors distinguishable names", async () => {
    const db = fakeDb([
      { ...ADA_ROW, display_name: null, preferred_name: null },
      {
        user_id: ADA_2,
        first_name: "Ada",
        middle_name: null,
        last_name: "Perkins",
        preferred_name: null,
        display_name: null,
      },
    ]);
    const names = await authorNames(db, [ADA, ADA_2]);
    expect(names.get(ADA)).toBe("Ada L.");
    expect(names.get(ADA_2)).toBe("Ada P.");
    expect(names.get(ADA)).not.toBe(names.get(ADA_2));
  });

  it("returns an empty map without querying when there are no user ids", async () => {
    const db = fakeDb([]);
    const names = await authorNames(db, []);
    expect(names.size).toBe(0);
  });

  it("returns an empty map, not a thrown error, when the lookup fails", async () => {
    const db = fakeDb([ADA_ROW], { error: { message: "boom" } });
    const names = await authorNames(db, [ADA]);
    expect(names.size).toBe(0);
  });

  it("omits authors with no matching profile row, so the UI falls back", async () => {
    const db = fakeDb([ADA_ROW]);
    const names = await authorNames(db, [ADA, ADA_2]);
    expect(names.has(ADA_2)).toBe(false);
    expect(names.get(ADA_2)).toBeUndefined();
  });
});

describe("managerAuthorNames (manager-facing)", () => {
  it("shows the full legal name, ignoring any display_name override", async () => {
    const db = fakeDb([ADA_ROW]);
    const names = await managerAuthorNames(db, [ADA]);
    expect(names.get(ADA)).toBe('Ada "Addy" Lovelace');
  });

  it("falls back to the plain legal name when there's no preferred name", async () => {
    const db = fakeDb([{ ...ADA_ROW, preferred_name: null }]);
    const names = await managerAuthorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Ada Lovelace");
  });
});
