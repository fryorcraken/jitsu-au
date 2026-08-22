// Calendar server functions: manager CRUD over series/events, member RSVP, the
// manager's attendance view, and personal ICS-feed tokens.
//
// Conventions mirror waiver.functions.ts: manager mutations run requireSupabaseAuth
// then re-check has_role('manager'); all DB access uses the lazily-imported
// service-role client (route/*.functions.ts files ship to the client bundle, so
// the admin client is never top-level imported). Because reads go through the
// service role (which bypasses RLS), visibility is re-applied in code here — it
// must stay in step with the RLS policies in the calendar migration.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  cancelEventSchema,
  createCalendarEntrySchema,
  deleteEventSchema,
  eventRsvpsSchema,
  nameWithPreferred,
  rsvpSchema,
  stopRepeatingSchema,
  updateCalendarEntrySchema,
} from "@/lib/validation";
import { CLUB_TIME_ZONE, diffOccurrences, generateOccurrences } from "@/lib/calendar";
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import type {
  CalendarClient,
  CalendarEventSelection,
  CalendarSeriesRow,
  EntryDetailsPatch,
} from "@/lib/calendar-types";
import type { AppClient } from "@/lib/profile-types";
import { userEmails } from "@/lib/supabase-rpc";

const SITE_URL = "https://jitsu.au";
/**
 * How far ahead a repeating entry's dates are kept on the calendar. The manager
 * never asks for this: any calendar read tops the horizon back up, so a weekly
 * entry simply keeps appearing (see topUpHorizon).
 */
const HORIZON_DAYS = 84;
/**
 * Top up once the furthest generated date falls inside this window. Keeps the
 * common read a single cheap query instead of a write on every page load.
 */
const TOPUP_WHEN_WITHIN_DAYS = 42;

const EVENT_COLUMNS =
  "id, series_id, title, description, instructor_name, location, starts_at, ends_at, status, visibility, invite_only";

/** The service-role client, typed with the calendar-aware Database. */
async function adminClient(): Promise<CalendarClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as CalendarClient;
}

/** Throw unless the caller holds the `manager` role (checked via the RLS RPC). */
async function requireManager(context: { supabase: CalendarClient; userId: string }) {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

/** A YYYY-MM-DD date `days` from now (UTC date grid). */
function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve the caller from the request bearer token, if any, and whether they may
 * see members-only events (a PAID member, or a manager). Anonymous callers get
 * `{ userId: null, canSeeMembersOnly: false }`.
 */
async function resolveViewer(): Promise<{ userId: string | null; canSeeMembersOnly: boolean }> {
  let bearer: string | null = null;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    bearer = getRequestHeader("authorization")?.replace(/^Bearer\s+/i, "") || null;
  } catch {
    /* header access unavailable */
  }
  if (!bearer) return { userId: null, canSeeMembersOnly: false };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.auth.getUser(bearer);
  const userId = data.user?.id ?? null;
  if (!userId) return { userId: null, canSeeMembersOnly: false };
  return { userId, canSeeMembersOnly: await canSeeMembersOnly(userId) };
}

/** Paid member (active, non-trial, price > 0) or manager. */
async function canSeeMembersOnly(userId: string): Promise<boolean> {
  const admin = await adminClient();
  const [{ data: paid }, { data: isMgr }] = await Promise.all([
    admin.rpc("has_active_paid_membership", { _user_id: userId }),
    admin.rpc("has_role", { _user_id: userId, _role: "manager" }),
  ]);
  return Boolean(paid) || Boolean(isMgr);
}

async function requestOrigin(): Promise<string> {
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return getRequestHeader("origin") || SITE_URL;
  } catch {
    return SITE_URL;
  }
}

function projectEvent(e: CalendarEventSelection) {
  return {
    id: e.id,
    series_id: e.series_id,
    title: e.title,
    description: e.description,
    instructor_name: e.instructor_name,
    location: e.location,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    status: e.status,
    visibility: e.visibility,
    invite_only: e.invite_only,
  };
}

