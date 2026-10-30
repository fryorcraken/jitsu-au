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
import {
  CLUB_TIME_ZONE,
  WEEKDAY_LABELS,
  diffOccurrences,
  firstDateToCome,
  generateOccurrences,
  weeklyRunsShareADate,
  withoutHiddenInviteOnly,
} from "@/lib/calendar";
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import type {
  CalendarClient,
  CalendarEventSelection,
  CalendarSeriesRow,
  EntryDetailsPatch,
} from "@/lib/calendar-types";
import type {
  CancelEventInput,
  CreateCalendarEntryInput,
  DeleteEventInput,
  EventRsvpsInput,
  StopRepeatingInput,
  UpdateCalendarEntryInput,
} from "@/lib/validation";
import type { AppClient } from "@/lib/profile-types";
import { userEmails } from "@/lib/supabase-rpc";
import { SITE_ORIGIN, linkOrigin } from "@/lib/site-origin";

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

/**
 * Why the manager calendar refused a change, for a caller that has to act on it
 * rather than read it. The screen shows `message`; the manager agent API turns
 * `reason` into a status code and an error code (`docs/manager-agent-api.md`).
 *
 * - `not_found`: no such date (or repeat) on the calendar.
 * - `not_repeating`: asked for "this and every future date" on a one-off.
 * - `repeating_date`: asked to delete one date of a repeat, which the next
 *   top-up would only put back.
 * - `checked_in`: asked to delete a class people were checked in to.
 * - `already_on_calendar`: asked to add something that is already there.
 * - `no_dates`: asked to add a weekly entry that would never put a date on the
 *   calendar (its last date has passed, or no date in it is on that weekday).
 */
export type CalendarRefusal =
  | "not_found"
  | "not_repeating"
  | "repeating_date"
  | "checked_in"
  | "already_on_calendar"
  | "no_dates";

export class CalendarEntryError extends Error {
  reason: CalendarRefusal;
  details?: Record<string, unknown>;
  constructor(reason: CalendarRefusal, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CalendarEntryError";
    this.reason = reason;
    this.details = details;
  }
}

const NO_SUCH_DATE = "That date is no longer on the calendar. Refresh the list and try again.";
const NOT_REPEATING = "That entry does not repeat.";

/** A YYYY-MM-DD date `days` from now (UTC date grid). */
function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

type Viewer = { userId: string | null; canSeeMembersOnly: boolean; isManager: boolean };

/**
 * Resolve the caller from the request bearer token, if any, whether they may
 * see members-only events (a PAID member, or a manager), and whether they are a
 * manager (who also sees every invite-only date). Anonymous callers get
 * `{ userId: null, canSeeMembersOnly: false, isManager: false }`.
 */
async function resolveViewer(): Promise<Viewer> {
  const anonymous: Viewer = { userId: null, canSeeMembersOnly: false, isManager: false };
  let bearer: string | null = null;
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    bearer = getRequestHeader("authorization")?.replace(/^Bearer\s+/i, "") || null;
  } catch {
    /* header access unavailable */
  }
  if (!bearer) return anonymous;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.auth.getUser(bearer);
  const userId = data.user?.id ?? null;
  if (!userId) return anonymous;
  const access = await calendarAccess(userId);
  return {
    userId,
    canSeeMembersOnly: access.paid || access.isManager,
    isManager: access.isManager,
  };
}

/** Whether a person holds a paid membership, and whether they are a manager. */
async function calendarAccess(userId: string): Promise<{ paid: boolean; isManager: boolean }> {
  const admin = await adminClient();
  const [{ data: paid }, { data: isMgr }] = await Promise.all([
    admin.rpc("has_active_paid_membership", { _user_id: userId }),
    admin.rpc("has_role", { _user_id: userId, _role: "manager" }),
  ]);
  return { paid: Boolean(paid), isManager: Boolean(isMgr) };
}

