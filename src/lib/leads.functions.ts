// The first step of signing up, as a manager sees it: somebody filled in the
// interest form.
//
// `interest_registrations` grants `anon` INSERT and deliberately nothing else,
// so every read here goes through the service role behind the manager gate.
// Same shape as `contact-messages.functions.ts`, and for the same reason: there
// is no per-row read state to hang a badge on, so "new" is everything created
// after one club-wide watermark in `club_settings` (see `seen-markers.ts`).
//
// The counterpart to this file's count is `countWaiversAwaitingApproval` in
// `waiver.functions.ts`. Together they are the two steps of signing up that a
// manager needs to see: one is news, the other is work.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireManager } from "@/lib/require-manager";
import { INTEREST_SEEN_KEY, readSeenMarker, stampSeenMarker } from "@/lib/seen-markers";

type AdminClient = SupabaseClient<Database>;

async function adminClient(): Promise<AdminClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * How many people have registered interest since a manager last opened the
 * users list, and enough about the newest one to name them.
 *
 * Counted in the database rather than by fetching the rows: the notification
 * never shows the registrations themselves, it points at the list.
 */
export async function countNewInterestRegistrations(admin: AdminClient): Promise<{
  unread: number;
  latestName: string | null;
  latestAt: string | null;
}> {
  // A failed marker read degrades to null on purpose: everything counts as new,
  // which over-reports rather than going quiet. See `readSeenMarker`.
  const { marker: seenAt } = await readSeenMarker(admin, INTEREST_SEEN_KEY);

  let countQuery = admin
    .from("interest_registrations")
    .select("id", { count: "exact", head: true });
  if (seenAt) countQuery = countQuery.gt("created_at", seenAt);
  const { count, error } = await countQuery;
  // Degrade rather than throw. This runs inside the attention list's
  // Promise.all, so throwing here would take down the whole manager queue,
  // including the waiver approvals and the training-dates warning, which have
  // nothing to do with interest registrations.
  if (error) {
    console.error("[leads] could not count new interest registrations:", error);
    return { unread: 0, latestName: null, latestAt: null };
  }
  const unread = count ?? 0;
  if (unread === 0) return { unread: 0, latestName: null, latestAt: null };

  let latestQuery = admin
    .from("interest_registrations")
    .select("name, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (seenAt) latestQuery = latestQuery.gt("created_at", seenAt);
  const { data: latest, error: latestError } = await latestQuery.maybeSingle();
  // The count is the part the notification cannot do without; a missing name
  // only makes the copy vaguer.
  if (latestError) {
    console.error("[leads] could not read the newest interest registration:", latestError);
    return { unread, latestName: null, latestAt: null };
  }
  return {
    unread,
    latestName: latest?.name ?? null,
    latestAt: latest?.created_at ?? null,
  };
}

/**
 * Mark the interest registrations seen, up to the newest one on file right now.
 *
 * Stamped from the database rather than from a boundary the browser passes back,
 * which is the one place this differs from `markContactMessagesSeen` and it is a
 * deliberate trade. The users list aggregates one row per PERSON: a lead who has
 * since signed a waiver is on that screen as an applicant, not as a lead, so the
 * rendered rows cannot supply "the newest registration" without the screen
 * re-deriving what the count was made of.
 *
 * What that costs: a registration landing between the users list loading and
 * this call is marked seen without having been badged. Unlike a contact message,
 * nothing is lost when that happens. A registration is a person, and that person
 * stays on the users list for good; only the badge misses them.
 */
export const markInterestRegistrationsSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const { data: latest, error } = await admin
      .from("interest_registrations")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Nothing has ever been registered, so there is no watermark to set. Writing
    // `now()` here would be the one way to mark a registration seen before it
    // exists.
    if (!latest) return { ok: true as const, marker: null, skipped: true as const };

    const { marker, skipped } = await stampSeenMarker(
      admin,
      INTEREST_SEEN_KEY,
      latest.created_at,
      context.userId,
    );
    return { ok: true as const, marker, skipped };
  });
