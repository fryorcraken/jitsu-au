// Each public write path refuses a submission over its limit (#52), before it
// writes or sends anything.
//
// The four handlers are `createServerFn`s, which die on "No Start context
// found in AsyncLocalStorage" when called from the test runner. Rather than
// pull every handler body out into a plain function, this file stands
// `createServerFn` in with a builder that keeps the validator and handler it
// was given, so the REAL handler runs on validated input. The limit itself is
// mocked: what it counts is `rate-limit.server.test.ts` and the SQL check in
// supabase/lint/rate-limit-claims.sql. What is pinned here is that each path
// asks it, with the right form and submission id, and stops when told no.
//
// Before #52 none of these asked, so every "refuses" case below would have
// gone straight on to the insert.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Runnable = { run: (data: unknown) => Promise<unknown> };

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    const builder = {
      parse: (d: unknown) => d,
      middleware: () => builder,
      validator: (v: (d: unknown) => unknown) => {
        builder.parse = v;
        return builder;
      },
      handler: (h: (ctx: { data: unknown; context: unknown }) => unknown) => ({
        run: async (data: unknown) => h({ data: builder.parse(data), context: {} }),
      }),
    };
    return builder;
  };
  // Anything else a module builds at import time (the auth middleware) only
  // needs to construct without throwing.
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return { createServerFn, createMiddleware: chain, useServerFn: chain };
});

const {
  limitPublicForm,
  adminFrom,
  createClient,
  sendInterestEmails,
  getUser,
  getUserById,
  lookupVerificationToken,
  requestHeaders,
} = vi.hoisted(() => ({
  limitPublicForm: vi.fn(),
  adminFrom: vi.fn(),
  createClient: vi.fn(),
  sendInterestEmails: vi.fn(),
  getUser: vi.fn(),
  getUserById: vi.fn(),
  lookupVerificationToken: vi.fn(),
  requestHeaders: {} as Record<string, string>,
}));
vi.mock("@/lib/rate-limit.server", () => ({ limitPublicForm }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: adminFrom,
    rpc: adminFrom,
    storage: { from: adminFrom },
    auth: { getUser, admin: { getUserById } },
  },
}));
vi.mock("@/lib/email-verification.server", () => ({ lookupVerificationToken }));
vi.mock("@/lib/request-headers", () => ({
  requestHeaderGetter: async () => (name: string) => requestHeaders[name],
}));
vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("@/lib/interest-email.server", () => ({ sendInterestEmails }));

const REFUSAL =
  "A lot of sign-ups have come from this network recently, so we've paused new ones from it for about 25 minutes. Your details are still here. Switch to mobile data and try again, or try again later.";

const SUBMISSION = "11111111-2222-4333-8444-555555555555";

const interest = {
  client_submission_id: SUBMISSION,
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "0400000000",
  message: "",
  hp: "",
};

const contact = {
  client_submission_id: SUBMISSION,
  name: "Ada Lovelace",
  email: "ada@example.com",
  subject: "",
  message: "Do I need a gi for my first class?",
  hp: "",
};

const waiver = {
  client_submission_id: SUBMISSION,
  first_name: "Ada",
  last_name: "Lovelace",
  date_of_birth: "1990-12-10",
  address: "1 Broadway, Ultimo NSW",
  phone: "0400000000",
  email: "ada@example.com",
  emergency_contact_name: "Charles Babbage",
  emergency_contact_relationship: "Colleague",
  emergency_contact_phone: "0400000001",
  health_answers: {
    drugs: false,
    blackouts: false,
    device: false,
    impairments: false,
    other: false,
  },
  signature_name: "Ada Lovelace",
  hp: "",
};

const codeOfConduct = { signature_name: "Ada Lovelace", version: 1, token: "utsj_x", hp: "" };

async function handler(name: "interest" | "contact" | "waiver" | "code_of_conduct") {
  if (name === "interest") return (await import("./submissions.functions")).submitInterest;
  if (name === "contact") return (await import("./submissions.functions")).submitContact;
  if (name === "waiver") return (await import("./waiver.functions")).submitWaiverWithPdf;
  return (await import("./code-of-conduct.functions")).acceptCodeOfConduct;
}

