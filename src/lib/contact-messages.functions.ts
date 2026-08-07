// Manager access to the messages the public contact form has received.
//
// `contact_messages` grants `anon` INSERT and deliberately nothing else, so
// there is no read path for a browser or for a caller-scoped client — every read
// here goes through the service role behind the manager gate, which is why this
// feature needed no migration and no new grant. See docs/database.md.
//
// "Unread" is a single club-wide marker in `club_settings`, not a per-message
// flag: the club shares one inbox, every manager is emailed every message, and a
// per-manager marker would need a table of its own.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireManager } from "@/lib/require-manager";
import {
  advanceSeenMarker,
  listContactMessagesSchema,
  markContactMessagesSeenSchema,
  unreadSince,
} from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** `club_settings` key holding the instant a manager last opened the inbox. */
export const CONTACT_SEEN_KEY = "contact_messages_seen_at";

export type ContactMessage = {
  id: string;
  name: string;
  email: string;
  subject: string | null;
  message: string;
  created_at: string;
};

async function adminClient(): Promise<AdminClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * Read the club-wide seen marker. Returns null when it has never been set (so
 * everything is unread) and, deliberately, also on a read error: a dashboard
 * over-reporting unread messages is a nudge to go and look, while one that
 * silently reports zero would hide the very thing it exists to surface.
 */
export async function readSeenMarker(admin: AdminClient): Promise<string | null> {
  const { data, error } = await admin
    .from("club_settings")
    .select("value")
    .eq("key", CONTACT_SEEN_KEY)
    .maybeSingle();
  if (error) {
    console.error("[contact-messages] could not read the seen marker:", error);
    return null;
  }
  return data?.value?.trim() ? data.value : null;
}

/**
 * List the messages, newest first, alongside the marker they should be judged
 * against. The marker travels with the rows because the page stamps a new one as
 * soon as it loads: read it in the same breath and the screen can still show
 * which messages were new on this visit.
 *
 * `newestAt` is the boundary the page hands back to `markContactMessagesSeen`.
 * Null when there is nothing to mark.
 */
export const listContactMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listContactMessagesSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const [seenAt, { data: rows, error }] = await Promise.all([
      readSeenMarker(admin),
      admin
        .from("contact_messages")
        .select("id, name, email, subject, message, created_at")
        .order("created_at", { ascending: false })
        .limit(data.limit),
    ]);
    if (error) throw new Error(error.message);

    const messages = (rows ?? []) as ContactMessage[];
    return {
      messages,
      seenAt,
      // Ordered newest-first, so the first row is the boundary that was seen.
      newestAt: messages[0]?.created_at ?? null,
      unreadIds: unreadSince(messages, seenAt).map((m) => m.id),
    };
  });

/**
 * Move the club-wide marker up to the newest message the caller actually saw.
 *
 * It takes that instant rather than stamping `now()`, because "now" is a moment
 * later than the list it is acknowledging: a message arriving in the gap between
 * the two calls would be marked read without ever having been listed, badged or
 * counted, which is the one way this feature could lose a message outright.
 *
 * Two guards, because the boundary arrives from the browser: it is clamped to
 * the present (nobody can mark future messages read), and it only ever moves
 * forward, so a stale tab finishing late cannot drag the marker back and make
 * already-read messages reappear.
 */
export const markContactMessagesSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => markContactMessagesSeenSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const current = await readSeenMarker(admin);
    const value = advanceSeenMarker(current, data.seen_at, new Date().toISOString());
    if (value === current) return { ok: true as const, marker: current };

    const { error } = await admin.from("club_settings").upsert(
      {
        key: CONTACT_SEEN_KEY,
        value,
        updated_at: new Date().toISOString(),
        updated_by: context.userId,
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const, marker: value };
  });

/**
 * What the dashboard needs: how many messages are unread, and enough about the
 * newest one to say who is waiting. Counted in the database rather than by
 * fetching the rows, since the dashboard never shows the messages themselves.
 */
export async function countUnreadContactMessages(admin: AdminClient): Promise<{
  unread: number;
  latestName: string | null;
  latestAt: string | null;
}> {
  const seenAt = await readSeenMarker(admin);

  let countQuery = admin.from("contact_messages").select("id", { count: "exact", head: true });
  if (seenAt) countQuery = countQuery.gt("created_at", seenAt);
  const { count, error } = await countQuery;
  // Degrade rather than throw. This runs inside the dashboard's Promise.all, so
  // throwing here would take down the whole "needs attention" queue — including
  // the pre-existing training-dates warning, which has nothing to do with
  // contact messages and was working fine before this feature existed.
  if (error) {
    console.error("[contact-messages] could not count unread messages:", error);
    return { unread: 0, latestName: null, latestAt: null };
  }
  const unread = count ?? 0;
  if (unread === 0) return { unread: 0, latestName: null, latestAt: null };

  let latestQuery = admin
    .from("contact_messages")
    .select("name, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (seenAt) latestQuery = latestQuery.gt("created_at", seenAt);
  const { data: latest, error: latestError } = await latestQuery.maybeSingle();
  // The count is the part the notification cannot do without; a missing name
  // just makes the copy vaguer, so degrade rather than fail the whole dashboard.
  if (latestError) {
    console.error("[contact-messages] could not read the newest message:", latestError);
    return { unread, latestName: null, latestAt: null };
  }
  return {
    unread,
    latestName: latest?.name ?? null,
    latestAt: latest?.created_at ?? null,
  };
}
