import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubReplyTo, sendEmail } from "./send-email.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const { sendLovableEmail } = vi.hoisted(() => ({ sendLovableEmail: vi.fn() }));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));
const readClubReplyTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/club-settings.server", () => ({ readClubReplyTo }));

const base = {
  apiKey: "test-key",
  sendUrl: "https://send.example.com",
  to: "sam@example.com",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: "k1",
  replyTo: null,
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
        from: "UTS Jitsu <noreply@notify.utsjitsu.com.au>",
        sender_domain: "notify.utsjitsu.com.au",
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

  it("does not resend after a failure that is not about the request's content", async () => {
    // A timeout, a 5xx or a 409 may mean the first attempt went out or is still
    // going; a resend under a new key could then deliver it twice. A 401, 403
    // or 429 is the key or the rate, and a resend would only fail again.
    for (const failure of [
      new Error("network down"),
      { status: 503 },
      { status: 429 },
      { status: 409 },
      { status: 401 },
      { status: 403 },
    ]) {
      sendLovableEmail.mockReset();
      sendLovableEmail.mockRejectedValue(failure);

      await expect(
        sendEmail({ ...base, replyTo: ["teen@example.com", "parent@example.com"] }),
      ).rejects.toBe(failure);
      expect(sendLovableEmail).toHaveBeenCalledTimes(1);
    }
  });

  it("reports the first error when the one-address retry is rejected too", async () => {
    // Rejected again with a single Reply-To, so that was never the problem:
    // whoever reads the log should see the original rejection.
    const first = Object.assign(new Error("recipient suppressed"), { status: 422 });
    const again = Object.assign(new Error("recipient suppressed"), { status: 422 });
    sendLovableEmail.mockRejectedValueOnce(first).mockRejectedValueOnce(again);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendEmail({ ...base, replyTo: ["teen@example.com", "parent@example.com"] }),
    ).rejects.toBe(first);
    expect(sendLovableEmail).toHaveBeenCalledTimes(2);
  });

  it("reports the retry's own error when the retry fails for another reason", async () => {
    // The two-address Reply-To WAS the problem and the retry then timed out:
    // pointing the log back at the rejection would hide what actually failed.
    const timeout = new Error("timed out");
    sendLovableEmail
      .mockRejectedValueOnce(Object.assign(new Error("bad reply_to"), { status: 422 }))
      .mockRejectedValueOnce(timeout);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendEmail({ ...base, replyTo: ["teen@example.com", "parent@example.com"] }),
    ).rejects.toBe(timeout);
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

// The club's reply-to is what makes "reply to this email" true. So it comes
// back exactly when a manager has set one, never invented, and a failed read
// costs the email its reply-to, never the email itself.
describe("clubReplyTo", () => {
  const admin = {} as SupabaseClient<Database>;

  beforeEach(() => {
    readClubReplyTo.mockReset();
    sendLovableEmail.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the club's address when one is set", async () => {
    readClubReplyTo.mockResolvedValue({ ok: true, address: "hello@example.com" });
    await expect(clubReplyTo(admin)).resolves.toBe("hello@example.com");
  });

  it("resolves null when nobody has set one", async () => {
    readClubReplyTo.mockResolvedValue({ ok: true, address: null });
    await expect(clubReplyTo(admin)).resolves.toBeNull();
  });

  it("resolves null, and says so, when the setting cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    readClubReplyTo.mockResolvedValue({ ok: false, address: null });
    await expect(clubReplyTo(admin)).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("still lets the email go out when reading the setting throws outright", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readClubReplyTo.mockRejectedValue(new Error("connection reset"));
    await sendEmail({ ...base, replyTo: await clubReplyTo(admin) });
    expect(sendLovableEmail).toHaveBeenCalledTimes(1);
    expect(sendLovableEmail.mock.calls[0][0].reply_to).toBeUndefined();
  });

  it("puts the club's address on the email when one is set", async () => {
    readClubReplyTo.mockResolvedValue({ ok: true, address: "hello@example.com" });
    await sendEmail({ ...base, replyTo: await clubReplyTo(admin) });
    expect(sendLovableEmail.mock.calls[0][0].reply_to).toBe("hello@example.com");
  });
});
