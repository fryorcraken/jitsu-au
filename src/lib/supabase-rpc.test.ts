import { describe, expect, it } from "vitest";
import { userEmails, userIdByEmail } from "./supabase-rpc";

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

  it("normalizes a missing result to null", async () => {
    const { client } = fakeClient({ data: null, error: { message: "denied" } });
    const { data, error } = await userEmails(client, ["u1"]);
    expect(data).toBeNull();
    expect(error?.message).toBe("denied");
  });
});
