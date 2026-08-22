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
import { LEAD_HAS_PERSON_MESSAGE, deleteLeadSchema, normalizeEmail } from "@/lib/validation";
import { userIdByEmail } from "@/lib/supabase-rpc";

type AdminClient = SupabaseClient<Database>;

/**
 * How many of the just-seen registrations the users screen is told about, so it
 * can point at them. Far above any real visit; it exists so a bad row cannot
 * make the response unbounded.
 */
const NEW_EMAILS_LIMIT = 200;

/**
 * Registrations read in one pass when deleting a lead. Far above anything real
 * (this is one person filling in the interest form over and over), and there so
 * a delete cannot issue an unbounded read. PostgREST caps the response anyway,
 * so the choice is between a bound we can see and one we cannot.
 */
const REGISTRATIONS_PER_LEAD_LIMIT = 500;

async function adminClient(): Promise<AdminClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

// Every query below is bounded at BOTH ends: newer than the watermark, and not
// in the future.
//
// The upper bound is not defensive padding. `interest_registrations` grants
// `anon` a bare INSERT and its RLS `WITH CHECK` constrains only the person
// fields, so the publishable key in the browser bundle is enough to file a row
// stamped 2099. The watermark is clamped to the present (`advanceSeenMarker`),
// so without the bound such a row could never be brought under the marker: it
// would count as new for good, pinning an attention item that by design has no
// read state and no way to be dismissed. Bounded, a future row is simply not
// news yet.

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
  const now = new Date().toISOString();
  // A failed marker read degrades to null on purpose: everything counts as new,
  // which over-reports rather than going quiet. See `readSeenMarker`.
  const { marker: seenAt } = await readSeenMarker(admin, INTEREST_SEEN_KEY);

  let countQuery = admin
    .from("interest_registrations")
    .select("id", { count: "exact", head: true })
    .lte("created_at", now);
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
    .lte("created_at", now)
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
 * Acknowledge the registrations, and hand back who they were.
 *
 * A plain function rather than the `createServerFn` body so it is reachable
 * from a unit test: picking the NEWEST row is the highest-consequence line in
 * this file, and picking the oldest instead would barely move the marker,
 * leaving an item a manager can never put down.
 *
 * The emails are read BEFORE the marker moves, and that is the point of
 * returning them at all. Clearing the badge otherwise destroys the only record
 * of which people the badge was about: the users screen is one row per person
 * across the whole club, sorted by name, with nothing marking a new arrival.
 * `manager.contact-messages.tsx` captures its unread ids for exactly this
 * reason, and this is the same move one layer down.
 *
 * The watermark is taken from the newest row on file rather than from a
 * boundary the browser passes back, which is the one place this differs from
 * `markContactMessagesSeen`. The users screen aggregates one row per PERSON: a
 * lead who has since signed a waiver appears there as an applicant, so the
 * rendered rows cannot supply "the newest registration". What that costs is a
 * registration landing between the screen loading and this call, marked seen
 * without having been badged. Nothing is lost when that happens. A registration
 * is a person, and that person stays on the users list for good; only the badge
 * misses them.
 */
export async function acknowledgeInterestRegistrations(
  admin: AdminClient,
  userId: string,
): Promise<{ marker: string | null; skipped: boolean; newEmails: string[] }> {
  const now = new Date().toISOString();
  const { marker: seenAt } = await readSeenMarker(admin, INTEREST_SEEN_KEY);

  let query = admin
    .from("interest_registrations")
    .select("email, created_at")
    .lte("created_at", now)
    .order("created_at", { ascending: false })
    .limit(NEW_EMAILS_LIMIT);
  if (seenAt) query = query.gt("created_at", seenAt);
  const { data: rows, error } = await query;
  if (error) throw new Error(error.message);

  const fresh = rows ?? [];
  // Nothing new, so there is no watermark to move. Writing `now()` here would
  // be the one way to mark a registration seen before it exists.
  if (fresh.length === 0) return { marker: seenAt, skipped: true, newEmails: [] };

  // Ordered newest-first, so the first row is the boundary that was seen.
  const { marker, skipped } = await stampSeenMarker(
    admin,
    INTEREST_SEEN_KEY,
    fresh[0].created_at,
    userId,
  );
  return {
    marker,
    skipped,
    // Normalized, because the users screen matches these against a person's
    // auth email as well as a lead's registration email.
    newEmails: [...new Set(fresh.map((r) => normalizeEmail(r.email)))],
  };
}

