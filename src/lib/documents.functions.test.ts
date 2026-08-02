// `authorNames` is the piece of documents.functions.ts reachable from a unit
// test without a Start request context (the `createServerFn` handlers die on
// "No Start context found in AsyncLocalStorage" when called from the runner —
// see blog-comments.functions.test.ts / waiver.functions.test.ts). It takes
// its db client as a parameter for exactly that reason.
import { describe, expect, it } from "vitest";
import type { DocumentClient } from "@/lib/document-types";
import { authorNames } from "./documents.functions";

type ProfileRow = {
  user_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  display_name: string | null;
};

function fakeDb(profiles: ProfileRow[]) {
  const db = {
    from(table: string) {
      if (table !== "profiles") throw new Error(`fakeDb: unexpected table ${table}`);
      return {
        select: () => ({
          in: (_column: string, ids: string[]) =>
            Promise.resolve({
              data: profiles.filter((p) => ids.includes(p.user_id)),
              error: null,
            }),
        }),
      };
    },
  };
  return db as unknown as DocumentClient;
}

const ADA = "11111111-1111-1111-1111-111111111111";
const ADA_2 = "22222222-2222-2222-2222-222222222222";

describe("authorNames", () => {
  it("prefers the display_name override over everything else", async () => {
    const db = fakeDb([
      {
        user_id: ADA,
        first_name: "Ada",
        middle_name: null,
        last_name: "Lovelace",
        preferred_name: "Addy",
        display_name: "The Countess",
      },
    ]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("The Countess");
  });

  it("falls back to preferred name + last initial when there's no override", async () => {
    const db = fakeDb([
      {
        user_id: ADA,
        first_name: "Ada",
        middle_name: null,
        last_name: "Lovelace",
        preferred_name: "Addy",
        display_name: null,
      },
    ]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Addy L.");
  });

  it("falls back to first name + last initial when there's no preferred name either", async () => {
    const db = fakeDb([
      {
        user_id: ADA,
        first_name: "Ada",
        middle_name: null,
        last_name: "Lovelace",
        preferred_name: null,
        display_name: null,
      },
    ]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Ada L.");
  });

  it("shows just the base name when there's no last name", async () => {
    const db = fakeDb([
      {
        user_id: ADA,
        first_name: "Ada",
        middle_name: null,
        last_name: null,
        preferred_name: null,
        display_name: null,
      },
    ]);
    const names = await authorNames(db, [ADA]);
    expect(names.get(ADA)).toBe("Ada");
  });

  it("gives two same-first-name authors distinguishable names", async () => {
    const db = fakeDb([
      {
        user_id: ADA,
        first_name: "Ada",
        middle_name: null,
        last_name: "Lovelace",
        preferred_name: null,
        display_name: null,
      },
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
});
