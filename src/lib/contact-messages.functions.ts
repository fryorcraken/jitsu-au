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
import { CONTACT_SEEN_KEY, readSeenMarker, stampSeenMarker } from "@/lib/seen-markers";
import {
  deleteContactMessageSchema,
  listContactMessagesSchema,
  markContactMessagesSeenSchema,
  unreadSince,
} from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

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
 *
 * A plain function taking the client, so the manager agent API reports the
 * inbox from the same read as the screen (docs/manager-agent-api.md). It only
 * reads: acknowledging is `markContactMessagesSeen`, always a separate call.
 */
export async function loadContactMessages(admin: AdminClient, limit: number) {
  const [seen, { data: rows, error, count }] = await Promise.all([
    readSeenMarker(admin, CONTACT_SEEN_KEY),
    admin
      .from("contact_messages")
      .select("id, name, email, subject, message, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(limit),
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
    // The screen degrades a failed marker read to "everything is unread", which
    // over-reports in the safe direction. Said out loud so a caller that cannot
    // see the server log (the agent API) can refuse instead of reporting a
    // whole inbox as never opened.
    seenFailed: seen.failed,
    // Ordered newest-first, so the first row is the boundary that was seen.
    newestAt: truncated ? null : (messages[0]?.created_at ?? null),
    unreadIds: unreadSince(messages, seen.marker).map((m) => m.id),
  };
}

export const listContactMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listContactMessagesSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return loadContactMessages(await adminClient(), data.limit);
  });

/** Thrown when a boundary to acknowledge is not any message's arrival time. */
export class NotAMessageError extends Error {}

/**
 * Move the club-wide marker up to one message: the newest the caller showed.
 *
 * The boundary arrives from outside (the screen's own list, or a manager's
 * agent), so it has to name a message that exists. An invented instant such as
 * "now" would mark seen whatever arrived after the list was read, which nobody
 * has looked at. It is matched to the millisecond rather than exactly, because
 * a client that re-serialises the timestamp (`toISOString`) keeps milliseconds
 * and drops the rest, and by instant, so any offset names the same moment.
 *
 * What is stamped is the message's own `created_at` as the database renders
 * it, never the caller's string. `advanceSeenMarker` compares markers as text,
 * which only orders correctly while every marker is written in one format: a
 * Sydney-offset string would sort after "now" and clamp the marker forward.
 *
 * Checked here rather than in either caller so the screen and the agent API
 * enforce one rule. The other guards (clamp to the present, only forwards)
 * live in `stampSeenMarker`.
 */
export async function acknowledgeContactMessages(
  admin: AdminClient,
  seenAt: string,
  userId: string,
): Promise<{ marker: string | null; skipped: boolean }> {
  const from = new Date(seenAt);
  const to = new Date(from.getTime() + 1);
  const { data: rows, error } = await admin
    .from("contact_messages")
    .select("created_at")
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const boundary = rows?.[0]?.created_at;
  if (!boundary) {
    throw new NotAMessageError("That is not the arrival time of any message in the inbox.");
  }
  return stampSeenMarker(admin, CONTACT_SEEN_KEY, boundary, userId);
}

export const markContactMessagesSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => markContactMessagesSeenSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { marker, skipped } = await acknowledgeContactMessages(
      await adminClient(),
      data.seen_at,
      context.userId,
    );
    return { ok: true as const, marker, skipped };
  });

// ---- Manager: delete a message ----
//
// The contact inbox is the one place the club holds something a person wrote
// with nothing else attached to it: no account, no waiver, no membership. Once
// a message has been dealt with there is no reason to keep their name, address
// and words on file, and until now there was no way not to. See
// docs/erasing-personal-data.md.

/**
 * Delete one message, for good. There is no copy anywhere else in the product,
 * so this is the whole record of it going.
 *
 * The club-wide seen marker is deliberately left where it is. It is a
 * watermark over timestamps, not a set of message ids, so deleting a row
 * neither breaks it nor needs it moved. If the message was still unread the
 * dashboard count simply drops by one, which is the honest reading: nobody is
 * waiting on it any more.
 */
/** Thrown when the filter matched nothing, so the caller cannot report a delete. */
export const MESSAGE_ALREADY_GONE = "That message has already been deleted.";

/**
 * Delete one message by id, and refuse to claim a delete that did not happen.
 *
 * Exported for its own test, the same reason `deleteLeadRegistrations` is: the
 * `createServerFn` wrapper below cannot be reached from the unit runner, and
 * the guard here is the whole of what makes this safe to put behind a button.
 */
export async function deleteContactMessageRow(
  admin: AdminClient,
  id: string,
): Promise<{ id: string }> {
  // `select()` so the delete reports what it actually matched. PostgREST
  // returns no error for a filter that hit nothing, and telling a manager a
  // message is deleted when it was never there is the wrong way round on a
  // screen whose whole job is not giving false reassurance.
  const { data: gone, error } = await admin
    .from("contact_messages")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!gone || gone.length === 0) throw new Error(MESSAGE_ALREADY_GONE);
  return { id };
}

export const deleteContactMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteContactMessageSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    await deleteContactMessageRow(await adminClient(), data.id);
    return { ok: true as const, id: data.id };
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
  const { marker: seenAt } = await readSeenMarker(admin, CONTACT_SEEN_KEY);

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
