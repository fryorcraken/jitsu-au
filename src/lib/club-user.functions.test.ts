// Changing a member's login email, as a manager.
//
// `changeClubUserEmail` is a plain function taking its client, for the reason
// `checkin.functions.ts` gives about `applyCoverage`: a `createServerFn` handler
// cannot be called from the runner. What is pinned here is the set of rules a
// reader cannot check by eye, because each of them is about a way GoTrue or a
// second person can make a successful-looking call be wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changeClubUserEmail, ClubUserNotFoundError, loadClubUser } from "./club-user.functions";
import { GET_USER_LEFT_OUT, projectAgentUser } from "./manager-agent";
import { managerEmailChangeSchema } from "./validation";

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
    /** Whose account this person is on, for `isDependantUser`. */
    guardianUserId?: string | null;
    profileFails?: string;
  } = {},
) {
  const user = opts.user === undefined ? { ...ADA } : opts.user;
  const rpcCalls: { fn: string; args: unknown }[] = [];

  const admin = {
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve(
                opts.profileFails
                  ? { data: null, error: { message: opts.profileFails } }
                  : {
                      data: { user_id: "ada", guardian_user_id: opts.guardianUserId ?? null },
                      error: null,
                    },
              ),
          }),
        }),
      };
    },
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

  // #102's last sharp edge. A dependant's address is a reserved,
  // non-deliverable string with a permanent ban behind it; the whole product
  // reaches them through their guardian.
  describe("a dependant's address", () => {
    it("refuses to move a dependant onto a real address", async () => {
      // The hole this closes is a FRESH address, not the parent's own: the
      // clash check never fired for one, so nothing stopped a manager giving a
      // nine-year-old a working mailbox on their own login.
      const fake = fakeAdmin({ guardianUserId: "parent" });
      await expect(run(fake)).rejects.toThrow("has no email of their own");
      expect(fake.user?.email).toBe("ada@example.com");
    });

    it("refuses before reading or writing anything", async () => {
      // A refusal must leave nothing half-done, and must not be reachable only
      // after the clash check has already told the caller about somebody else.
      const fake = fakeAdmin({ guardianUserId: "parent" });
      await expect(run(fake)).rejects.toThrow();
      expect(fake.rpcCalls).toEqual([]);
    });

    it("says where to change it instead", async () => {
      const fake = fakeAdmin({ guardianUserId: "parent" });
      await expect(run(fake)).rejects.toThrow("account holder's page");
    });

    it("leaves an account holder alone", async () => {
      const fake = fakeAdmin({ guardianUserId: null });
      await expect(run(fake)).resolves.toMatchObject({ ok: true, changed: true });
    });

    // The other direction, and the one the target-side guard does not cover: an
    // ACCOUNT HOLDER moved onto the reserved domain. Nothing allocates one of
    // these by hand, and accepting it costs a member a login that can never be
    // verified plus an outbound send to the one domain the club routes no mail
    // for. Refused by the schema, so it never reaches this function at all.
    it("refuses the reserved dependant domain as an address", () => {
      const id = "11111111-1111-1111-1111-111111111111";
      expect(
        managerEmailChangeSchema.safeParse({ id, userId: id, email: "x@dependant.jitsu.au" })
          .success,
      ).toBe(false);
      // Case and spacing are not a way around it.
      expect(
        managerEmailChangeSchema.safeParse({ userId: id, email: " X@Dependant.Jitsu.AU " }).success,
      ).toBe(false);
      // An ordinary address still goes through.
      expect(
        managerEmailChangeSchema.safeParse({ userId: id, email: "ada@example.com" }).success,
      ).toBe(true);
      // ...and a lookalike that is NOT the reserved domain is not caught by a
      // sloppy substring match.
      expect(
        managerEmailChangeSchema.safeParse({ userId: id, email: "a@notdependant.jitsu.au" })
          .success,
      ).toBe(true);
    });

    it("fails loudly when it cannot tell whether they are a dependant", async () => {
      // "We could not ask" is not "they are an account holder". Answering it as
      // one is exactly how the address would move.
      const fake = fakeAdmin({ profileFails: "connection reset" });
      await expect(run(fake)).rejects.toThrow("connection reset");
      expect(fake.user?.email).toBe("ada@example.com");
    });
  });
});