/** Paid member (active, non-trial, price > 0) or manager. */
async function canSeeMembersOnly(userId: string): Promise<boolean> {
  const { paid, isManager } = await calendarAccess(userId);
  return paid || isManager;
}

/**
 * The invite-only dates this viewer may see: managers see all of them, a
 * signed-in person sees the ones they are invited to (an RSVP row), and
 * anybody not signed in sees none. Mirrors the `calendar_events` read policies,
 * which the service role skips.
 */
async function hideInviteOnlyFor<
  E extends { id: string; series_id: string | null; invite_only: boolean },
>(admin: CalendarClient, viewer: Viewer, events: E[]): Promise<E[]> {
  if (viewer.isManager) return events;
  const [rsvps, inviteSeries] = await Promise.all([
    viewer.userId
      ? admin.from("event_rsvps").select("event_id").eq("user_id", viewer.userId)
      : Promise.resolve({ data: [] as { event_id: string }[], error: null }),
    admin.from("calendar_series").select("id").eq("invite_only", true),
  ]);
  // Fail closed: without these answers there is no telling which dates are
  // hidden, and showing an invite-only date to the wrong person is worse than
  // a calendar that does not load.
  if (rsvps.error) throw new Error(rsvps.error.message);
  if (inviteSeries.error) throw new Error(inviteSeries.error.message);
  return withoutHiddenInviteOnly(events, {
    isManager: false,
    invitedEventIds: new Set((rsvps.data ?? []).map((r) => r.event_id)),
    inviteOnlySeriesIds: new Set((inviteSeries.data ?? []).map((s) => s.id)),
  });
}

async function requestOrigin(): Promise<string> {
  try {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return linkOrigin(getRequestHeader("origin"));
  } catch {
    return SITE_ORIGIN;
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
  const viewer = await resolveViewer();
  const { userId, canSeeMembersOnly: seesMembers } = viewer;
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
  // The query above applies `visibility` only. Invite-only dates are dropped
  // here, after it, for anyone who is neither invited nor a manager.
  const visible = await hideInviteOnlyFor(admin, viewer, data ?? []);
  return {
    // Any signed-in person may RSVP — trial visitors included.
    signed_in: Boolean(userId),
    sees_members_only: seesMembers,
    events: visible.map(projectEvent),
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
      // Nothing to fall back on, and the retire above already happened, so this
      // person would be left with NO live link and a dead address, from a page
      // load that was only meant to show them something. There is no
      // transaction around the two statements, so put the old row back by hand
      // before reporting the failure: the next load then finds it and takes the
      // same branch again, rather than the member's calendar silently stopping.
      if (existing) {
        await admin.from("calendar_feed_tokens").update({ revoked_at: null }).eq("id", existing.id);
      }
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
 * Retired rows are never pruned, so every call writes a row nothing removes, and
 * nothing rate-limits the call: a signed-in account, or a stolen session, can
 * loop it. Left uncapped for now because a club this size will not notice, and
 * because a cap has to decide how long a retired address may keep explaining
 * itself before it goes back to answering like a typo. That is a judgement, not
 * a guarantee, so revisit it if the table ever grows.
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
//
// The manager calendar's reads and writes below are plain functions taking the
// client, each wrapped by a thin server function that checks the role first.
// The manager agent API (src/lib/manager-agent-actions.ts) calls the same
// functions, so the screen and an agent read and write the calendar the same
// way (CLAUDE.md, "A manager screen and the manager agent API report the same
// thing").

/** Every date from a month back to six months ahead, each with its RSVP tally. */
export async function listManagerEventRows(admin: CalendarClient) {
  await topUpHorizon(admin);
  const { data, error } = await admin
    .from("calendar_events")
    .select(EVENT_COLUMNS)
    .gte("starts_at", `${dateFromNow(-30)}T00:00:00.000Z`)
    .lte("starts_at", `${dateFromNow(180)}T23:59:59.999Z`)
    .order("starts_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);
  // Who can see a date is its own invite-only flag OR its weekly entry's (the
  // read policies and `withoutHiddenInviteOnly` both ask both), so the list
  // reports that, not the date's own column, which an entry made invite only
  // "from this date on" leaves false on the dates before it.
  const { data: inviteSeries, error: iErr } = await admin
    .from("calendar_series")
    .select("id")
    .eq("invite_only", true);
  if (iErr) throw new Error(iErr.message);
  const inviteOnlySeries = new Set((inviteSeries ?? []).map((s) => s.id));
  const events = (data ?? []).map((e) => ({
    ...projectEvent(e),
    invite_only: e.invite_only || (e.series_id !== null && inviteOnlySeries.has(e.series_id)),
  }));

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
}

export const listManagerEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return listManagerEventRows(await adminClient());
  });

/** Who responded to one date, with names and emails. */
export async function listEventRsvpRows(admin: CalendarClient, data: EventRsvpsInput) {
  // An empty list has to mean "nobody has replied", never "no such date".
  const { data: event, error: evErr } = await admin
    .from("calendar_events")
    .select("id")
    .eq("id", data.event_id)
    .maybeSingle();
  if (evErr) throw new Error(evErr.message);
  if (!event) throw new CalendarEntryError("not_found", NO_SUCH_DATE);

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
}

/** Manager: who responded to one event, with names and emails. */
export const listEventRsvps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => eventRsvpsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return listEventRsvpRows(await adminClient(), data);
  });

