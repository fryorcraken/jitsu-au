import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getManagerEmails } from "./manager-recipients.server";

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
      users: { a: "sensei@example.com", b: "assistant@example.com" },
    });
    await expect(getManagerEmails(admin)).resolves.toEqual([
      "sensei@example.com",
      "assistant@example.com",
    ]);
  });

  it("de-duplicates repeated emails", async () => {
    const admin = fakeAdmin({
      roles: [{ user_id: "a" }, { user_id: "b" }],
      users: { a: "sensei@example.com", b: "sensei@example.com" },
    });
    await expect(getManagerEmails(admin)).resolves.toEqual(["sensei@example.com"]);
  });

  it("skips role holders with no resolvable email", async () => {
    const admin = fakeAdmin({
      roles: [{ user_id: "a" }, { user_id: "ghost" }],
      users: { a: "sensei@example.com" },
    });
    await expect(getManagerEmails(admin)).resolves.toEqual(["sensei@example.com"]);
  });

  it("returns [] when the role lookup errors", async () => {
    await expect(getManagerEmails(fakeAdmin({ rolesError: true }))).resolves.toEqual([]);
  });

  it("returns [] when there are no managers", async () => {
    await expect(getManagerEmails(fakeAdmin({ roles: [] }))).resolves.toEqual([]);
  });
});