// ---- Public / member: list events in a rolling window ----
// Everyone sees public events. Members-only events are added for paid members
// (and managers). Cancelled events are included so the cancellation shows.
export const getCalendar = createServerFn({ method: "GET" }).handler(async () => {
  const admin = await adminClient();
  // Keeps repeating entries appearing without anyone pressing anything.
  await topUpHorizon(admin);
  const { userId, canSeeMembersOnly: seesMembers } = await resolveViewer();
  let query = admin
    .from("calendar_events")
    .select(EVENT_COLUMNS)
    // Yesterday, not a week back: this is a "what's on" page, so it should open
    // on what's next. The one-day margin keeps today's earlier club-time
    // sessions visible despite the UTC date boundary falling mid-morning in Sydney.
    .gte("starts_at", `${dateFromNow(-1)}T00:00:00.000Z`)
    .lte("starts_at", `${dateFromNow(120)}T23:59:59.999Z`)
    .order("starts_at", { ascending: true })
    .limit(500);
  if (!seesMembers) query = query.eq("visibility", "public");
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return {
    // Any signed-in person may RSVP — trial visitors included.
    signed_in: Boolean(userId),
    sees_members_only: seesMembers,
    events: (data ?? []).map(projectEvent),
  };
});

// ---- Member: my RSVPs (event_id -> response) ----
export const getMyRsvps = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    const { data, error } = await admin
      .from("event_rsvps")
      .select("event_id, response")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ event_id: r.event_id, response: r.response }));
  });

// ---- Member: set (upsert) an RSVP ----
// Open to ANY signed-in user. The event must be one they can see: members-only
// events are refused for non-members so RSVP can't leak their existence.
export const setRsvp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rsvpSchema.parse(d))
  .handler(async ({ data, context }) => {
    const admin = await adminClient();
    const { data: event, error: evErr } = await admin
      .from("calendar_events")
      .select("id, visibility, status, ends_at")
      .eq("id", data.event_id)
      .maybeSingle();
    if (evErr) throw new Error(evErr.message);
    if (!event) throw new Error("Event not found.");
    if (event.visibility === "members" && !(await canSeeMembersOnly(context.userId))) {
      // Same message as a genuinely missing event, so this can't be used to
      // probe whether a members-only event exists.
      throw new Error("Event not found.");
    }
    if (event.status === "cancelled") throw new Error("That event has been cancelled.");
    if (new Date(event.ends_at) < new Date()) throw new Error("That event has already finished.");

    const { error } = await admin.from("event_rsvps").upsert(
      {
        event_id: data.event_id,
        user_id: context.userId,
        response: data.response,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id,user_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const, event_id: data.event_id, response: data.response };
  });

// ---- Member: personal ICS feed link ----
// One link per person, minted on first ask and shown every time afterwards, so
// the raw token is stored (see 20260728180000). The hash is still written and is
// what the feed route looks up.
//
// A link lasts until somebody replaces it. Nothing expires one on age or on a
// password change, because the only thing a member notices when a calendar link
// quietly stops working is that they stopped hearing about training.
//
// TWO things retire one, and both go through the same retire-and-mint shape so
// the retired address always answers "this was replaced" rather than reading as
// a typo: replaceMyCalendarFeedUrl below, which is a person choosing to break
// their own link, and the legacy branch in getMyCalendarFeedUrl, which has to
// because it cannot show a link it only ever stored the hash of.
//
// POST rather than GET because the first call for a person writes their row.
export const getMyCalendarFeedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    const origin = await requestOrigin();
    const feedUrl = (token: string) => ({ url: `${origin}/api/calendar/${token}` });

    const { data: existing, error } = await admin
      .from("calendar_feed_tokens")
      .select("id, token")
      .eq("user_id", context.userId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (existing?.token) return feedUrl(existing.token);

    if (existing) {
      // A link minted while only the hash was stored (before 20260728180000):
      // the raw token is not recoverable, so there is nothing to show and it has
      // to be replaced. Retired the same way a member-initiated replace retires
      // one, rather than overwritten in place, so its address answers "this link
      // was replaced" instead of the 404 that reads as a typo. Anything still
      // subscribed to it stops updating either way.
      const { error: retireError } = await admin
        .from("calendar_feed_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (retireError) throw new Error(retireError.message);
    }

    const raw = generateRawToken();
    const { error: insertError } = await admin.from("calendar_feed_tokens").insert({
      user_id: context.userId,
      token: raw,
      token_hash: await hashToken(raw),
      token_prefix: tokenPreview(raw),
    });
    if (insertError) {
      // Two first-ever loads racing (two tabs): the one-live-token-per-person
      // index rejects the loser, so use the row the winner just wrote.
      const { data: raced } = await admin
        .from("calendar_feed_tokens")
        .select("token")
        .eq("user_id", context.userId)
        .is("revoked_at", null)
        .maybeSingle();
      if (raced?.token) return feedUrl(raced.token);
      throw new Error(insertError.message);
    }
    return feedUrl(raw);
  });

/**
 * Replace the caller's calendar link: retire the one they have and mint a new
 * one, returning the new URL.
 *
 * The token cannot leave the URL path, so this is the only way a leaked link is
 * ever made harmless, and it is deliberately the member's own call to make.
 * A manager cannot do it for somebody: it silently stops that person's calendar
 * updating, and they are the one who has to re-subscribe, so the club asks them
 * instead. See docs/calendar.md.
 *
 * The old row is kept, revoked rather than deleted, so the old address can tell
 * whoever opens it that it was replaced instead of reading as a typo. Its raw
 * token is cleared on the way past: the column only exists so the page can show
 * a member their live link, and a row that is no longer anyone's live link has
 * no reason to keep the secret. The hash stays, and is what the feed matches on.
 *
 * Retired rows are never pruned, so a member pressing this repeatedly writes
 * rows nothing removes. Left alone rather than capped: every row costs a
 * deliberate press by a signed-in person, a club this size will not notice, and
 * a cap would have to decide how old a retired address may be before it goes
 * back to answering like a typo. Worth revisiting if the table ever grows.
 */
export const replaceMyCalendarFeedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    const origin = await requestOrigin();

    // Retire first: calendar_feed_tokens_one_live_idx allows one live row per
    // person, so inserting before revoking would just collide.
    const { error: revokeError } = await admin
      .from("calendar_feed_tokens")
      .update({ revoked_at: new Date().toISOString(), token: null })
      .eq("user_id", context.userId)
      .is("revoked_at", null);
    if (revokeError) throw new Error(revokeError.message);

    const raw = generateRawToken();
    const { error: insertError } = await admin.from("calendar_feed_tokens").insert({
      user_id: context.userId,
      token: raw,
      token_hash: await hashToken(raw),
      token_prefix: tokenPreview(raw),
    });
    // Deliberately not swallowed the way the mint path's race is. There, losing
    // the race means someone else already made you a link; here it means the old
    // link is retired and no new one exists, which is the one state a member
    // must not be left in believing nothing happened. There is no transaction
    // around the two statements, so a getMyCalendarFeedUrl landing in the gap
    // (the panel is mounted on two pages, so a second tab is enough) mints a row
    // and makes this insert collide. Either way the caller reacts by asking what
    // its live link is now, and getMyCalendarFeedUrl mints one for anyone left
    // without one, so the state heals rather than persisting.
    if (insertError) throw new Error(insertError.message);

    return { url: `${origin}/api/calendar/${raw}` };
  });

