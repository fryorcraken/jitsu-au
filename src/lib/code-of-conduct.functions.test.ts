// Whose code-of-conduct standing this page reports.
//
// The rule worth pinning is the one that separates the two ways somebody can be
// identified here. A session is proof of who you are. An emailed link is proof
// of an ADDRESS and nothing more, and anyone can mint one of these for any
// address by signing a public waiver, so a link must never be able to read a
// household. That is one `if`, and without this file nothing would notice it
// going missing.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { codeOfConductSubject } from "./code-of-conduct.functions";

const PARENT = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const STRANGERS_CHILD = "aaaaaaaa-0000-4000-8000-000000000003";

/** A `profiles` table holding one family and one unrelated child. */
const admin = {
  from: () => ({
    select: () => ({
      in: (_column: string, values: string[]) =>
        Promise.resolve({
          data: [
            { user_id: PARENT, guardian_user_id: null },
            { user_id: CHILD, guardian_user_id: PARENT },
            { user_id: STRANGERS_CHILD, guardian_user_id: "someone-else" },
          ].filter((r) => values.includes(r.user_id)),
          error: null,
        }),
    }),
  }),
} as unknown as SupabaseClient<Database>;

const signedIn = { userId: PARENT, signedIn: true };
const viaLink = { userId: PARENT, signedIn: false };

describe("codeOfConductSubject", () => {
  it("reports on the signer when no target was named", async () => {
    await expect(codeOfConductSubject(admin, signedIn, undefined)).resolves.toBe(PARENT);
    await expect(codeOfConductSubject(admin, viaLink, undefined)).resolves.toBe(PARENT);
  });

  it("lets a signed-in guardian ask about their own dependant", async () => {
    await expect(codeOfConductSubject(admin, signedIn, CHILD)).resolves.toBe(CHILD);
  });

  it("refuses a signed-in caller somebody else's dependant", async () => {
    await expect(codeOfConductSubject(admin, signedIn, STRANGERS_CHILD)).rejects.toThrow(
      /only see your own account/i,
    );
  });

  // The one that matters. A code-of-conduct token is handed back by the public
  // waiver submit, so possessing one proves nothing about who is holding it.
  it("refuses a target to somebody identified by an emailed link, even their own child", async () => {
    await expect(codeOfConductSubject(admin, viaLink, CHILD)).rejects.toThrow(/sign in/i);
  });

  // A link-identified caller asking about themselves is the ordinary
  // /code-of-conduct case and must keep working.
  it("still lets a link-identified caller read their own standing", async () => {
    await expect(codeOfConductSubject(admin, viaLink, PARENT)).resolves.toBe(PARENT);
  });
});