/**
 * Materialize a series' occurrences into `calendar_events` for [from, through],
 * skipping any that already exist (idempotent — we diff against existing starts
 * rather than relying on ON CONFLICT, since the uniqueness index is partial).
 * Returns the dates it added.
 */
async function materializeSeries(
  admin: CalendarClient,
  series: CalendarSeriesRow,
  fromISODate: string,
  throughISODate: string,
): Promise<CalendarEventSelection[]> {
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
  if (occ.length === 0) return [];

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
  if (rows.length === 0) return [];
  const { data: inserted, error: insErr } = await admin
    .from("calendar_events")
    .insert(rows)
    .select(EVENT_COLUMNS);
  if (insErr) throw new Error(insErr.message);
  return [...(inserted ?? [])].sort(
    (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  );
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
 * Refuse an entry that is already on the calendar:
 *
 * - a one-off with the same title and start as a date already there (a
 *   one-off or one week of a repeat). A CANCELLED date there only counts if it
 *   also ends at the same time: "cancel this date and add a one-off" is how a
 *   single class is made longer, and that one-off starts where the cancelled
 *   date did.
 * - a weekly entry with the same title, weekday and time as an active one that
 *   holds, or will hold, any of the same dates (`weeklyRunsShareADate`). Next
 *   semester's run of a class is added while this semester's is still on, and
 *   is not a duplicate of it.
 *
 * Nobody adds the same class twice on purpose, and the one way it happens by
 * accident is a retry: a manager's agent that never heard back from its first
 * try and sends it again. There is no submission id to dedupe on (that would
 * need a column), so the entry itself is the key. Check-then-insert, so two
 * truly simultaneous tries can still both land; that is the screen's double
 * click, which its busy state already covers.
 */
async function refuseDuplicateEntry(admin: CalendarClient, data: CreateCalendarEntryInput) {
  if (data.repeat.type === "never") {
    const { data: same, error } = await admin
      .from("calendar_events")
      .select("id, series_id, status, ends_at")
      .eq("title", data.title)
      .eq("starts_at", data.repeat.starts_at);
    if (error) throw new Error(error.message);
    // Instants, not strings: PostgREST answers "+00:00" where the input says "Z".
    const endsAt = new Date(data.repeat.ends_at).getTime();
    const existing =
      same?.find((e) => e.status !== "cancelled") ??
      same?.find((e) => new Date(e.ends_at).getTime() === endsAt);
    if (!existing) return;
    const cancelled = existing.status === "cancelled";
    throw new CalendarEntryError(
      "already_on_calendar",
      cancelled
        ? `"${data.title}" is already on the calendar at that time, cancelled. Restore it rather than adding it again.`
        : `"${data.title}" is already on the calendar at that time. To add a second one, give it a different title.`,
      { event_id: existing.id, series_id: existing.series_id, status: existing.status },
    );
  }
  const run = {
    weekday: data.repeat.weekday,
    starts_on: data.repeat.starts_on,
    ends_on: data.repeat.ends_on ?? null,
  };
  const { data: same, error } = await admin
    .from("calendar_series")
    .select("id, starts_on, ends_on")
    .eq("title", data.title)
    .eq("weekday", data.repeat.weekday)
    .eq("start_time", data.repeat.start_time)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  const existing = (same ?? []).find((s) => weeklyRunsShareADate(s, run, dateFromNow(0)));
  if (!existing) return;
  throw new CalendarEntryError(
    "already_on_calendar",
    `"${data.title}" already repeats every ${WEEKDAY_LABELS[data.repeat.weekday]} at ${data.repeat.start_time}. To add a second one, give it a different title.`,
    { series_id: existing.id },
  );
}

/**
 * Put something on the calendar. One entry point for both a one-off and a weekly
 * entry — repeating is a property of the thing, not a different thing.
 * `actingAs` is the manager, recorded as the entry's `created_by`.
 *
 * `id` is the date for a one-off and the repeat (the series) for a weekly entry;
 * `dates` is every date this call put on the calendar, which for a weekly entry
 * is the ones inside the horizon (more appear as they get close).
 */
export async function createCalendarEntryRow(
  admin: CalendarClient,
  data: CreateCalendarEntryInput,
  actingAs: string,
) {
  // Dates are only ever generated from today on, so a weekly entry whose last
  // date has passed, or whose dates hold no such weekday, would be saved and
  // never appear: reported as "added" with nothing to show for it.
  if (
    data.repeat.type === "weekly" &&
    !firstDateToCome(
      {
        weekday: data.repeat.weekday,
        starts_on: data.repeat.starts_on,
        ends_on: data.repeat.ends_on ?? null,
      },
      dateFromNow(0),
    )
  ) {
    throw new CalendarEntryError(
      "no_dates",
      `No ${WEEKDAY_LABELS[data.repeat.weekday]} from ${data.repeat.starts_on} to ${data.repeat.ends_on} is still to come, so this would put nothing on the calendar. Check the day and the dates.`,
    );
  }
  await refuseDuplicateEntry(admin, data);
  const details = {
    title: data.title,
    description: data.description ?? null,
    instructor_name: data.instructor_name ?? null,
    location: data.location ?? null,
    visibility: data.visibility,
    invite_only: data.invite_only,
    created_by: actingAs,
  };

  if (data.repeat.type === "never") {
    const { data: created, error } = await admin
      .from("calendar_events")
      .insert({ ...details, starts_at: data.repeat.starts_at, ends_at: data.repeat.ends_at })
      .select(EVENT_COLUMNS)
      .single();
    if (error || !created) throw new Error(error?.message || "Could not add it to the calendar.");
    return {
      ok: true as const,
      id: created.id,
      repeats: false as const,
      generated: 1,
      dates: [projectEvent(created)],
    };
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

  const dates = await materializeSeries(
    admin,
    created as CalendarSeriesRow,
    starts_on > dateFromNow(0) ? starts_on : dateFromNow(0),
    dateFromNow(HORIZON_DAYS),
  );
  return {
    ok: true as const,
    id: created.id,
    repeats: true as const,
    generated: dates.length,
    dates: dates.map(projectEvent),
  };
}

/** Manager: put something on the calendar. */
export const createCalendarEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createCalendarEntrySchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return createCalendarEntryRow(await adminClient(), data, context.userId);
  });

/**
 * Edit an entry's details. `id` is always the DATE that was clicked, as it is
 * for cancelling. `scope: "event"` touches only that date; `scope: "series"`
 * updates the repeat rule and every date from the clicked one onward, leaving
 * earlier ones as they actually happened. Keying off the clicked date (rather
 * than the series) is what makes "this and all future dates" mean what it says:
 * dates between now and the clicked one are not rewritten.
 */
export async function updateCalendarEntryRow(
  admin: CalendarClient,
  data: UpdateCalendarEntryInput,
) {
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
    const { data: changed, error } = await admin
      .from("calendar_events")
      .update({ ...patch, updated_at: now })
      .eq("id", id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!changed?.length) throw new CalendarEntryError("not_found", NO_SUCH_DATE);
    return { ok: true as const, id, updated: changed.length };
  }

  // Series scope: resolve the clicked date's series, then rewrite from that
  // date forward. Never earlier: a past date records what actually happened.
  const { data: ev, error: evErr } = await admin
    .from("calendar_events")
    .select("series_id, starts_at")
    .eq("id", id)
    .maybeSingle();
  if (evErr) throw new Error(evErr.message);
  if (!ev) throw new CalendarEntryError("not_found", NO_SUCH_DATE);
  if (!ev.series_id) throw new CalendarEntryError("not_repeating", NOT_REPEATING);
  const from = ev.starts_at > now ? ev.starts_at : now;

  const { error: sErr } = await admin
    .from("calendar_series")
    .update({ ...patch, updated_at: now })
    .eq("id", ev.series_id);
  if (sErr) throw new Error(sErr.message);
  const { data: changed, error: eErr } = await admin
    .from("calendar_events")
    .update({ ...patch, updated_at: now })
    .eq("series_id", ev.series_id)
    .gte("starts_at", from)
    .select("id");
  if (eErr) throw new Error(eErr.message);
  return { ok: true as const, id, updated: changed?.length ?? 0 };
}