// ================= Manager =================

// The manager view is a single list of upcoming DATES. A repeating entry shows
// as its dates (marked "Weekly"), so there is no second list of repeat rules to
// keep in your head.
export const listManagerEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    await topUpHorizon(admin);
    const { data, error } = await admin
      .from("calendar_events")
      .select(EVENT_COLUMNS)
      .gte("starts_at", `${dateFromNow(-30)}T00:00:00.000Z`)
      .lte("starts_at", `${dateFromNow(180)}T23:59:59.999Z`)
      .order("starts_at", { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);
    const events = (data ?? []).map(projectEvent);

    // Attach a per-event RSVP tally so the manager sees interest at a glance.
    // Chunked: `.in()` becomes a query-string filter, and a few hundred UUIDs
    // blow past the proxy's request-line limit. A failure here must surface —
    // silently rendering "0 going" everywhere would be read as "nobody came".
    const ids = events.map((e) => e.id);
    const counts = new Map<string, { going: number; maybe: number; declined: number }>();
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data: rsvps, error: rErr } = await admin
        .from("event_rsvps")
        .select("event_id, response")
        .in("event_id", ids.slice(i, i + CHUNK));
      if (rErr) throw new Error(rErr.message);
      for (const r of rsvps ?? []) {
        const tally = counts.get(r.event_id) ?? { going: 0, maybe: 0, declined: 0 };
        if (r.response === "going") tally.going += 1;
        else if (r.response === "maybe") tally.maybe += 1;
        else if (r.response === "declined") tally.declined += 1;
        counts.set(r.event_id, tally);
      }
    }
    return events.map((e) => ({
      ...e,
      rsvps: counts.get(e.id) ?? { going: 0, maybe: 0, declined: 0 },
    }));
  });

