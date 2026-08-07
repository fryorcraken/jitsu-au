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
 * Read the club-wide seen marker.
 *
 * `failed` exists because the two callers need opposite things from an error.
 * Counting wants to degrade to "everything is unread": over-reporting is a nudge
 * to go and look, while reporting zero would hide the thing the count exists to
 * surface. Stamping must NOT degrade that way — treating a failed read as "never
 * set" skips the only-moves-forward guard and lets a stale tab drag the marker
 * backwards. So it reports the failure and the caller decides.
 */
export async function readSeenMarker(
  admin: AdminClient,
): Promise<{ marker: string | null; failed: boolean }> {
  const { data, error } = await admin
    .from("club_settings")
    .select("value")
    .eq("key", CONTACT_SEEN_KEY)
    .maybeSingle();
  if (error) {
    console.error("[contact-messages] could not read the seen marker:", error);
    return { marker: null, failed: true };
  }
  return { marker: data?.value?.trim() ? data.value : null, failed: false };
}

/**
 * List the messages, newest first, alongside the marker they should be judged
 * against. The marker travels with the rows because the page stamps a new one as
 * soon as it loads: read it in the same breath and the screen can still show
 * which messages were new on this visit.
 *
 * `newestAt` is the boundary the page hands back to `markContactMessagesSeen`,
 * and it is **null when the list was truncated**. The marker is a watermark —
 * "everything up to here has been seen" — which is only true if the list reaches
 * back past it. Fetch the newest 200 out of 250 and the watermark would jump to
 * the newest message overall, marking 50 nobody rendered as read, in a screen
 * that has no way to scroll back to them. That is the same silent loss the
 * feature exists to prevent, so a truncated page acknowledges nothing and says
 * so instead.
 */
export const listContactMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listContactMessagesSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const [seen, { data: rows, error, count }] = await Promise.all([
      readSeenMarker(admin),
      admin
        .from("contact_messages")
        .select("id, name, email, subject, message, created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(data.limit),
    ]);
    if (error) throw new Error(error.message);

    const messages = (rows ?? []) as ContactMessage[];
    const total = count ?? messages.length;
    const truncated = total > messages.length;

    return {
      messages,
      total,
      truncated,
      seenAt: seen.marker,
      // Ordered newest-first, so the first row is the boundary that was seen.
      newestAt: truncated ? null : (messages[0]?.created_at ?? null),
      unreadIds: unreadSince(messages, seen.marker).map((m) => m.id),
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
    // Could not read the current marker, so there is nothing to compare against
    // and the only-moves-forward guard is not available. Writing anyway would be
    // the one way this operation can lose ground. Leave it; the badge stays up,
    // which is the safe direction, and the next visit tries again.
    if (current.failed) return { ok: true as const, marker: null, skipped: true as const };

    const value = advanceSeenMarker(current.marker, data.seen_at, new Date().toISOString());
    if (value === current.marker) {
      return { ok: true as const, marker: current.marker, skipped: true as const };
    }

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
    return { ok: true as const, marker: value, skipped: false as const };
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
  // A failed read degrades to null here on purpose: everything counts as unread,
  // which over-reports rather than going quiet. See `readSeenMarker`.
  const { marker: seenAt } = await readSeenMarker(admin);

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
