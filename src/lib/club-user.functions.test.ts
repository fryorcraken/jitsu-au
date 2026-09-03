// Changing a member's login email, as a manager.
//
// `changeClubUserEmail` is a plain function taking its client, for the reason
// `checkin.functions.ts` gives about `applyCoverage`: a `createServerFn` handler
// cannot be called from the runner. What is pinned here is the set of rules a
// reader cannot check by eye, because each of them is about a way GoTrue or a
// second person can make a successful-looking call be wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changeClubUserEmail } from "./club-user.functions";

type AuthUser = { id: string; email: string | null; email_confirmed_at: string | null };

const ADA: AuthUser = {
  id: "ada",
  email: "ada@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
};

vi.mock("@/lib/email-verification.server", () => ({
  revokeVerificationTokensForEmail: () => Promise.resolve(),
  sendVerificationEmail: () => Promise.resolve({ sent: true }),
}));

/**
 * A fake admin client over a tiny auth store.
 *
 * `updateUserById` really writes, so the "did it actually move" re-read below
 * is exercised rather than stubbed -- `refusesUpdate` is how a GoTrue that
 * parks the new address in a pending `email_change` is reproduced.
 */
function fakeAdmin(
  opts: {
    user?: AuthUser | null;
    clashUserId?: string | null;
    refusesUpdate?: boolean;
    getFails?: string;
    clashFails?: string;
    clearFails?: string;
  } = {},
) {
  const user = opts.user === undefined ? { ...ADA } : opts.user;
  const rpcCalls: { fn: string; args: unknown }[] = [];

  const admin = {
    auth: {
      admin: {
        getUserById: () =>
          Promise.resolve(
            opts.getFails
              ? { data: { user: null }, error: { message: opts.getFails } }
              : { data: { user }, error: null },
          ),
        updateUserById: (_id: string, patch: { email: string }) => {
          if (user && !opts.refusesUpdate) user.email = patch.email;
          return Promise.resolve({ data: { user }, error: null });
        },
      },
    },
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "user_id_by_email")
        return Promise.resolve(
          opts.clashFails
            ? { data: null, error: { message: opts.clashFails } }
            : { data: opts.clashUserId ?? null, error: null },
        );
      if (fn === "clear_email_confirmation")
        return Promise.resolve(
          opts.clearFails
            ? { data: null, error: { message: opts.clearFails } }
            : { data: null, error: null },
        );
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { admin, rpcCalls, user };
}

const run = (fake: ReturnType<typeof fakeAdmin>, email = "new@example.com", id = "ada") =>
  changeClubUserEmail(fake.admin as never, id, email);

describe("changeClubUserEmail", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves the address and drops the verified badge", async () => {
    const fake = fakeAdmin();
    await expect(run(fake)).resolves.toMatchObject({
      ok: true,
      email: "new@example.com",
      changed: true,
      verified: false,
    });
    expect(fake.user?.email).toBe("new@example.com");
  });

  // The badge is a claim that somebody opened a link at THIS address. A new
  // address has never been proven, whatever was true of the old one, and GoTrue
  // does not reliably clear the flag when asked not to set one.
  it("clears the confirmation outright rather than trusting GoTrue to have done it", async () => {
    const fake = fakeAdmin();
    await run(fake);
    expect(fake.rpcCalls.map((c) => c.fn)).toContain("clear_email_confirmation");
  });

  it("re-saving the same address costs nobody their verified badge", async () => {
    // Normalised by the caller (`setClubUserEmail` does it), which is what makes
    // the comparison inside meaningful: what is stored on the login record is
    // normalised before it is compared, so a manager re-typing the address in a
    // different case still lands here rather than on a pointless rewrite.
    const fake = fakeAdmin();
    await expect(run(fake, "ada@example.com")).resolves.toMatchObject({
      changed: false,
      verified: true,
    });
    // Nothing was written, so nothing was cleared either.
    expect(fake.rpcCalls.map((c) => c.fn)).not.toContain("clear_email_confirmation");
  });

  // One person per email is the model's core invariant. Merging two people is a
  // different problem, so this refuses rather than half-doing it.
  it("refuses an address that already belongs to somebody else", async () => {
    const fake = fakeAdmin({ clashUserId: "bob" });
    await expect(run(fake)).rejects.toThrow("already belongs to another person");
    expect(fake.user?.email).toBe("ada@example.com");
  });

  it("allows an address the same person already holds under a different case", async () => {
    const fake = fakeAdmin({ clashUserId: "ada" });
    await expect(run(fake)).resolves.toMatchObject({ ok: true });
  });

  // The failure this assertion exists for: some GoTrue configurations answer an
  // email update by parking the new address in a pending `email_change` and
  // leaving `email` alone, which would return success over a person who still
  // holds the old address.
  it("refuses to report success when the login record did not take the address", async () => {
    const fake = fakeAdmin({ refusesUpdate: true });
    await expect(run(fake)).rejects.toThrow("did not accept that email");
  });

  it("fails loudly when the person cannot be read", async () => {
    const fake = fakeAdmin({ getFails: "statement timeout" });
    await expect(run(fake)).rejects.toThrow("statement timeout");
  });

  it("fails loudly when the clash check cannot be run", async () => {
    // "We could not check" is not "there is no clash": answering it as one is
    // how two people end up sharing a login.
    const fake = fakeAdmin({ clashFails: "connection reset" });
    await expect(run(fake)).rejects.toThrow("connection reset");
    expect(fake.user?.email).toBe("ada@example.com");
  });

  it("fails loudly when the confirmation cannot be cleared", async () => {
    const fake = fakeAdmin({ clearFails: "permission denied" });
    await expect(run(fake)).rejects.toThrow("permission denied");
  });

  it("reports a person who is not there", async () => {
    const fake = fakeAdmin({ user: null });
    await expect(run(fake)).rejects.toThrow("User not found.");
  });
});