/** Manager: who responded to one event, with names and emails. */
export const listEventRsvps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => eventRsvpsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { data: rows, error } = await admin
      .from("event_rsvps")
      .select("user_id, response, updated_at")
      .eq("event_id", data.event_id)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);

    const rsvps = rows ?? [];
    const userIds = [...new Set(rsvps.map((r) => r.user_id))];
    const nameByUser = new Map<string, string>();
    const emailByUser = new Map<string, string>();
    if (userIds.length) {
      // Names live on profiles; the one email store is auth.users, read via the
      // service-role-only user_emails RPC.
      const pdb = admin as unknown as AppClient;
      const [{ data: profiles, error: pErr }, { data: emails, error: eErr }] = await Promise.all([
        pdb
          .from("profiles")
          .select("user_id, first_name, middle_name, last_name, preferred_name")
          .in("user_id", userIds),
        userEmails(pdb, userIds),
      ]);
      // Surface these: silently falling back to "Someone" with no email would
      // look like missing data rather than a broken lookup.
      if (pErr) throw new Error(pErr.message);
      if (eErr) throw new Error(eErr.message);
      // Manager-facing list, so it shows the preferred name in the nickname
      // position (`Ada "Addy" Lovelace`), matching the other manager views.
      for (const p of profiles ?? []) nameByUser.set(p.user_id, nameWithPreferred(p));
      for (const e of emails ?? []) {
        emailByUser.set(e.user_id, e.email);
      }
    }

    return rsvps.map((r) => ({
      user_id: r.user_id,
      name: nameByUser.get(r.user_id) || null,
      email: emailByUser.get(r.user_id) ?? null,
      response: r.response,
      updated_at: r.updated_at,
    }));
  });

/**
 * Materialize a series' occurrences into `calendar_events` for [from, through],
 * skipping any that already exist (idempotent — we diff against existing starts
 * rather than relying on ON CONFLICT, since the uniqueness index is partial).
 */
async function materializeSeries(
  admin: CalendarClient,
  series: CalendarSeriesRow,
  fromISODate: string,
  throughISODate: string,
): Promise<number> {
  const occ = generateOccurrences(
    {
      weekday: series.weekday,
      start_time: series.start_time,
      duration_minutes: series.duration_minutes,
      starts_on: series.starts_on,
      ends_on: series.ends_on,
    },
    fromISODate,
    throughISODate,
    CLUB_TIME_ZONE,
  );
  if (occ.length === 0) return 0;

  const { data: existing, error: exErr } = await admin
    .from("calendar_events")
    .select("starts_at")
    .eq("series_id", series.id)
    .gte("starts_at", occ[0].starts_at)
    .lte("starts_at", occ[occ.length - 1].starts_at);
  if (exErr) throw new Error(exErr.message);

  // Every generated date is a copy of the entry, INCLUDING who can see it and
  // the invite-only badge. Hardcoding those (as this used to) is what made a
  // recurring members-only or invite-only entry impossible to express.
  const rows = diffOccurrences(existing ?? [], occ).map((o) => ({
    series_id: series.id,
    title: series.title,
    description: series.description,
    instructor_name: series.instructor_name,
    location: series.location,
    starts_at: o.starts_at,
    ends_at: o.ends_at,
    visibility: series.visibility,
    invite_only: series.invite_only,
  }));
  if (rows.length === 0) return 0;
  const { error: insErr } = await admin.from("calendar_events").insert(rows);
  if (insErr) throw new Error(insErr.message);
  return rows.length;
}

/**
 * Keep every active repeating entry's dates topped up to the horizon, so a
 * manager never has to press anything to make next month appear. Cheap: one
 * query for the furthest generated date per entry, and it only materialises the
 * ones running low. Best-effort — a failure here must never break a calendar
 * read, so it is caught and logged.
 *
 * Exported for the check-in screen, which lists classes without going through
 * any calendar read: without it, the first date of a brand-new weekly entry
 * could be un-check-in-able on the day it runs.
 */