/** Manager: edit an entry's details, for one date or this and every future one. */
export const updateCalendarEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateCalendarEntrySchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return updateCalendarEntryRow(await adminClient(), data);
  });

/**
 * Stop a repeating entry. Future dates are removed and the rule is deactivated;
 * past dates stay, because they happened.
 *
 * A date still to start that somebody is already checked in to stays too. The
 * check-in screen opens on the class that is on now or NEXT, so people are
 * checked in to the evening class before it starts, and their check-ins cascade
 * with the date with no credit given back (the reason `deleteEventRow` refuses).
 * Such a class is happening, so it keeps its place on the calendar.
 *
 * Safe to repeat: the rule is switched off first, and a second call on a repeat
 * already stopped clears any future dates a first call left behind without
 * moving the date it stopped on.
 */
export async function stopRepeatingSeries(admin: CalendarClient, data: StopRepeatingInput) {
  const now = new Date().toISOString();
  const { data: series, error: sReadErr } = await admin
    .from("calendar_series")
    .select("starts_on, is_active")
    .eq("id", data.series_id)
    .maybeSingle();
  if (sReadErr) throw new Error(sReadErr.message);
  if (!series) {
    throw new CalendarEntryError("not_found", "That repeating entry no longer exists.");
  }

  // Off first, so the horizon top-up stops adding dates before the ones it
  // added are cleared away.
  if (series.is_active) {
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
  }

  const { data: future, error: fErr } = await admin
    .from("calendar_events")
    .select("id")
    .eq("series_id", data.series_id)
    .gte("starts_at", now);
  if (fErr) throw new Error(fErr.message);
  const futureIds = (future ?? []).map((e) => e.id);
  const checkedIn = new Set<string>();
  const removable: string[] = [];
  // Chunked for the same reason as the RSVP tally above: `.in()` is a
  // query-string filter, and a year of weekly dates is a long one.
  const CHUNK = 100;
  for (let i = 0; i < futureIds.length; i += CHUNK) {
    const ids = futureIds.slice(i, i + CHUNK);
    const { data: rows, error: cErr } = await admin
      .from("session_checkins")
      .select("event_id")
      .in("event_id", ids);
    if (cErr) throw new Error(cErr.message);
    for (const r of rows ?? []) checkedIn.add(r.event_id);
    removable.push(...ids.filter((id) => !checkedIn.has(id)));
  }
  for (let i = 0; i < removable.length; i += CHUNK) {
    const { error: dErr } = await admin
      .from("calendar_events")
      .delete()
      .in("id", removable.slice(i, i + CHUNK));
    if (dErr) throw new Error(dErr.message);
  }
  return {
    ok: true as const,
    already_stopped: !series.is_active,
    removed: removable.length,
    kept_checked_in: [...checkedIn],
  };
}

