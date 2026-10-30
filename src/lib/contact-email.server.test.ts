import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MANAGER_CONTACT_URL, sendContactEmails } from "./contact-email.server";

const { sendLovableEmail, getManagerEmails } = vi.hoisted(() => ({
  sendLovableEmail: vi.fn(),
  getManagerEmails: vi.fn(),
}));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));
vi.mock("@/lib/manager-recipients.server", () => ({ getManagerEmails }));
const { claimVisitorEmail, claimManagerNotice } = vi.hoisted(() => ({
  claimVisitorEmail: vi.fn(),
  claimManagerNotice: vi.fn(),
}));
// The caps (#52). Open by default, so every other test here sees the sends
// they always did; the cap tests below close one or the other.
vi.mock("@/lib/rate-limit.server", () => ({ claimVisitorEmail, claimManagerNotice }));

describe("sendContactEmails", () => {
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
    // The negative path that matters most: submitContact commits the row first
    // and only then calls this, so a missing key has to degrade to "stored but
    // not emailed" rather than throwing into the visitor's submission.
    delete process.env.LOVABLE_API_KEY;
    const from = vi.fn();
    const admin = { from } as unknown as SupabaseClient<Database>;

    const result = await sendContactEmails({
      messageId: "m1",
      name: "Sam",
      email: "sam@example.com",
      subject: "Beginner classes",
      message: "When do beginner classes run?",
      admin,
    });

    expect(result).toEqual({ sent: [], skipped: true });
    expect(from).not.toHaveBeenCalled();
    // getManagerEmails is mocked, so `from` alone can no longer catch a lookup
    // moved above the key check.
    expect(getManagerEmails).not.toHaveBeenCalled();
    expect(sendLovableEmail).not.toHaveBeenCalled();
  });

  it("sets Reply-To to the sender on the managers' copy, and only there", async () => {
    // Pressing reply in a manager's inbox has to answer the visitor, not the
    // noreply sender. The acknowledgement goes TO the visitor, so a Reply-To
    // there would only point them back at themselves.
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockResolvedValue({ success: true });
    getManagerEmails.mockResolvedValue(["manager-a@example.com", "manager-b@example.com"]);

    const result = await sendContactEmails({
      messageId: "m2",
      name: "Sam",
      email: "sam@example.com",
      subject: "Beginner classes",
      message: "When do beginner classes run?",
      admin: {} as SupabaseClient<Database>,
    });

    expect(result.sent).toEqual([
      "sam@example.com",
      "manager-a@example.com",
      "manager-b@example.com",
    ]);
    const payloads = sendLovableEmail.mock.calls.map(([payload]) => payload);
    const ack = payloads.find((p) => p.to === "sam@example.com");
    const toManagers = payloads.filter((p) => p.to !== "sam@example.com");
    expect(ack.reply_to).toBeUndefined();
    expect(toManagers).toHaveLength(2);
    for (const p of toManagers) expect(p.reply_to).toBe("sam@example.com");
  });

  it("holds back the acknowledgement once that address is capped, and still tells managers", async () => {
    // The acknowledgement is the one email the site sends to an address nobody
    // has verified, so it is the one a bot would aim at a stranger (#52).
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockResolvedValue({ success: true });
    getManagerEmails.mockResolvedValue(["manager-a@example.com"]);
    claimVisitorEmail.mockResolvedValue(false);
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    } as unknown as SupabaseClient<Database>;

    await sendContactEmails({
      messageId: "m3",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: null,
      message: "Do I need a gi?",
      admin,
    });

    expect(claimVisitorEmail).toHaveBeenCalledWith(admin, "ada@example.com", "contact-sender-m3");
    expect(sendLovableEmail.mock.calls.map(([p]) => p.to)).toEqual(["manager-a@example.com"]);
  });

  it("sends the managers nothing once the day's new-message emails are paused", async () => {
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockResolvedValue({ success: true });
    getManagerEmails.mockResolvedValue(["manager-a@example.com"]);
    claimManagerNotice.mockResolvedValue("paused");

    await sendContactEmails({
      messageId: "m4",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: null,
      message: "Do I need a gi?",
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        }),
      } as unknown as SupabaseClient<Database>,
    });

    expect(claimManagerNotice).toHaveBeenCalledWith(expect.anything(), "message", "m4");
    expect(sendLovableEmail.mock.calls.map(([p]) => p.to)).toEqual(["ada@example.com"]);
  });
  it("points managers at the inbox screen that can actually show the message", () => {
    expect(MANAGER_CONTACT_URL).toBe("https://utsjitsu.com.au/manager/contact-messages");
  });
});
