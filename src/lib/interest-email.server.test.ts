import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildWaiverUrl, sendInterestEmails } from "./interest-email.server";

const { sendLovableEmail, getManagerEmails } = vi.hoisted(() => ({
  sendLovableEmail: vi.fn(),
  getManagerEmails: vi.fn(),
}));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));
vi.mock("@/lib/manager-recipients.server", () => ({ getManagerEmails }));
const { claimVisitorEmail, claimManagerNotice, releaseVisitorEmail } = vi.hoisted(() => ({
  claimVisitorEmail: vi.fn(),
  claimManagerNotice: vi.fn(),
  releaseVisitorEmail: vi.fn(),
}));
// The caps (#52). Open by default, so every other test here sees the sends
// they always did; the cap tests below close one or the other.
vi.mock("@/lib/rate-limit.server", () => ({
  claimVisitorEmail,
  claimManagerNotice,
  releaseVisitorEmail,
}));
vi.mock("@/lib/email-verification.server", () => ({
  mintVerificationToken: () => Promise.resolve("utsj_test"),
}));

describe("buildWaiverUrl", () => {
  it("carries name, email and phone as prefill search params", () => {
    expect(
      buildWaiverUrl({ name: "Ada Lovelace", email: "ada@example.com", phone: "0400000000" }),
    ).toBe(
      "https://utsjitsu.com.au/waiver?name=Ada+Lovelace&email=ada%40example.com&phone=0400000000",
    );
  });

  it("omits an absent phone", () => {
    expect(buildWaiverUrl({ name: "Ada", email: "ada@example.com", phone: null })).toBe(
      "https://utsjitsu.com.au/waiver?name=Ada&email=ada%40example.com",
    );
  });

  it("falls back to the bare waiver path when nothing is provided", () => {
    expect(buildWaiverUrl({ name: "", email: "" })).toBe("https://utsjitsu.com.au/waiver");
  });

  it("carries the verification token when one was minted", () => {
    // This is what makes the EMAILED link different from the in-app one: the
    // name/email params prove nothing, an unguessable token does.
    expect(buildWaiverUrl({ name: "Ada", email: "ada@example.com", token: "utsj_abc123" })).toBe(
      "https://utsjitsu.com.au/waiver?name=Ada&email=ada%40example.com&vt=utsj_abc123",
    );
  });

  it("omits the token when minting failed, leaving a working prefill link", () => {
    expect(buildWaiverUrl({ name: "Ada", email: "ada@example.com", token: null })).toBe(
      "https://utsjitsu.com.au/waiver?name=Ada&email=ada%40example.com",
    );
  });
});

describe("sendInterestEmails", () => {
  const original = process.env.LOVABLE_API_KEY;

  beforeEach(() => {
    // restoreAllMocks only undoes spies; the hoisted module mocks keep their
    // calls and resolved values unless cleared here.
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    claimVisitorEmail.mockResolvedValue(true);
    claimManagerNotice.mockResolvedValue("send");
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = original;
    vi.restoreAllMocks();
  });

  it("skips sending (and never touches the admin client) when no API key is configured", async () => {
    delete process.env.LOVABLE_API_KEY;
    const from = vi.fn();
    const admin = { from } as unknown as SupabaseClient<Database>;

    const result = await sendInterestEmails({
      registrationId: "r1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "0400000000",
      message: null,
      admin,
    });

    expect(result).toEqual({ sent: [], skipped: true, applicantEmailed: false });
    expect(from).not.toHaveBeenCalled();
    // getManagerEmails is mocked, so `from` alone can no longer catch a lookup
    // moved above the key check.
    expect(getManagerEmails).not.toHaveBeenCalled();
    expect(sendLovableEmail).not.toHaveBeenCalled();
  });

  it("sets Reply-To to the lead on the managers' copy, and only there", async () => {
    // Pressing reply on a new-lead email has to reach the lead, not the
    // noreply sender. Their own confirmation goes TO them, so it carries none.
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockResolvedValue({ success: true });
    getManagerEmails.mockResolvedValue(["manager-a@example.com", "manager-b@example.com"]);

    await sendInterestEmails({
      registrationId: "r2",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "0400000000",
      message: null,
      admin: {} as SupabaseClient<Database>,
    });

    const payloads = sendLovableEmail.mock.calls.map(([p]) => p);
    const toLead = payloads.find((p) => p.to === "ada@example.com");
    const toManagers = payloads.filter((p) => p.to !== "ada@example.com");
    expect(toLead.reply_to).toBeUndefined();
    expect(toManagers).toHaveLength(2);
    for (const p of toManagers) expect(p.reply_to).toBe("ada@example.com");
  });

  it("holds back the applicant's confirmation once that address is capped, and says so", async () => {
    // Before #52 a bot could make the club email any address as often as it
    // liked. The lead is still filed and the managers still hear about it.
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockResolvedValue({ success: true });
    getManagerEmails.mockResolvedValue(["manager-a@example.com"]);
    claimVisitorEmail.mockResolvedValue(false);
    const admin = {} as SupabaseClient<Database>;

    const result = await sendInterestEmails({
      registrationId: "r3",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      message: null,
      admin,
    });

    expect(claimVisitorEmail).toHaveBeenCalledWith(
      admin,
      "ada@example.com",
      "interest-applicant-r3",
    );
    expect(sendLovableEmail.mock.calls.map(([p]) => p.to)).toEqual(["manager-a@example.com"]);
    expect(result.applicantEmailed).toBe(false);
  });

  it("sends the managers nothing once the day's new-lead emails are paused", async () => {
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockResolvedValue({ success: true });
    getManagerEmails.mockResolvedValue(["manager-a@example.com", "manager-b@example.com"]);
    claimManagerNotice.mockResolvedValue("paused");

    const result = await sendInterestEmails({
      registrationId: "r4",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      message: null,
      admin: {} as SupabaseClient<Database>,
    });

    expect(claimManagerNotice).toHaveBeenCalledWith(expect.anything(), "lead", "r4");
    expect(sendLovableEmail.mock.calls.map(([p]) => p.to)).toEqual(["ada@example.com"]);
    expect(result.applicantEmailed).toBe(true);
  });
  it("gives the applicant's slots back when their confirmation fails to send", async () => {
    // An email that never went must not count against that address's day.
    process.env.LOVABLE_API_KEY = "test-key";
    getManagerEmails.mockResolvedValue([]);
    sendLovableEmail.mockRejectedValue(new Error("provider down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendInterestEmails({
      registrationId: "r5",
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      message: null,
      admin: {} as SupabaseClient<Database>,
    });

    expect(releaseVisitorEmail).toHaveBeenCalledWith(expect.anything(), "interest-applicant-r5");
    expect(result.applicantEmailed).toBe(false);
  });
});
