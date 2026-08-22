// The signed-out email settings, behind the link at the foot of every
// notification email.
//
// `emailSettingsFor` takes its client as a parameter, which is why it is
// reachable from the runner at all; the two `createServerFn` wrappers around it
// die on "No Start context found in AsyncLocalStorage" (see
// leads.functions.test.ts). Pulling the body out was exactly so the refusal
// path below could be tested.
//
// What is worth pinning is that nothing happens without a token the club
// actually issued. The token now travels in a cookie rather than the POST body
// (src/lib/email-settings-session.ts), and the two ways that can go wrong are
// both silent: a request with no cookie at all reaching the database, and a
// rotated token writing a preferences row for whoever came back instead.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { emailSettingsFor } from "./notifications.functions";
import { notificationPreferencesSchema } from "./validation";

const USER_ID = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, boolean | null>;

/**
 * A PostgREST chain that answers the token lookup and the preferences
 * read/write, and records every table it was asked for.
 *
 * The tables are recorded rather than ignored because "did this touch the
 * database at all" is the assertion: a fake that quietly answered every query
 * would keep the no-cookie test green while the real code queried away.
 */
function fakeAdmin(opts: { tokenRow: { user_id: string } | null; prefs: Row | null }) {
  const tables: string[] = [];
  const admin = {
    from(table: string) {
      tables.push(table);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: table === "notification_tokens" ? opts.tokenRow : opts.prefs,
            error: null,
          }),
        single: () => Promise.resolve({ data: opts.prefs, error: null }),
        upsert: () => chain,
      };
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient<Database>, tables };
}

describe("emailSettingsFor", () => {
  it("hands back the person's switches for a token the club issued", async () => {
    const { admin } = fakeAdmin({
      tokenRow: { user_id: USER_ID },
      prefs: { reply_to_me: false, thread_activity: null, new_blog_post: null },
    });
    const result = await emailSettingsFor(admin, "utsj_abc123");
    expect(result.ok).toBe(true);
    // Resolved against the club defaults, so an untouched switch has a value.
    if (result.ok) expect(result.preferences.reply_to_me).toBe(false);
  });

  it("touches nothing at all when the request carries no cookie", async () => {
    // The page is open to anyone. Somebody who lands on /email-settings without
    // a settings link should cost one request and no database work.
    const { admin, tables } = fakeAdmin({ tokenRow: null, prefs: null });
    expect(await emailSettingsFor(admin, null)).toEqual({ ok: false });
    expect(tables).toEqual([]);
  });

  it("refuses a rotated or unknown token, and writes nothing for it", async () => {
    // Uniform with the line above on purpose: telling the two apart would make
    // this a way to probe which links the club has issued.
    const { admin, tables } = fakeAdmin({ tokenRow: null, prefs: null });
    expect(await emailSettingsFor(admin, "utsj_never_issued", { new_blog_post: true })).toEqual({
      ok: false,
    });
    expect(tables).toEqual(["notification_tokens"]);
    expect(tables).not.toContain("notification_preferences");
  });

  it("writes when it is given a patch, and only reads when it is not", async () => {
    const written = fakeAdmin({ tokenRow: { user_id: USER_ID }, prefs: { new_blog_post: true } });
    await emailSettingsFor(written.admin, "utsj_abc123", { new_blog_post: true });
    expect(written.tables).toEqual(["notification_tokens", "notification_preferences"]);

    const read = fakeAdmin({ tokenRow: { user_id: USER_ID }, prefs: { new_blog_post: true } });
    await emailSettingsFor(read.admin, "utsj_abc123");
    expect(read.tables).toEqual(["notification_tokens", "notification_preferences"]);
  });
});

describe("what the signed-out page is allowed to send", () => {
  it("drops a token from the body, so the cookie is the only way in", async () => {
    // The old shape took the token in the POST body. Nothing may quietly go on
    // accepting one there: an attacker who guessed a token could otherwise skip
    // the cookie entirely, which is the hole this schema now closes.
    expect(
      notificationPreferencesSchema.parse({ token: "utsj_abc123", reply_to_me: false }),
    ).toEqual({ reply_to_me: false });
  });
});
