import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "./send-email.server";

const { sendLovableEmail } = vi.hoisted(() => ({ sendLovableEmail: vi.fn() }));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

const base = {
  apiKey: "test-key",
  sendUrl: "https://send.example.com",
  to: "sam@example.com",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: "k1",
};

describe("sendEmail", () => {
  beforeEach(() => {
    sendLovableEmail.mockReset();
    sendLovableEmail.mockResolvedValue({ success: true });
  });

  it("sends from the noreply address on the domain DMARC aligns with", async () => {
    // From and sender_domain have to agree or Gmail files the email as spam,
    // and every email the app sends now takes them from this one place.
    await sendEmail(base);

    expect(sendLovableEmail).toHaveBeenCalledWith(
      {
        to: "sam@example.com",
        from: "UTS Jitsu <noreply@notify.jitsu.au>",
        sender_domain: "notify.jitsu.au",
        subject: "Hello",
        html: "<p>Hello</p>",
        text: "Hello",
        purpose: "transactional",
        idempotency_key: "k1",
        reply_to: undefined,
      },
      { apiKey: "test-key", sendUrl: "https://send.example.com" },
    );
  });

  it("passes a Reply-To through when the caller gives one", async () => {
    await sendEmail({ ...base, replyTo: "visitor@example.com" });

    expect(sendLovableEmail.mock.calls[0][0].reply_to).toBe("visitor@example.com");
  });

  it("lets a failed send reach the caller, which decides whether to swallow it", async () => {
    sendLovableEmail.mockRejectedValue(new Error("provider down"));

    await expect(sendEmail(base)).rejects.toThrow("provider down");
  });
});
