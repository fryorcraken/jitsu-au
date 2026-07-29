import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { redeemVerificationToken } from "./email-verification.server";
import { verificationExpiry } from "./email-verification";

type TokenRow = {
  id: string;
  user_id: string | null;
  email: string;
  expires_at: string;
  revoked_at: string | null;
};

function token(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: "tok-1",
    user_id: null,
    email: "ada@example.com",
    expires_at: verificationExpiry(),
    revoked_at: null,
    ...over,
  };
}

/**
 * A fake service-role client covering the chains `redeemVerificationToken`
 * walks: `.from().select().eq().is().maybeSingle()`, the fire-and-forget
 * `.from().update().eq()` thenable, `user_id_by_email`, and the auth admin
 * calls. The row lookup ignores the hash — hashing is already covered by
 * `manager-api-tokens.test.ts`, and these cases are about the guard logic.
 */
function fakeAdmin(opts: {
  row?: TokenRow | null;
  userIdByEmail?: Record<string, string>;
  users?: Record<string, { email: string | null }>;
}) {
  /** User ids this run marked confirmed. The assertion that matters. */
  const confirmed: string[] = [];

  const eqResult = {
    is: () => ({
      maybeSingle: () => Promise.resolve({ data: opts.row ?? null, error: null }),
      then: (res: (v: { error: null }) => void) => {
        res({ error: null });
        return Promise.resolve({ error: null });
      },
    }),
    then: (res: (v: { error: null }) => void) => {
      res({ error: null });
      return Promise.resolve({ error: null });
    },
  };

  const admin = {
    from: () => ({
      select: () => ({ eq: () => eqResult }),
      update: () => ({ eq: () => eqResult }),
    }),
    rpc: (_name: string, args: { _email: string }) =>
      Promise.resolve({ data: opts.userIdByEmail?.[args._email] ?? null, error: null }),
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve(
            opts.users && id in opts.users
              ? { data: { user: opts.users[id] }, error: null }
              : { data: { user: null }, error: new Error("not found") },
          ),
        updateUserById: (id: string) => {
          confirmed.push(id);
          return Promise.resolve({ error: null });
        },
      },
    },
  };

  return { admin: admin as unknown as SupabaseClient<Database>, confirmed };
}

describe("redeemVerificationToken", () => {
  it("confirms the account holding the address the token was mailed to", async () => {
    const { admin, confirmed } = fakeAdmin({
      row: token({ user_id: "u1" }),
      users: { u1: { email: "ada@example.com" } },
    });
    await expect(redeemVerificationToken(admin, "utsj_raw")).resolves.toEqual({
      result: "verified",
      email: "ada@example.com",
      userId: "u1",
    });
    expect(confirmed).toEqual(["u1"]);
  });

  it("refuses to confirm an address the token was not sent to", async () => {
    // The guard the whole design rests on. A manager corrected a typo, so the
    // account now holds a different address; a link sitting in the OLD inbox
    // must not confirm the new one. Before this check it would have.
    const { admin, confirmed } = fakeAdmin({
      row: token({ user_id: "u1", email: "typo@example.com" }),
      users: { u1: { email: "correct@example.com" } },
    });
    await expect(redeemVerificationToken(admin, "utsj_raw")).resolves.toEqual({
      result: "stale",
      email: "typo@example.com",
      userId: "u1",
    });
    expect(confirmed).toEqual([]);
  });

  it("matches the address case-insensitively", async () => {
    const { admin, confirmed } = fakeAdmin({
      row: token({ user_id: "u1", email: "ada@example.com" }),
      users: { u1: { email: "Ada@Example.COM" } },
    });
    const out = await redeemVerificationToken(admin, "utsj_raw");
    expect(out.result).toBe("verified");
    expect(confirmed).toEqual(["u1"]);
  });

  it("resolves a lead's token to the person who now holds that address", async () => {
    // Journey 1: the token was minted before any person existed, so it carries
    // no user id and has to be resolved by address at redemption time.
    const { admin, confirmed } = fakeAdmin({
      row: token({ user_id: null }),
      userIdByEmail: { "ada@example.com": "u9" },
      users: { u9: { email: "ada@example.com" } },
    });
    const out = await redeemVerificationToken(admin, "utsj_raw");
    expect(out.result).toBe("verified");
    expect(confirmed).toEqual(["u9"]);
  });

  it("holds the proof when the address has no person record yet", async () => {
    // A lead who clicked before signing. Not a failure: the token stays live so
    // the waiver submission can apply the proof when the person is created.
    const { admin, confirmed } = fakeAdmin({ row: token({ user_id: null }) });
    await expect(redeemVerificationToken(admin, "utsj_raw")).resolves.toEqual({
      result: "no_person",
      email: "ada@example.com",
    });
    expect(confirmed).toEqual([]);
  });

  it("ignores an expired token", async () => {
    const { admin, confirmed } = fakeAdmin({
      row: token({ user_id: "u1", expires_at: "2020-01-01T00:00:00.000Z" }),
      users: { u1: { email: "ada@example.com" } },
    });
    await expect(redeemVerificationToken(admin, "utsj_raw")).resolves.toEqual({
      result: "no_token",
    });
    expect(confirmed).toEqual([]);
  });

  it("ignores a token that does not exist", async () => {
    const { admin, confirmed } = fakeAdmin({ row: null });
    await expect(redeemVerificationToken(admin, "utsj_raw")).resolves.toEqual({
      result: "no_token",
    });
    expect(confirmed).toEqual([]);
  });

  it("is idempotent, so a second click is harmless", async () => {
    const { admin, confirmed } = fakeAdmin({
      row: token({ user_id: "u1" }),
      users: { u1: { email: "ada@example.com" } },
    });
    await redeemVerificationToken(admin, "utsj_raw");
    await redeemVerificationToken(admin, "utsj_raw");
    expect(confirmed).toEqual(["u1", "u1"]);
  });
});