/** Manager: stop a repeating entry. */
export const stopRepeating = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => stopRepeatingSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return stopRepeatingSeries(await adminClient(), data);
  });

/**
 * Cancel a date, or restore it. With `scope: "series"`, this date and every
 * later one of the same repeat. The row is always kept.
 */
export async function cancelEventRows(admin: CalendarClient, data: CancelEventInput) {
  const now = new Date().toISOString();
  const status = data.cancelled ? "cancelled" : "scheduled";

  if (data.scope === "event") {
    const { data: changed, error } = await admin
      .from("calendar_events")
      .update({ status, updated_at: now })
      .eq("id", data.id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!changed?.length) throw new CalendarEntryError("not_found", NO_SUCH_DATE);
    return { ok: true as const, id: data.id, cancelled: data.cancelled, updated: changed.length };
  }

  // Series scope: this date and every future one. `id` is the event that was
  // clicked, so resolve its series first.
  const { data: ev, error: evErr } = await admin
    .from("calendar_events")
    .select("series_id, starts_at")
    .eq("id", data.id)
    .maybeSingle();
  if (evErr) throw new Error(evErr.message);
  if (!ev) throw new CalendarEntryError("not_found", NO_SUCH_DATE);
  if (!ev.series_id) throw new CalendarEntryError("not_repeating", NOT_REPEATING);
  const { data: changed, error } = await admin
    .from("calendar_events")
    .update({ status, updated_at: now })
    .eq("series_id", ev.series_id)
    .gte("starts_at", ev.starts_at)
    .select("id");
  if (error) throw new Error(error.message);
  return {
    ok: true as const,
    id: data.id,
    cancelled: data.cancelled,
    updated: changed?.length ?? 0,
  };
}

