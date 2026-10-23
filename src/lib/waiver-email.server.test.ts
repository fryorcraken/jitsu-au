import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getManagerEmails, sendWaiverEmails } from "./waiver-email.server";

const { sendLovableEmail } = vi.hoisted(() => ({ sendLovableEmail: vi.fn() }));
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

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

describe("sendWaiverEmails", () => {
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
    delete process.env.LOVABLE_API_KEY;
    const from = vi.fn();
    const admin = { from } as unknown as SupabaseClient<Database>;

    const result = await sendWaiverEmails({
      waiverId: "w1",
      memberName: "Ada Lovelace",
      memberGreetingName: "Addy",
      memberEmail: "ada@example.com",
      pdfUrl: "https://example.com/waiver.pdf",
      admin,
    });

    expect(result).toEqual({ sent: [], skipped: true });
    expect(from).not.toHaveBeenCalled();
  });

  it("sets Reply-To to the signer on the managers' review prompt, and only there", async () => {
    // A manager with a question about a waiver presses reply; that has to reach
    // whoever signed it, not the noreply sender.
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockReset().mockResolvedValue({ success: true });
    const admin = fakeAdmin({
      roles: [{ user_id: "a" }, { user_id: "b" }],
      users: { a: "manager-a@example.com", b: "manager-b@example.com" },
    });

    await sendWaiverEmails({
      waiverId: "w2",
      memberName: "Ada Lovelace",
      memberGreetingName: "Addy",
      memberEmail: "ada@example.com",
      pdfUrl: "https://example.com/waiver.pdf",
      admin,
    });

    const payloads = sendLovableEmail.mock.calls.map(([p]) => p);
    const toMember = payloads.find((p) => p.to === "ada@example.com");
    const toManagers = payloads.filter((p) => p.to !== "ada@example.com");
    expect(toMember.reply_to).toBeUndefined();
    expect(toManagers.map((p) => p.to)).toEqual(["manager-a@example.com", "manager-b@example.com"]);
    for (const p of toManagers) expect(p.reply_to).toBe("ada@example.com");
  });

  it("replies to the guardian as well on a minor's own waiver", async () => {
    // A manager's question about a fifteen-year-old's waiver should reach the
    // adult who co-signed it, not only the fifteen-year-old.
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockReset().mockResolvedValue({ success: true });

    await sendWaiverEmails({
      waiverId: "w3",
      memberName: "Sam Lovelace",
      memberGreetingName: "Sam",
      memberEmail: "sam@example.com",
      guardianEmail: "ada@example.com",
      pdfUrl: "https://example.com/waiver.pdf",
      admin: fakeAdmin({ roles: [{ user_id: "a" }], users: { a: "manager-a@example.com" } }),
    });

    const toManager = sendLovableEmail.mock.calls
      .map(([p]) => p)
      .find((p) => p.to === "manager-a@example.com");
    expect(toManager.reply_to).toBe("sam@example.com, ada@example.com");
  });

  it("lists one address once when the guardian's is the member's own", async () => {
    // A waiver signed for a child on someone's account, or a guardian block
    // left blank, resolves both to the same mailbox; it is listed once, case
    // and spacing aside.
    process.env.LOVABLE_API_KEY = "test-key";
    sendLovableEmail.mockReset().mockResolvedValue({ success: true });

    await sendWaiverEmails({
      waiverId: "w4",
      memberName: "Bea Lovelace",
      memberGreetingName: "Ada",
      memberEmail: "ada@example.com",
      guardianEmail: " Ada@Example.com",
      pdfUrl: "https://example.com/waiver.pdf",
      admin: fakeAdmin({ roles: [{ user_id: "a" }], users: { a: "manager-a@example.com" } }),
    });

    const toManager = sendLovableEmail.mock.calls
      .map(([p]) => p)
      .find((p) => p.to === "manager-a@example.com");
    expect(toManager.reply_to).toBe("ada@example.com");
  });
});