export async function topUpHorizon(admin: CalendarClient): Promise<void> {
  try {
    const { data: series } = await admin.from("calendar_series").select("*").eq("is_active", true);
    if (!series?.length) return;

    const { data: furthest } = await admin
      .from("calendar_events")
      .select("series_id, starts_at")
      .not("series_id", "is", null)
      .order("starts_at", { ascending: false });

    const lastBySeries = new Map<string, string>();
    for (const row of furthest ?? []) {
      if (row.series_id && !lastBySeries.has(row.series_id)) {
        lastBySeries.set(row.series_id, row.starts_at);
      }
    }

    const threshold = `${dateFromNow(TOPUP_WHEN_WITHIN_DAYS)}T00:00:00.000Z`;
    const through = dateFromNow(HORIZON_DAYS);
    for (const row of series as CalendarSeriesRow[]) {
      const last = lastBySeries.get(row.id);
      // No dates yet, or the last one is close enough to be worth extending.
      if (last && last >= threshold) continue;
      // A finished entry has nothing left to generate.
      if (row.ends_on && row.ends_on < dateFromNow(0)) continue;
      await materializeSeries(
        admin,
        row,
        row.starts_on > dateFromNow(0) ? row.starts_on : dateFromNow(0),
        through,
      );
    }
  } catch (e) {
    console.error("[calendar] horizon top-up failed:", e);
  }
}

/**
 * Manager: put something on the calendar. One entry point for both a one-off and
 * a weekly entry — repeating is a property of the thing, not a different thing.
 */
export const createCalendarEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createCalendarEntrySchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();

    const details = {
      title: data.title,
      description: data.description ?? null,
      instructor_name: data.instructor_name ?? null,
      location: data.location ?? null,
      visibility: data.visibility,
      invite_only: data.invite_only,
      created_by: context.userId,
    };

    if (data.repeat.type === "never") {
      const { data: created, error } = await admin
        .from("calendar_events")
        .insert({ ...details, starts_at: data.repeat.starts_at, ends_at: data.repeat.ends_at })
        .select("id")
        .single();
      if (error || !created) throw new Error(error?.message || "Could not add it to the calendar.");
      return { ok: true as const, id: created.id, repeats: false as const, generated: 1 };
    }

    const { weekday, start_time, duration_minutes, starts_on, ends_on } = data.repeat;
    const { data: created, error } = await admin
      .from("calendar_series")
      .insert({
        ...details,
        weekday,
        start_time,
        duration_minutes,
        starts_on,
        ends_on: ends_on ?? null,
      })
      .select("*")
      .single();
    if (error || !created) throw new Error(error?.message || "Could not add it to the calendar.");

    const generated = await materializeSeries(
      admin,
      created as CalendarSeriesRow,
      starts_on > dateFromNow(0) ? starts_on : dateFromNow(0),
      dateFromNow(HORIZON_DAYS),
    );
    return { ok: true as const, id: created.id, repeats: true as const, generated };
  });

/**
 * Manager: edit an entry's details. `id` is always the DATE that was clicked, as
 * it is for cancelEvent. `scope: "event"` touches only that date; `scope:
 * "series"` updates the repeat rule and every date from the clicked one onward,
 * leaving earlier ones as they actually happened. Keying off the clicked date
 * (rather than the series) is what makes "this and all future dates" mean what
 * it says: dates between now and the clicked one are not rewritten.
 */