export const cancelEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return cancelEventRows(await adminClient(), data);
  });

/**
 * Delete one date outright, for a mistake made before anybody turned up.
 *
 * Only a one-off. A date a repeat generated would only be put back by the next
 * horizon top-up, so the honest moves there are cancelling it or stopping the
 * repeat. The screen offers neither Delete on such a date; this is the rule
 * for a caller that is not the screen.
 */
export async function deleteEventRow(admin: CalendarClient, data: DeleteEventInput) {
  const { data: ev, error: evErr } = await admin
    .from("calendar_events")
    .select("id, series_id")
    .eq("id", data.id)
    .maybeSingle();
  if (evErr) throw new Error(evErr.message);
  if (!ev) throw new CalendarEntryError("not_found", NO_SUCH_DATE);
  if (ev.series_id) {
    throw new CalendarEntryError(
      "repeating_date",
      "That date is part of a weekly entry, so it cannot be deleted on its own. Cancel this date instead, or stop the entry repeating.",
      { series_id: ev.series_id },
    );
  }

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
    throw new CalendarEntryError(
      "checked_in",
      `${count} ${count === 1 ? "person has" : "people have"} been checked in to this class, so deleting it would take their sessions with it. Cancel it instead.`,
      { checked_in: count },
    );
  }

  const { error } = await admin.from("calendar_events").delete().eq("id", data.id);
  if (error) throw new Error(error.message);
  return { ok: true as const, id: data.id };
}

export const deleteEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    return deleteEventRow(await adminClient(), data);
  });
