import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getManagerEmails, sendWaiverEmails } from "./waiver-email.server";

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
});