export const updateCalendarEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateCalendarEntrySchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { scope, id, ...fields } = data;
    const now = new Date().toISOString();
    // Blank text clears the field rather than storing an empty string.
    const blankToNull = (v: string | null | undefined) =>
      v === undefined ? undefined : v && v.trim() ? v : null;
    // Only the detail columns, which calendar_series and calendar_events share.
    // Built explicitly rather than spread from `fields`, so a column that exists
    // on one table and not the other can never leak into the other's update.
    const patch: EntryDetailsPatch = {
      ...(fields.title !== undefined && { title: fields.title }),
      ...(fields.description !== undefined && { description: blankToNull(fields.description) }),
      ...(fields.instructor_name !== undefined && {
        instructor_name: blankToNull(fields.instructor_name),
      }),
      ...(fields.location !== undefined && { location: blankToNull(fields.location) }),
      ...(fields.visibility !== undefined && { visibility: fields.visibility }),
      ...(fields.invite_only !== undefined && { invite_only: fields.invite_only }),
    };
    if (Object.keys(patch).length === 0) return { ok: true as const, id, updated: 0 };

    if (scope === "event") {
      const { error } = await admin
        .from("calendar_events")
        .update({ ...patch, updated_at: now })
        .eq("id", id);
      if (error) throw new Error(error.message);
      return { ok: true as const, id, updated: 1 };
    }

    // Series scope: resolve the clicked date's series, then rewrite from that
    // date forward. Never earlier: a past date records what actually happened.
    const { data: ev, error: evErr } = await admin
      .from("calendar_events")
      .select("series_id, starts_at")
      .eq("id", id)
      .maybeSingle();
    if (evErr) throw new Error(evErr.message);
    if (!ev?.series_id) throw new Error("That entry does not repeat.");
    const from = ev.starts_at > now ? ev.starts_at : now;

    const { error: sErr } = await admin
      .from("calendar_series")
      .update({ ...patch, updated_at: now })
      .eq("id", ev.series_id);
    if (sErr) throw new Error(sErr.message);
    const { error: eErr } = await admin
      .from("calendar_events")
      .update({ ...patch, updated_at: now })
      .eq("series_id", ev.series_id)
      .gte("starts_at", from);
    if (eErr) throw new Error(eErr.message);
    return { ok: true as const, id, updated: 1 };
  });

/**
 * Manager: stop a repeating entry. Future dates are removed and the rule is
 * deactivated; past dates stay, because they happened.
 */
export const stopRepeating = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => stopRepeatingSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const now = new Date().toISOString();
    const { data: series, error: sReadErr } = await admin
      .from("calendar_series")
      .select("starts_on")
      .eq("id", data.series_id)
      .maybeSingle();
    if (sReadErr) throw new Error(sReadErr.message);
    if (!series) throw new Error("That repeating entry no longer exists.");

    const { error: dErr } = await admin
      .from("calendar_events")
      .delete()
      .eq("series_id", data.series_id)
      .gte("starts_at", now);
    if (dErr) throw new Error(dErr.message);
    // `ends_on` has a CHECK against `starts_on`, so an entry stopped before its
    // first date ends on that date rather than today. is_active = false is what
    // actually stops it; the date is only for the record.
    const today = dateFromNow(0);
    const { error: sErr } = await admin
      .from("calendar_series")
      .update({
        is_active: false,
        ends_on: series.starts_on > today ? series.starts_on : today,
        updated_at: now,
      })
      .eq("id", data.series_id);
    if (sErr) throw new Error(sErr.message);
    return { ok: true as const };
  });

export const cancelEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const now = new Date().toISOString();
    const status = data.cancelled ? "cancelled" : "scheduled";

    if (data.scope === "event") {
      const { error } = await admin
        .from("calendar_events")
        .update({ status, updated_at: now })
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { ok: true as const, id: data.id, cancelled: data.cancelled };
    }

    // Series scope: this date and every future one. `id` is the event that was
    // clicked, so resolve its series first.
    const { data: ev, error: evErr } = await admin
      .from("calendar_events")
      .select("series_id, starts_at")
      .eq("id", data.id)
      .maybeSingle();
    if (evErr) throw new Error(evErr.message);
    if (!ev?.series_id) throw new Error("That entry does not repeat.");
    const { error } = await admin
      .from("calendar_events")
      .update({ status, updated_at: now })
      .eq("series_id", ev.series_id)
      .gte("starts_at", ev.starts_at);
    if (error) throw new Error(error.message);
    return { ok: true as const, id: data.id, cancelled: data.cancelled };
  });

export const deleteEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();

    // Check-ins cascade with the event, and their credits do NOT come back:
    // deleting a class five people were checked in to would silently burn five
    // sessions with no record that it happened. Delete is for a mistake made
    // before anyone turned up; once they have, cancelling is the honest move
    // (it keeps the row, the attendance and the RSVPs).
    const { count, error: cErr } = await admin
      .from("session_checkins")
      .select("id", { count: "exact", head: true })
      .eq("event_id", data.id);
    if (cErr) throw new Error(cErr.message);
    if ((count ?? 0) > 0) {
      throw new Error(
        `${count} ${count === 1 ? "person has" : "people have"} been checked in to this class, so deleting it would take their sessions with it. Cancel it instead.`,
      );
    }

    const { error } = await admin.from("calendar_events").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, id: data.id };
  });
