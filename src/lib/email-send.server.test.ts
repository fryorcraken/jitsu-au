import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const sendLovableEmail = vi.hoisted(() => vi.fn());
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

const { FROM, SENDER_DOMAIN, emailConfigured, getManagerEmails, sendClubEmail } =
  await import("./email-send.server");

// Build a minimal fake service-role client good enough for the code paths under
// test: `.from("user_roles").select().eq()` and `.auth.admin.getUserById()`.
function fakeAdmin(opts: {
  roles?: { user_id: string }[];
  rolesError?: boolean;
  users?: Record<string, string | null>;
}): SupabaseClient<Database> {
  const emailFor = opts.users ?? {};
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            opts.rolesError
              ? { data: null, error: new Error("boom") }
              : { data: opts.roles ?? [], error: null },
          ),
      }),
    }),
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve(
            id in emailFor
              ? { data: { user: { email: emailFor[id] } }, error: null }
              : { data: { user: null }, error: new Error("not found") },
          ),
      },
    },
  } as unknown as SupabaseClient<Database>;
}

describe("getManagerEmails", () => {
  it("resolves the email of each manager role holder", async () => {
    const admin = fakeAdmin({
      roles: [{ user_id: "a" }, { user_id: "b" }],
      users: { a: "sensei@club.test", b: "assistant@club.test" },
    });
    await expect(getManagerEmails(admin)).resolves.toEqual([
      "sensei@club.test",
      "assistant@club.test",
    ]);
  });

  it("de-duplicates repeated emails", async () => {
    const admin = fakeAdmin({
      roles: [{ user_id: "a" }, { user_id: "b" }],
      users: { a: "sensei@club.test", b: "sensei@club.test" },
    });
    await expect(getManagerEmails(admin)).resolves.toEqual(["sensei@club.test"]);
  });

  it("skips role holders with no resolvable email", async () => {
    const admin = fakeAdmin({
      roles: [{ user_id: "a" }, { user_id: "ghost" }],
      users: { a: "sensei@club.test" },
    });
    await expect(getManagerEmails(admin)).resolves.toEqual(["sensei@club.test"]);
  });

  it("returns [] when the role lookup errors", async () => {
    await expect(getManagerEmails(fakeAdmin({ rolesError: true }))).resolves.toEqual([]);
  });

  it("returns [] when there are no managers", async () => {
    await expect(getManagerEmails(fakeAdmin({ roles: [] }))).resolves.toEqual([]);
  });
});

describe("sendClubEmail", () => {
  const original = { key: process.env.LOVABLE_API_KEY, url: process.env.LOVABLE_SEND_URL };

  beforeEach(() => {
    sendLovableEmail.mockReset().mockResolvedValue({ success: true });
    process.env.LOVABLE_API_KEY = "test-key";
    process.env.LOVABLE_SEND_URL = "https://send.example.com";
  });
  afterEach(() => {
    if (original.key === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = original.key;
    if (original.url === undefined) delete process.env.LOVABLE_SEND_URL;
    else process.env.LOVABLE_SEND_URL = original.url;
  });

  it("sends from the club's aligned sender, as transactional mail", async () => {
    await sendClubEmail({
      to: "ada@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      idempotencyKey: "k-1",
    });

    expect(sendLovableEmail).toHaveBeenCalledWith(
      {
        to: "ada@example.com",
        from: "UTS Jitsu <noreply@notify.jitsu.au>",
        sender_domain: "notify.jitsu.au",
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
        purpose: "transactional",
        idempotency_key: "k-1",
      },
      { apiKey: "test-key", sendUrl: "https://send.example.com" },
    );
  });

  it("keeps the From address on the sending domain, so DKIM and SPF align", () => {
    expect(FROM.endsWith(`@${SENDER_DOMAIN}>`)).toBe(true);
  });

  it("throws rather than sending when there is no API key", async () => {
    delete process.env.LOVABLE_API_KEY;
    expect(emailConfigured()).toBe(false);
    await expect(
      sendClubEmail({
        to: "a@example.com",
        subject: "s",
        html: "h",
        text: "t",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/LOVABLE_API_KEY/);
    expect(sendLovableEmail).not.toHaveBeenCalled();
  });

  it("passes a provider failure up to the caller, which decides what to log", async () => {
    sendLovableEmail.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      sendClubEmail({
        to: "a@example.com",
        subject: "s",
        html: "h",
        text: "t",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("provider down");
  });
});