// ---- The person page's read ----
//
// `loadClubUser` is the one read behind both `/manager/users/<id>` and the
// manager agent API's `get_user`. What is pinned here is the set of things the
// two surfaces must agree on and a reader cannot check by eye: whose address is
// shown for a dependant, which acceptance decides the code-of-conduct state, and
// that a failed read fails rather than rendering as "nothing there".

type Row = Record<string, unknown>;

/**
 * A fake admin client over in-memory tables, honouring the handful of filters
 * the read uses (`eq`, `in`) and the `count` / `head` form of `select`. Order
 * and limit are accepted and ignored: the fixtures are already newest first.
 */
function fakeReadAdmin(
  tables: Record<string, Row[]>,
  opts: {
    emails?: { user_id: string; email: string; email_confirmed_at: string | null }[];
    emailsFail?: string;
    fail?: Record<string, string>;
  } = {},
) {
  const emailAsks: string[][] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let countOnly = false;
    const result = () => {
      if (opts.fail?.[table])
        return { data: null, count: null, error: { message: opts.fail[table] } };
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: countOnly ? null : rows, count: rows.length, error: null };
    };
    const builder = {
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => {
        if (o?.head) countOnly = true;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => {
        const r = result();
        return Promise.resolve({ data: r.data ? (r.data[0] ?? null) : null, error: r.error });
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  };
  const admin = {
    from,
    rpc: (fn: string, args: { _user_ids?: string[] }) => {
      if (fn !== "user_emails") throw new Error(`unexpected rpc: ${fn}`);
      emailAsks.push(args._user_ids ?? []);
      if (opts.emailsFail)
        return Promise.resolve({ data: null, error: { message: opts.emailsFail } });
      return Promise.resolve({
        data: (opts.emails ?? []).filter((e) => args._user_ids?.includes(e.user_id)),
        error: null,
      });
    },
  };
  return { admin, emailAsks };
}

const PERSON = "11111111-1111-4111-8111-111111111111";
const GUARDIAN = "22222222-2222-4222-8222-222222222222";
const MANAGER = "33333333-3333-4333-8333-333333333333";

function profileRow(over: Row = {}): Row {
  return {
    user_id: PERSON,
    first_name: "Ada",
    middle_name: null,
    last_name: "Lovelace",
    preferred_name: null,
    display_name: null,
    phone: "0400 000 001",
    date_of_birth: "1990-01-01",
    address: "1 Example St",
    uts_student_number: null,
    emergency_contact_name: "Bea",
    emergency_contact_relationship: "Sister",
    emergency_contact_phone: "0400 000 002",
    medical_notes: null,
    is_minor: false,
    guardian_user_id: null,
    guardian_name: null,
    guardian_relationship: null,
    guardian_address: null,
    guardian_phone: null,
    guardian_email: null,
    sms_whatsapp_consent: true,
    gi_size: "A2",
    belt_size: "3",
    media_consent: true,
    media_consent_updated_at: null,
    media_consent_updated_by: null,
    martial_arts_experience: null,
    created_at: "2026-01-01T00:00:00+00:00",
    updated_at: "2026-01-02T00:00:00+00:00",
    ...over,
  };
}

function waiverRow(over: Row = {}): Row {
  return {
    id: "w1",
    user_id: PERSON,
    first_name: "Ada",
    middle_name: null,
    last_name: "Lovelace",
    preferred_name: null,
    email: "ada@example.com",
    phone: "0400 000 001",
    date_of_birth: "1990-01-01",
    address: "1 Example St",
    uts_student_number: null,
    sms_whatsapp_consent: true,
    media_consent: true,
    emergency_contact_name: "Bea",
    emergency_contact_relationship: "Sister",
    emergency_contact_phone: "0400 000 002",
    medical_notes: null,
    is_minor: false,
    guardian_name: null,
    guardian_relationship: null,
    guardian_address: null,
    guardian_phone: null,
    guardian_email: null,
    signed_at: "2026-02-01T00:00:00+00:00",
    template_version: 3,
    pdf_path: "w1.pdf",
    approval_status: "approved",
    approved_at: "2026-02-02T00:00:00+00:00",
    approved_by: MANAGER,
    signer_ip: "192.0.2.1",
    signer_meta: {},
    ...over,
  };
}

function baseTables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    profiles: [
      profileRow(),
      { ...profileRow(), user_id: MANAGER, first_name: "Mo", last_name: "Manager" },
    ],
    waivers: [waiverRow()],
    memberships: [
      {
        id: "m1",
        user_id: PERSON,
        plan_id: "p1",
        status: "active",
        price_cents: 12000,
        payment_reference: "REF1",
        starts_at: "2026-02-03T00:00:00+00:00",
        ends_at: "2026-06-30T00:00:00+00:00",
        sessions_remaining: null,
        paid_at: null,
        is_student: false,
        uts_student_number: null,
        created_at: "2026-02-03T00:00:00+00:00",
      },
    ],
    membership_plans: [
      {
        id: "p1",
        name: "Semester 1 2026",
        kind: "period",
        starts_on: null,
        ends_on: null,
        duration_days: null,
      },
    ],
    user_roles: [{ user_id: PERSON, role: "member" }],
    session_checkins: [
      {
        id: "c1",
        user_id: PERSON,
        event_id: "e1",
        checked_in_at: "2026-02-04T00:00:00+00:00",
        coverage: "membership",
        membership_id: "m1",
        consumed_credit: false,
        warnings: [],
      },
    ],
    calendar_events: [{ id: "e1", title: "Tuesday class", starts_at: "2026-02-04T00:00:00+00:00" }],
    code_of_conduct_acceptances: [],
    ...over,
  };
}

