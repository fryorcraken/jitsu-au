// Club-wide "seen up to here" watermarks, kept in `club_settings`.
//
// A marker is one ISO instant under one key: everything in some table created
// after it has not been looked at yet. That is what turns a table nobody can
// mark read (the public intake tables grant `anon` INSERT and nothing else)
// into a "needs attention" count that clears itself.
//
// It is deliberately club-wide rather than per manager. The club shares one
// inbox and one funnel, and a per-manager watermark would need a table of its
// own. See docs/database.md under `club_settings`.
//
// Extracted from `contact-messages.functions.ts` when interest registrations
// grew the same need. The reasoning in `readSeenMarker` about which caller may
// degrade and which may not is the part worth having in one place: it is not
// guessable from the code, and getting it backwards loses a message.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { advanceSeenMarker } from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** `club_settings` key holding the instant a manager last opened the inbox. */
export const CONTACT_SEEN_KEY = "contact_messages_seen_at";

/** `club_settings` key holding the instant a manager last opened the users list. */
export const INTEREST_SEEN_KEY = "interest_registrations_seen_at";

/**
 * Read a marker.
 *
 * `failed` exists because the two kinds of caller need opposite things from an
 * error. Counting wants to degrade to "everything is unread": over-reporting is
 * a nudge to go and look, while reporting zero would hide the thing the count
 * exists to surface. Stamping must NOT degrade that way, since treating a failed
 * read as "never set" skips the only-moves-forward guard and lets a stale tab
 * drag the marker backwards. So it reports the failure and the caller decides.
 */
export async function readSeenMarker(
  admin: AdminClient,
  key: string,
): Promise<{ marker: string | null; failed: boolean }> {
  const { data, error } = await admin
    .from("club_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error(`[seen-markers] could not read ${key}:`, error);
    return { marker: null, failed: true };
  }
  return { marker: data?.value?.trim() ? data.value : null, failed: false };
}

/**
 * Move a marker up to the newest thing the caller actually saw.
 *
 * `seenAt` is that thing's own timestamp rather than `now()`, because "now" is a
 * moment later than the list it is acknowledging: a row arriving in the gap
 * between reading the list and stamping would be marked seen without ever having
 * been rendered, badged or counted.
 *
 * Two guards, because the boundary usually arrives from a browser: it is clamped
 * to the present (nobody marks the future read), and it only ever moves forward,
 * so a stale tab finishing late cannot drag the marker back and make already-read
 * rows reappear.
 */
export async function stampSeenMarker(
  admin: AdminClient,
  key: string,
  seenAt: string,
  userId: string,
): Promise<{ marker: string | null; skipped: boolean }> {
  const current = await readSeenMarker(admin, key);
  // Could not read the current marker, so there is nothing to compare against
  // and the only-moves-forward guard is not available. Writing anyway would be
  // the one way this operation can lose ground. Leave it; the badge stays up,
  // which is the safe direction, and the next visit tries again.
  if (current.failed) return { marker: null, skipped: true };

  const value = advanceSeenMarker(current.marker, seenAt, new Date().toISOString());
  if (value === current.marker) return { marker: current.marker, skipped: true };

  const { error } = await admin.from("club_settings").upsert(
    {
      key,
      value,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: "key" },
  );
  if (error) throw new Error(error.message);
  return { marker: value, skipped: false };
}