// The code of conduct is not here: it is limited only once it knows who is
// signing, so it has its own block below.
const cases = [
  { form: "interest", data: interest, submissionId: SUBMISSION },
  { form: "contact", data: contact, submissionId: SUBMISSION },
  { form: "waiver", data: waiver, submissionId: SUBMISSION },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(requestHeaders)) delete requestHeaders[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(cases)("$form submission over its limit", ({ form, data, submissionId }) => {
  it("is refused with the limit's own message, before anything is written or sent", async () => {
    limitPublicForm.mockRejectedValue(new Error(REFUSAL));
    const fn = (await handler(form)) as unknown as Runnable;

    await expect(fn.run(data)).rejects.toThrow(REFUSAL);

    expect(limitPublicForm).toHaveBeenCalledWith(form, submissionId);
    // Neither database client was touched: no row, no auth user, no PDF.
    expect(adminFrom).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(sendInterestEmails).not.toHaveBeenCalled();
  });
});

describe("an interest registration under its limit", () => {
  it("goes on to be filed, and reports whether the confirmation was emailed", async () => {
    limitPublicForm.mockResolvedValue(undefined);
    const insert = vi.fn().mockResolvedValue({ error: null });
    createClient.mockReturnValue({ from: () => ({ insert }) });
    sendInterestEmails.mockResolvedValue({ sent: [], skipped: false, applicantEmailed: false });
    const fn = (await handler("interest")) as unknown as Runnable;

    // Held back by the email caps: the page must not say "we'll email you".
    await expect(fn.run(interest)).resolves.toEqual({
      ok: true,
      duplicate: false,
      emailed: false,
    });
    expect(insert).toHaveBeenCalledOnce();
  });
  it("does not promise an email on a retry of a registration already filed", async () => {
    // The first attempt's confirmation may have been held back by a cap, and
    // this call cannot tell, so it must not say "we'll email you" (#52).
    limitPublicForm.mockResolvedValue(undefined);
    const insert = vi.fn().mockResolvedValue({ error: { code: "23505", message: "dup" } });
    createClient.mockReturnValue({ from: () => ({ insert }) });
    const fn = (await handler("interest")) as unknown as Runnable;

    await expect(fn.run(interest)).resolves.toEqual({ ok: true, duplicate: true, emailed: false });
    expect(sendInterestEmails).not.toHaveBeenCalled();
  });
});

const MEMBER = "aaaaaaaa-0000-4000-8000-000000000001";

/**
 * Just enough of the club for an agreement to get as far as being filed:
 * version 1 live, a profile for the member, and a recorded insert.
 */
function clubWithCodeOfConduct() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const rows: Record<string, unknown[]> = {
    code_of_conduct_versions: [
      { version: 1, asks_reagreement: true, required_version: 1, is_current: true },
    ],
    profiles: [{ first_name: "Ada", last_name: "Lovelace", middle_name: "", preferred_name: "" }],
    email_verification_tokens: [],
  };
  adminFrom.mockImplementation((table: string) => {
    const result = { data: rows[table] ?? [], error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      update: () => q,
      insert,
      maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, ko),
    };
    return q;
  });
  getUserById.mockResolvedValue({ data: { user: { email: "ada@example.com" } } });
  lookupVerificationToken.mockResolvedValue({
    id: "t1",
    user_id: MEMBER,
    email: "ada@example.com",
  });
  return { insert };
}

describe("a code-of-conduct agreement", () => {
  it("from an emailed link is refused over its network's limit, before it is filed", async () => {
    const { insert } = clubWithCodeOfConduct();
    limitPublicForm.mockRejectedValue(new Error(REFUSAL));
    const fn = (await handler("code_of_conduct")) as unknown as Runnable;

    await expect(fn.run(codeOfConduct)).rejects.toThrow(REFUSAL);

    // No submission id: the page does not retry by itself, so a press is a press.
    expect(limitPublicForm).toHaveBeenCalledWith("code_of_conduct", null);
    expect(insert).not.toHaveBeenCalled();
  });

  it("that was going to be refused anyway spends nothing of the network's allowance", async () => {
    // A tab left open across a manager's republish, or a bot sending junk:
    // turned away by the version check, and never counted.
    clubWithCodeOfConduct();
    const fn = (await handler("code_of_conduct")) as unknown as Runnable;

    await expect(fn.run({ ...codeOfConduct, version: 2 })).rejects.toThrow(/updated/);
    expect(limitPublicForm).not.toHaveBeenCalled();
  });

  it("from a signed-in member is not limited at all", async () => {
    const { insert } = clubWithCodeOfConduct();
    requestHeaders.authorization = "Bearer session-token";
    getUser.mockResolvedValue({ data: { user: { id: MEMBER, email: "ada@example.com" } } });
    const fn = (await handler("code_of_conduct")) as unknown as Runnable;

    await expect(fn.run({ ...codeOfConduct, token: "" })).resolves.toMatchObject({ ok: true });
    expect(limitPublicForm).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
  });
});