const ADA_EMAIL = {
  user_id: PERSON,
  email: "ada@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
};

describe("loadClubUser", () => {
  it("reads one person the way their page shows them", async () => {
    const { admin } = fakeReadAdmin(baseTables(), { emails: [ADA_EMAIL] });
    const read = await loadClubUser(admin as never, PERSON);

    expect(read.user).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
      email_belongs_to: null,
      email_confirmed_at: "2026-01-01T00:00:00Z",
      sessions_attended: 1,
    });
    // Straight off the profile row, not filled in from elsewhere.
    expect(read.profile).toMatchObject({ gi_size: "A2", belt_size: "3", medical_notes: null });
    expect(read.memberships).toEqual([
      expect.objectContaining({ id: "m1", plan_name: "Semester 1 2026", checkin_count: 1 }),
    ]);
    expect(read.checkins).toEqual([
      expect.objectContaining({
        id: "c1",
        event_title: "Tuesday class",
        plan_name: "Semester 1 2026",
      }),
    ]);
    expect(read.waivers).toEqual([
      expect.objectContaining({
        id: "w1",
        // The approved waiver they hold now is their ACTIVE one.
        status: "active",
        template_version: 3,
        has_pdf: true,
        approved_by: MANAGER,
        approved_by_name: "Mo Manager",
      }),
    ]);
  });

  it("shows a dependant their guardian's address, says whose it is, and never asks for the child's", async () => {
    const tables = baseTables({
      profiles: [
        profileRow({ first_name: "Bea", guardian_user_id: GUARDIAN, is_minor: true }),
        profileRow({ user_id: GUARDIAN, first_name: "Ada" }),
      ],
      waivers: [],
    });
    const { admin, emailAsks } = fakeReadAdmin(tables, {
      emails: [{ user_id: GUARDIAN, email: "ada@example.com", email_confirmed_at: null }],
    });
    const read = await loadClubUser(admin as never, PERSON);

    expect(read.user.email).toBe("ada@example.com");
    expect(read.user.email_belongs_to).toBe("Ada Lovelace");
    expect(read.household.guardian).toEqual({ user_id: GUARDIAN, name: "Ada Lovelace" });
    expect(emailAsks).toEqual([[GUARDIAN]]);
  });

  it("reports the highest version agreed to, not the most recent signing", async () => {
    const { admin } = fakeReadAdmin(
      baseTables({
        code_of_conduct_acceptances: [
          {
            user_id: PERSON,
            version: 1,
            accepted_at: "2026-03-01T00:00:00Z",
            signature_name: "Ada L",
          },
          {
            user_id: PERSON,
            version: 2,
            accepted_at: "2026-02-01T00:00:00Z",
            signature_name: "Ada Lovelace",
          },
        ],
      }),
      { emails: [ADA_EMAIL] },
    );
    const read = await loadClubUser(admin as never, PERSON);
    expect(read.code_of_conduct).toMatchObject({
      accepted_version: 2,
      accepted_at: "2026-02-01T00:00:00Z",
      signature_name: "Ada Lovelace",
    });
  });

  it("refuses an id with no profile as not found, not as a failure", async () => {
    const { admin } = fakeReadAdmin(baseTables({ profiles: [] }));
    await expect(loadClubUser(admin as never, PERSON)).rejects.toBeInstanceOf(
      ClubUserNotFoundError,
    );
  });

  it.each(["memberships", "waivers", "session_checkins", "user_roles", "membership_plans"])(
    "fails when the %s read fails, rather than showing an empty section",
    async (table) => {
      const { admin } = fakeReadAdmin(baseTables(), {
        emails: [ADA_EMAIL],
        fail: { [table]: "boom" },
      });
      const err = await loadClubUser(admin as never, PERSON).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ClubUserNotFoundError);
    },
  );

  it("says which sections it could only guess at, and nothing when the read is clean", async () => {
    const clean = await loadClubUser(
      fakeReadAdmin(baseTables(), { emails: [ADA_EMAIL] }).admin as never,
      PERSON,
    );
    expect(clean.degraded).toEqual([]);

    const guessed = await loadClubUser(
      fakeReadAdmin(baseTables(), {
        emailsFail: "rpc down",
        fail: { code_of_conduct_acceptances: "boom" },
      }).admin as never,
      PERSON,
    );
    // The page still renders, exactly as before: no address, "not signed yet".
    expect(guessed.user.email).toBeNull();
    expect(guessed.code_of_conduct.state).toBe("unsigned");
    // ...and says so, which is what lets get_user refuse instead of guessing.
    expect(guessed.degraded).toEqual(["email", "code_of_conduct"]);
  });
});