/** Mark the interest registrations seen, up to the newest one on file. */
export const markInterestRegistrationsSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();
    const result = await acknowledgeInterestRegistrations(admin, context.userId);
    return { ok: true as const, ...result };
  });

// ---- Manager: delete a lead ----
//
// The one erasure the club can make without deciding anything first. A lead
// signed nothing, owes nothing and has no record hanging off them, so there is
// no evidence to weigh against destroying it. Everything else a person leaves
// behind is either a signed waiver or the club's own history, and what happens
// to those is an open question (docs/erasing-personal-data.md).

/**
 * Delete every interest-form registration filed under one email address.
 *
 * Exported for its own test: the `createServerFn` wrapper below cannot be
 * called from the unit runner (no Start request context), and the two guards
 * here are the whole feature.
 *
 * Returns how many rows went, so the caller can tell "deleted" from "somebody
 * else got there first" rather than reporting a no-op as a success.
 */
export async function deleteLeadRegistrations(
  admin: AdminClient,
  email: string,
): Promise<{ deleted: number }> {
  const wanted = normalizeEmail(email);

  // Re-checked here, never trusted from the browser. The list the Delete was
  // drawn from can be minutes old, and a waiver signed in between turns a lead
  // into an applicant with a person record, a profile and frozen evidence
  // behind the same address. Deleting their enquiry then is not tidying up an
  // untouched form, it is taking a piece out of somebody's record.
  //
  // What this closes is that staleness, not a race. The check and the delete
  // are separate round trips with no transaction around them, so a waiver
  // signed in the sub-second gap between them still loses its lead row. Worth
  // knowing rather than worth fixing: the address survives on the waiver as
  // submitted, which is the copy that matters, and this is a manager pressing a
  // button a handful of times a month.
  const { data: personId, error: personErr } = await userIdByEmail(admin, wanted);
  if (personErr) throw new Error(personErr.message);
  if (personId) throw new Error(LEAD_HAS_PERSON_MESSAGE);

  // The column stores the address exactly as it was typed, so one person can
  // hold two rows that differ only in capitalisation, and the directory already
  // merges them into a single lead. Both have to go, or the row a manager just
  // deleted comes straight back.
  //
  // `ilike` is the prefilter, not the decision. `_` is a single-character
  // wildcard in a LIKE pattern and is legal in an email local part, so this can
  // match MORE rows than it should: `a_b@example.com` also matches
  // `axb@example.com`. It can never match fewer, so the exact comparison below
  // is what chooses. Getting that backwards on a destructive path deletes a
  // stranger's enquiry. (`%` is a wildcard too; the form's validator happens to
  // reject it today, which is not something this should lean on.)
  const { data: rows, error: readErr } = await admin
    .from("interest_registrations")
    .select("id, email")
    .ilike("email", wanted)
    .limit(REGISTRATIONS_PER_LEAD_LIMIT);
  if (readErr) throw new Error(readErr.message);

  // One person filing this many interest forms is not a thing that happens, so
  // reaching the cap means something else is going on. Say so and delete what
  // was read: the rest survive, the lead reappears on the next load, and a
  // second press takes another bite. Bounded like every other read in this
  // file, and the safe direction to fail on a delete.
  if ((rows ?? []).length >= REGISTRATIONS_PER_LEAD_LIMIT) {
    console.warn(
      `[deleteLeadRegistrations] capped at ${REGISTRATIONS_PER_LEAD_LIMIT}; older registrations under this address are not deleted yet`,
    );
  }

  const ids = (rows ?? []).filter((r) => normalizeEmail(r.email) === wanted).map((r) => r.id);
  if (ids.length === 0) return { deleted: 0 };

  const { error: delErr } = await admin.from("interest_registrations").delete().in("id", ids);
  if (delErr) throw new Error(delErr.message);
  return { deleted: ids.length };
}

/**
 * Manager: delete a lead, meaning every interest-form registration under their
 * address, with the name, phone number and message they typed.
 *
 * Contact-form messages are NOT touched, even from the same address: they are a
 * separate inbox with its own screen, and a manager clearing a lead off the
 * directory has not necessarily read what that person wrote in.
 */
export const deleteLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteLeadSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { deleted } = await deleteLeadRegistrations(await adminClient(), data.email);
    // Nothing matched. Almost always a second manager (or a second tab) that
    // deleted it first, and saying so beats a success message over a row that
    // was already gone.
    if (deleted === 0) throw new Error("That enquiry has already been deleted.");
    return { ok: true as const, deleted };
  });
