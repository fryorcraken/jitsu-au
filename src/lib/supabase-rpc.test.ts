import { describe, expect, it } from "vitest";
import { userEmails, userIdByEmail } from "./supabase-rpc";
import type { ClubUserEmail } from "./club-users";

/**
 * The declared shapes are the whole point of this module, and a runtime test
 * cannot see them: `RpcResult<T>` adds `| null` itself, so `RpcResult<string>`
 * and `RpcResult<string | null>` behave identically at runtime and
 * `expect(data).toBeNull()` passes either way. These assertions fail to compile
 * if someone narrows a wrapper back to what the generated types claim.
 *
 * Same trick as `src/integrations/supabase/schema-contract.test.ts`, which is
 * where the generated side of the same contract is pinned.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Awaited_<T> = T extends Promise<infer U> ? U : never;

/** An unknown address resolves to null, which is the ordinary result. */
export type _UserIdByEmailIsNullable = Expect<
  Equals<Awaited_<ReturnType<typeof userIdByEmail>>["data"], string | null>
>;

/** The rows carry the app's own `ClubUserEmail`, not the generated row type. */
export type _UserEmailsReturnsClubUserEmails = Expect<
  Equals<Awaited_<ReturnType<typeof userEmails>>["data"], ClubUserEmail[] | null>
>;

/** ...and that type keeps a nullable confirmation stamp. */
export type _ConfirmationStampIsNullable = Expect<
  Equals<NonNullable<ClubUserEmail["email_confirmed_at"]> | null, string | null>
>;

/**
 * A stand-in for a Supabase client's `.rpc()`. Records what it was called with
 * and hands back whatever PostgREST would have.
 */
function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        return Promise.resolve(result);
      },
    },
  };
}

describe("userIdByEmail", () => {
  it("passes the address through to the RPC", async () => {
    const { client, calls } = fakeClient({ data: "u1", error: null });
    const { data } = await userIdByEmail(client, "ada@example.com");
    expect(calls).toEqual([{ fn: "user_id_by_email", args: { _email: "ada@example.com" } }]);
    expect(data).toBe("u1");
  });

  it("returns null for an address nobody has", async () => {
    // The generated type calls this `string`. It is the ordinary result for
    // every new signer, and `submitWaiverWithPdf` branches on it to decide
    // whether to create a locked applicant.
    const { client } = fakeClient({ data: null, error: null });
    const { data, error } = await userIdByEmail(client, "nobody@example.com");
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it("hands the error back rather than throwing", async () => {
    // Call sites differ on whether an RPC failure is fatal (a waiver submission
    // throws, a token lookup shrugs), so the wrapper must not decide for them.
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    const { data, error } = await userIdByEmail(client, "ada@example.com");
    expect(data).toBeNull();
    expect(error?.message).toBe("boom");
  });
});

describe("userEmails", () => {
  it("keeps a null email_confirmed_at as null", async () => {
    // Nobody has confirmed this address. The generated type says `string`,
    // which would badge every unverified person as verified.
    const { client, calls } = fakeClient({
      data: [{ user_id: "u1", email: "ada@example.com", email_confirmed_at: null }],
      error: null,
    });
    const { data } = await userEmails(client, ["u1"]);
    expect(calls).toEqual([{ fn: "user_emails", args: { _user_ids: ["u1"] } }]);
    expect(data).toEqual([{ user_id: "u1", email: "ada@example.com", email_confirmed_at: null }]);
  });

  it("hands a failure back with no rows", async () => {
    const { client } = fakeClient({ data: null, error: { message: "denied" } });
    const { data, error } = await userEmails(client, ["u1"]);
    expect(data).toBeNull();
    expect(error?.message).toBe("denied");
  });

  it("normalizes an absent result to null", async () => {
    // The `?? null` in each wrapper is the module's only runtime behavior.
    // PostgREST returns null rather than undefined, but the wrappers are what
    // guarantee callers never have to tell the two apart, so pin it.
    const { client } = fakeClient({ data: undefined, error: null });
    expect((await userEmails(client, ["u1"])).data).toBeNull();

    const idClient = fakeClient({ data: undefined, error: null });
    expect((await userIdByEmail(idClient.client, "nobody@example.com")).data).toBeNull();
  });
});
