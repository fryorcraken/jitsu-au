import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MANAGER_CONTACT_URL, sendContactEmails } from "./contact-email.server";

const { sendLovableEmail, getManagerEmails } = vi.hoisted(() => ({
  sendLovableEmail: vi.fn(),
  getManagerEmails: vi.fn(),
}));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));
vi.mock("@/lib/waiver-email.server", () => ({ getManagerEmails }));

describe("sendContactEmails", () => {
  const original = process.env.LOVABLE_API_KEY;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("points managers at the inbox screen that can actually show the message", () => {
    expect(MANAGER_CONTACT_URL).toBe("https://jitsu.au/manager/contact-messages");
  });
});
