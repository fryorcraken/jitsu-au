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
      validator: (d: unknown) => d,
      middleware: () => builder,
      inputValidator: (v: (d: unknown) => unknown) => {
        builder.validator = v;
        return builder;
      },
      handler: (h: (ctx: { data: unknown; context: unknown }) => unknown) => ({
        run: async (data: unknown) => h({ data: builder.validator(data), context: {} }),
      }),
    };
    return builder;
  };
  // Anything else a module builds at import time (the auth middleware) only
  // needs to construct without throwing.
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return { createServerFn, createMiddleware: chain, useServerFn: chain };
});

const { limitPublicForm, adminFrom, createClient, sendInterestEmails } = vi.hoisted(() => ({
  limitPublicForm: vi.fn(),
  adminFrom: vi.fn(),
  createClient: vi.fn(),
  sendInterestEmails: vi.fn(),
}));
vi.mock("@/lib/rate-limit.server", () => ({ limitPublicForm }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: adminFrom, rpc: adminFrom, storage: { from: adminFrom } },
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

const cases = [
  { form: "interest", data: interest, submissionId: SUBMISSION },
  { form: "contact", data: contact, submissionId: SUBMISSION },
  { form: "waiver", data: waiver, submissionId: SUBMISSION },
  // The code-of-conduct form carries no submission id, so every press counts.
  { form: "code_of_conduct", data: codeOfConduct, submissionId: null },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
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
});
