import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("lists several Reply-To addresses in one header", async () => {
    await sendEmail({ ...base, replyTo: ["teen@example.com", "parent@example.com"] });

    expect(sendLovableEmail).toHaveBeenCalledTimes(1);
    expect(sendLovableEmail.mock.calls[0][0].reply_to).toBe("teen@example.com, parent@example.com");
  });

  it("resends with only the first Reply-To when the service refuses several", async () => {
    // Every caller swallows a send error, so a refusal here would lose the
    // email entirely. A second attempt carries its own idempotency key, or the
    // service would answer it with the first attempt's refusal.
    sendLovableEmail
      .mockRejectedValueOnce(Object.assign(new Error("bad reply_to"), { status: 422 }))
      .mockResolvedValueOnce({ success: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail({ ...base, replyTo: ["teen@example.com", "parent@example.com"] });

    expect(sendLovableEmail).toHaveBeenCalledTimes(2);
    const retry = sendLovableEmail.mock.calls[1][0];
    expect(retry.reply_to).toBe("teen@example.com");
    expect(retry.idempotency_key).toBe("k1-single-reply-to");
  });

  it("does not resend after a failure the service did not decide", async () => {
    // A timeout or a 5xx may have delivered the first attempt; a resend under a
    // new key could then deliver it twice. Rate limiting is not a refusal of
    // the Reply-To either.
    for (const failure of [new Error("network down"), { status: 503 }, { status: 429 }]) {
      sendLovableEmail.mockReset();
      sendLovableEmail.mockRejectedValue(failure);

      await expect(
        sendEmail({ ...base, replyTo: ["teen@example.com", "parent@example.com"] }),
      ).rejects.toBe(failure);
      expect(sendLovableEmail).toHaveBeenCalledTimes(1);
    }
  });

  it("does not resend a refused email that had only one Reply-To", async () => {
    const refusal = Object.assign(new Error("bad request"), { status: 400 });
    sendLovableEmail.mockRejectedValue(refusal);

    await expect(sendEmail({ ...base, replyTo: "visitor@example.com" })).rejects.toBe(refusal);
    expect(sendLovableEmail).toHaveBeenCalledTimes(1);
  });

  it("lets a failed send reach the caller, which decides whether to swallow it", async () => {
    sendLovableEmail.mockRejectedValue(new Error("provider down"));

    await expect(sendEmail(base)).rejects.toThrow("provider down");
  });
});