// ---- get_user reports what the person page shows ----
//
// The manager agent API's `get_user` is this read, projected. The rule
// (`docs/manager-agent-api.md`, "Keep these in sync") is that a manager read
// shown on a screen is reported by the API from the same function, and that
// anything left out is written down with its reason. These pin that rule
// against the REAL read, so a field added to the person page either reaches
// the API or fails here until somebody lists it in `GET_USER_LEFT_OUT`.
describe("projectAgentUser over the person page's read", () => {
  async function readAndProject(
    tables = baseTables(),
    emails: { user_id: string; email: string; email_confirmed_at: string | null }[] = [ADA_EMAIL],
  ) {
    const read = await loadClubUser(fakeReadAdmin(tables, { emails }).admin as never, PERSON);
    return { read, projected: projectAgentUser(read) };
  }

  it("reports every top-level section of the read, or names it as left out", async () => {
    const { read, projected } = await readAndProject();
    const leftOut: readonly string[] = GET_USER_LEFT_OUT.top;
    expect(Object.keys(projected).sort()).toEqual(
      Object.keys(read)
        .filter((k) => !leftOut.includes(k))
        .sort(),
    );
    // A left-out name that is no longer in the read is a stale list.
    for (const k of leftOut) expect(Object.keys(read)).toContain(k);
  });

  it("passes every reported section through unchanged", async () => {
    const { read, projected } = await readAndProject();
    for (const [key, value] of Object.entries(projected)) {
      if (key === "waivers") continue;
      expect(value, key).toEqual(read[key as keyof typeof read]);
    }
  });

  it("reports every waiver field the page reads except the signer's IP and browser context", async () => {
    const { read, projected } = await readAndProject();
    const leftOut: readonly string[] = GET_USER_LEFT_OUT.waiver;
    expect(projected.waivers).toHaveLength(read.waivers.length);
    const [readWaiver] = read.waivers;
    const [agentWaiver] = projected.waivers;
    expect(Object.keys(agentWaiver).sort()).toEqual(
      Object.keys(readWaiver)
        .filter((k) => !leftOut.includes(k))
        .sort(),
    );
    for (const k of leftOut) {
      expect(Object.keys(readWaiver)).toContain(k);
      expect(agentWaiver).not.toHaveProperty(k);
    }
  });

  it("keeps the caption on a dependant's address, so it is never reported bare", async () => {
    const { projected } = await readAndProject(
      baseTables({
        profiles: [
          profileRow({ first_name: "Bea", guardian_user_id: GUARDIAN, is_minor: true }),
          profileRow({ user_id: GUARDIAN, first_name: "Ada" }),
        ],
        waivers: [],
      }),
      [{ user_id: GUARDIAN, email: "ada@example.com", email_confirmed_at: null }],
    );
    expect(projected.user).toMatchObject({
      email: "ada@example.com",
      email_belongs_to: "Ada Lovelace",
    });
    expect(projected.household.guardian).toEqual({ user_id: GUARDIAN, name: "Ada Lovelace" });
  });
});
