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
  changeInstructorSchema,
  createEventSchema,
  createSeriesSchema,
  deleteEventSchema,
  eventRsvpsSchema,
  generateSessionsSchema,
  nameWithPreferred,
  rsvpSchema,
  updateEventSchema,
  updateSeriesSchema,
} from "@/lib/validation";
import { CLUB_TIME_ZONE, diffOccurrences, generateOccurrences } from "@/lib/calendar";
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import type {
  CalendarClient,
  CalendarEventSelection,
  CalendarEventUpdate,
  CalendarSeriesRow,
  CalendarSeriesUpdate,
} from "@/lib/calendar-types";
import type { AppClient } from "@/lib/profile-types";

const SITE_URL = "https://jitsu.au";
/** Default horizon (days) materialized when a series is created. */
const DEFAULT_HORIZON_DAYS = 84;
/**
 * Hard ceiling on how far ahead dates can be generated in one go. Without it a
 * far-future `through_date` against an open-ended series would enumerate tens of
 * thousands of dates and attempt them in a single insert.
 */
const MAX_HORIZON_DAYS = 400;

const EVENT_COLUMNS =
  "id, series_id, kind, title, description, instructor_name, location, starts_at, ends_at, all_day, status, visibility, invite_only";

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
    kind: e.kind,
    title: e.title,
    description: e.description,
    instructor_name: e.instructor_name,
    location: e.location,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    all_day: e.all_day,
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

// ---- Member: personal ICS feed token ----
// Only the hash is stored, so the usable URL is shown once at creation.
export const getMyFeedToken = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    const { data, error } = await admin
      .from("calendar_feed_tokens")
      .select("token_prefix, created_at")
      .eq("user_id", context.userId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { token_prefix: data.token_prefix, created_at: data.created_at } : null;
  });

export const createMyFeedToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    // At most one live token per person: revoke any existing one first.
    await admin
      .from("calendar_feed_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", context.userId)
      .is("revoked_at", null);

    const raw = generateRawToken();
    const token_hash = await hashToken(raw);
    const token_prefix = tokenPreview(raw);
    const { error } = await admin
      .from("calendar_feed_tokens")
      .insert({ user_id: context.userId, token_hash, token_prefix });
    if (error) throw new Error(error.message);

    const origin = await requestOrigin();
    // The raw token is returned here and never again.
    return { url: `${origin}/api/calendar/${raw}`, token_prefix };
  });

export const revokeMyFeedToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    const { error } = await admin
      .from("calendar_feed_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", context.userId)
      .is("revoked_at", null);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ================= Manager =================

export const listSeries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { data, error } = await admin
      .from("calendar_series")
      .select("*")
      .order("weekday", { ascending: true })
      .order("start_time", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as CalendarSeriesRow[];
  });

export const listManagerEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
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
        pdb.rpc("user_emails", { _user_ids: userIds }),
      ]);
      // Surface these: silently falling back to "Someone" with no email would
      // look like missing data rather than a broken lookup.
      if (pErr) throw new Error(pErr.message);
      if (eErr) throw new Error(eErr.message);
      // Manager-facing list, so it shows the preferred name in the nickname
      // position (`Ada "Addy" Lovelace`), matching the other manager views.
      for (const p of profiles ?? []) nameByUser.set(p.user_id, nameWithPreferred(p));
      for (const e of (emails ?? []) as { user_id: string; email: string }[]) {
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

  const rows = diffOccurrences(existing ?? [], occ).map((o) => ({
    series_id: series.id,
    kind: "session",
    title: series.title,
    description: series.description,
    instructor_name: series.instructor_name,
    location: series.location,
    starts_at: o.starts_at,
    ends_at: o.ends_at,
    visibility: "public",
  }));
  if (rows.length === 0) return 0;
  const { error: insErr } = await admin.from("calendar_events").insert(rows);
  if (insErr) throw new Error(insErr.message);
  return rows.length;
}

