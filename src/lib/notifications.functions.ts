// Server functions behind /notifications and the signed-out email settings
// page.
//
// ⚠️ This file is bundled to the CLIENT (every `*.functions.ts` is), so the
// service-role client is lazy-imported inside each handler and never at the top
// level. The rules themselves live in `src/lib/notifications.ts`, which is pure
// and imported freely.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  emailPreferenceKeys,
  resolveNotificationPreferences,
  type EmailPreferenceKey,
  type NotificationItem,
  type NotificationKind,
  type NotificationPreferenceRow,
} from "@/lib/notifications";
import { managerAttentionItems } from "@/lib/manager-notifications.functions";
import {
  markNotificationsReadSchema,
  notificationPreferencesByTokenSchema,
  notificationPreferencesSchema,
  notificationTokenSchema,
  type ManagerNotification,
} from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** How many activity rows the page shows. Older ones stay in the database and
 * still count as read/unread; nobody scrolls a year of comment traffic. */
const PAGE_LIMIT = 100;

async function adminClient(): Promise<AdminClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function isManager(db: AdminClient, userId: string): Promise<boolean> {
  // `has_role` is `SELECT EXISTS(...)` so it never returns NULL and needs no
  // wrapper in `supabase-rpc.ts` (see the CLAUDE.md note on RPC nullability).
  const { data, error } = await db.rpc("has_role", { _user_id: userId, _role: "manager" });
  if (error) {
    // A failed role lookup is NOT "not a manager". Saying so here would empty
    // the attention list on a real manager's page and read as "all quiet" while
    // the club had no sellable training dates.
    throw new Error("Could not confirm your access just now. Reload the page and try again.");
  }
  return Boolean(data);
}

/** Read somebody's preferences row. A missing row is not an error: it means
 * they have never touched a switch, and every switch resolves to its default. */
export async function readPreferences(
  db: AdminClient,
  userId: string,
): Promise<NotificationPreferenceRow | null> {
  const { data, error } = await db
    .from("notification_preferences")
    .select("reply_to_me, thread_activity, new_blog_post, manager_comment_alerts")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** Apply a patch to somebody's switches.
 *
 * Only keys actually present in the patch are written, so a page that renders
 * one switch cannot blank the other three. `null` is a real value here and is
 * written as such, handing that switch back to the club default. */
async function writePreferences(
  db: AdminClient,
  userId: string,
  patch: Partial<Record<EmailPreferenceKey, boolean | null>>,
): Promise<NotificationPreferenceRow> {
  const update: Record<string, boolean | null | string> = {};
  for (const key of emailPreferenceKeys) {
    if (key in patch) update[key] = patch[key] ?? null;
  }
  const { data, error } = await db
    .from("notification_preferences")
    .upsert(
      { user_id: userId, ...update, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    )
    .select("reply_to_me, thread_activity, new_blog_post, manager_comment_alerts")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export type NotificationsPayload = {
  attention: ManagerNotification[];
  items: NotificationItem[];
  preferences: Record<EmailPreferenceKey, boolean>;
  isManager: boolean;
};

/** Everything the /notifications page and the sidebar badge need, in one call.
 * They read the same cached query, so the badge and the list cannot disagree. */
export const listMyNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<NotificationsPayload> => {
    const db = await adminClient();
    const userId = context.userId;
    const manager = await isManager(db, userId);

    const [{ data: rows, error }, prefs, attention] = await Promise.all([
      db
        .from("notifications")
        .select("id, kind, title, body, href, read_at, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(PAGE_LIMIT),
      readPreferences(db, userId),
      // Attention items are manager-only. A member asking gets an empty list
      // rather than an error, so the page renders one way for everybody.
      manager ? managerAttentionItems(db) : Promise.resolve([] as ManagerNotification[]),
    ]);
    if (error) throw new Error(error.message);

    return {
      attention,
      items: (rows ?? []).map((r) => ({
        id: r.id,
        kind: r.kind as NotificationKind,
        title: r.title,
        body: r.body,
        href: r.href,
        read_at: r.read_at,
        created_at: r.created_at,
      })),
      preferences: resolveNotificationPreferences(prefs),
      isManager: manager,
    };
  });

/** Mark notifications read. Scoped to the caller's own rows in the query
 * itself, so naming somebody else's id marks nothing rather than erroring. */
export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => markNotificationsReadSchema.parse(d))
  .handler(async ({ data, context }) => {
    const db = await adminClient();
    let query = db
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", context.userId)
      .is("read_at", null);
    // An absent list is "all of mine" ("Mark all as read"). An empty array is
    // not the same thing and must be a no-op, or opening a page with nothing on
    // it would silently clear the whole history.
    if (data.ids) {
      if (data.ids.length === 0) return { ok: true as const, marked: 0 };
      query = query.in("id", data.ids);
    }
    const { data: updated, error } = await query.select("id");
    if (error) throw new Error(error.message);
    return { ok: true as const, marked: (updated ?? []).length };
  });

/** Read the caller's own switches. */
export const getMyNotificationPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await adminClient();
    return resolveNotificationPreferences(await readPreferences(db, context.userId));
  });

/** Save the caller's own switches. */
export const saveMyNotificationPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => notificationPreferencesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const db = await adminClient();
    const row = await writePreferences(db, context.userId, data);
    return resolveNotificationPreferences(row);
  });

/**
 * Resolve the person behind a settings-link token.
 *
 * Returns null for anything that does not match, and the CALLER must render the
 * same page for null as for a rotated token: a response that distinguished
 * "no such token" from "expired" would turn this into a way to probe which
 * links the club has issued. Same uniform-response reasoning as
 * `src/routes/api/verify-email/$token.ts`.
 */
async function userIdForToken(db: AdminClient, raw: string): Promise<string | null> {
  const { hashToken } = await import("@/lib/manager-api-tokens");
  let token_hash: string;
  try {
    token_hash = await hashToken(raw);
  } catch {
    return null;
  }
  const { data, error } = await db
    .from("notification_tokens")
    .select("user_id")
    .eq("token_hash", token_hash)
    .maybeSingle();
  if (error || !data) return null;
  return data.user_id;
}

export type TokenSettings =
  | { ok: true; preferences: Record<EmailPreferenceKey, boolean> }
  | { ok: false };

/** Read the switches behind a footer link, with no session. */
export const getNotificationPreferencesByToken = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => notificationTokenSchema.parse(d))
  .handler(async ({ data }): Promise<TokenSettings> => {
    const db = await adminClient();
    const userId = await userIdForToken(db, data.token);
    if (!userId) return { ok: false };
    return {
      ok: true,
      preferences: resolveNotificationPreferences(await readPreferences(db, userId)),
    };
  });

/** Save the switches behind a footer link, with no session. */
export const saveNotificationPreferencesByToken = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => notificationPreferencesByTokenSchema.parse(d))
  .handler(async ({ data }): Promise<TokenSettings> => {
    const db = await adminClient();
    const userId = await userIdForToken(db, data.token);
    if (!userId) return { ok: false };
    const { token: _token, ...patch } = data;
    const row = await writePreferences(db, userId, patch);
    return { ok: true, preferences: resolveNotificationPreferences(row) };
  });