export const createSeries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSeriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { data: created, error } = await admin
      .from("calendar_series")
      .insert({
        title: data.title,
        description: data.description ?? null,
        instructor_name: data.instructor_name ?? null,
        location: data.location || "UTS Ultimo",
        weekday: data.weekday,
        start_time: data.start_time,
        duration_minutes: data.duration_minutes,
        starts_on: data.starts_on,
        ends_on: data.ends_on ?? null,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error || !created) throw new Error(error?.message || "Could not create series.");

    // Materialize an initial horizon so the schedule is immediately populated.
    // An open-ended series gets the default horizon; a fixed-end one stops at
    // its own end date (generateOccurrences clamps to it).
    const generated = await materializeSeries(
      admin,
      created as CalendarSeriesRow,
      data.starts_on > dateFromNow(0) ? data.starts_on : dateFromNow(0),
      dateFromNow(DEFAULT_HORIZON_DAYS),
    );
    return { ok: true as const, id: created.id, generated };
  });

export const updateSeries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateSeriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { id, ...fields } = data;
    const patch: CalendarSeriesUpdate = { ...fields, updated_at: new Date().toISOString() };
    const { error } = await admin.from("calendar_series").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true as const, id };
  });

export const generateSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => generateSessionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { data: series, error } = await admin
      .from("calendar_series")
      .select("*")
      .eq("id", data.series_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!series) throw new Error("Series not found.");
    const row = series as CalendarSeriesRow;
    if (!row.is_active) throw new Error("That session is inactive. Reactivate it to add dates.");
    // Clamp the requested horizon so one call can't enumerate years of dates.
    const ceiling = dateFromNow(MAX_HORIZON_DAYS);
    const through = data.through_date > ceiling ? ceiling : data.through_date;
    const generated = await materializeSeries(
      admin,
      row,
      row.starts_on > dateFromNow(0) ? row.starts_on : dateFromNow(0),
      through,
    );
    return { ok: true as const, generated };
  });

export const createEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { data: created, error } = await admin
      .from("calendar_events")
      .insert({
        kind: data.kind,
        title: data.title,
        description: data.description ?? null,
        instructor_name: data.instructor_name ?? null,
        location: data.location || "UTS Ultimo",
        starts_at: data.starts_at,
        ends_at: data.ends_at,
        all_day: data.all_day,
        visibility: data.visibility,
        invite_only: data.invite_only,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(error?.message || "Could not create event.");
    return { ok: true as const, id: created.id };
  });

export const updateEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { id, ...fields } = data;
    const patch: CalendarEventUpdate = { ...fields, updated_at: new Date().toISOString() };
    const { error } = await admin.from("calendar_events").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true as const, id };
  });

export const cancelEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { error } = await admin
      .from("calendar_events")
      .update({
        status: data.cancelled ? "cancelled" : "scheduled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, id: data.id, cancelled: data.cancelled };
  });

export const changeInstructor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => changeInstructorSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const name = data.instructor_name.trim() ? data.instructor_name.trim() : null;
    const now = new Date().toISOString();
    if (data.scope === "event") {
      const { error } = await admin
        .from("calendar_events")
        .update({ instructor_name: name, updated_at: now })
        .eq("id", data.id);
      if (error) throw new Error(error.message);
    } else {
      // Series: update the series (so future generation uses it) and its
      // upcoming events. Past occurrences keep whoever actually taught them.
      const { error: sErr } = await admin
        .from("calendar_series")
        .update({ instructor_name: name, updated_at: now })
        .eq("id", data.id);
      if (sErr) throw new Error(sErr.message);
      const { error: eErr } = await admin
        .from("calendar_events")
        .update({ instructor_name: name, updated_at: now })
        .eq("series_id", data.id)
        .gte("starts_at", now);
      if (eErr) throw new Error(eErr.message);
    }
    return { ok: true as const };
  });

export const deleteEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CalendarClient; userId: string });
    const admin = await adminClient();
    const { error } = await admin.from("calendar_events").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, id: data.id };
  });
