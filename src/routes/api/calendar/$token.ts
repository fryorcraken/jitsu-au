// Per-person ICS calendar feed: GET /api/calendar/<token>
//
// The token rides in the URL path (calendar apps can't send an auth header). We
// hash it and look up the calendar_feed_tokens row; the feed then carries that
// person's events — public always, plus members-only ones if they are a PAID
// member (or a manager). There is deliberately no public/anon feed, so a
// subscriber never silently misses a members-only event.
//
// A row whose owner has REPLACED their link is looked up too, rather than
// filtered out, so the old address can say what happened instead of reading as
// a typo. feedTokenVerdict owns that call.
//
// All DB access uses the service-role client, lazy-imported (route files ship to
// the client bundle, so it must never be a top-level import).
import { createFileRoute } from "@tanstack/react-router";
import { hashToken } from "@/lib/manager-api-tokens";
import { feedTokenVerdict, UNKNOWN_LINK_MESSAGE } from "@/lib/calendar-feed-token";
import { buildCalendar, type IcsEvent } from "@/lib/ics";
import { CLUB_TIME_ZONE } from "@/lib/calendar";
import type { CalendarClient, CalendarFeedSelection } from "@/lib/calendar-types";

const FEED_WINDOW_PAST_DAYS = 30;
const FEED_WINDOW_FUTURE_DAYS = 180;

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function toIcsEvent(e: CalendarFeedSelection): IcsEvent {
  const detail = [
    e.description ?? "",
    e.instructor_name ? `Instructor: ${e.instructor_name}` : "",
    e.invite_only ? "Invite only." : "",
    e.status === "cancelled" ? "This session has been cancelled." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    uid: `${e.id}@jitsu.au`,
    start: new Date(e.starts_at),
    end: new Date(e.ends_at),
    summary: e.invite_only ? `${e.title} (invite only)` : e.title,
    description: detail || undefined,
    location: e.location ?? undefined,
    cancelled: e.status === "cancelled",
    // Clients ignore a re-sent event whose SEQUENCE hasn't advanced, so derive
    // it from updated_at: any manager edit (time change, cancellation) bumps it
    // and subscribers pick the change up instead of keeping the stale copy.
    sequence: Math.floor(new Date(e.updated_at).getTime() / 1000),
  };
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export const Route = createFileRoute("/api/calendar/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const raw = params.token;
        if (!raw) return textResponse(UNKNOWN_LINK_MESSAGE, 404);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as CalendarClient;

        const token_hash = await hashToken(raw);
        // No `.is("revoked_at", null)` filter: token_hash is unique across the
        // whole table, so this still matches at most one row, and a replaced
        // one has to come back so the verdict can tell the two cases apart.
        const { data: lookup, error: lookupError } = await admin
          .from("calendar_feed_tokens")
          .select("id, user_id, revoked_at")
          .eq("token_hash", token_hash)
          .maybeSingle();
        // Surfaced rather than folded into `lookup === null`. This route's whole
        // job is telling a live link, a replaced one and a made-up one apart, and
        // a database blip answering "no such calendar" to a subscriber holding a
        // perfectly good token is the one wrong answer of the three.
        if (lookupError) return textResponse("Could not build calendar.", 500);
        const verdict = feedTokenVerdict(lookup);
        if (!verdict.serve) return textResponse(verdict.message, verdict.status);
        const tokenRow = verdict.row;

        // Best-effort usage stamp — never blocks the feed. A PostgrestBuilder is
        // a lazy thenable: `void builder` would never issue the request, so the
        // .then() is what actually sends it (and swallows any failure).
        admin
          .from("calendar_feed_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", tokenRow.id)
          .then(
            () => {},
            () => {},
          );

        // Members-only events ride along only for a paid member (or a manager).
        const [{ data: paid }, { data: isMgr }] = await Promise.all([
          admin.rpc("has_active_paid_membership", { _user_id: tokenRow.user_id }),
          admin.rpc("has_role", { _user_id: tokenRow.user_id, _role: "manager" }),
        ]);
        const seesMembersOnly = Boolean(paid) || Boolean(isMgr);

        let query = admin
          .from("calendar_events")
          .select(
            "id, series_id, title, description, instructor_name, location, starts_at, ends_at, status, visibility, invite_only, updated_at",
          )
          .gte("starts_at", dateFromNow(-FEED_WINDOW_PAST_DAYS))
          .lte("starts_at", dateFromNow(FEED_WINDOW_FUTURE_DAYS))
          .order("starts_at", { ascending: true })
          .limit(1000);
        if (!seesMembersOnly) query = query.eq("visibility", "public");

        const { data: events, error } = await query;
        if (error) return textResponse("Could not build calendar.", 500);

        // Invite-only entries ride along only for someone actually invited (an
        // RSVP row for that date) or a manager. A series marked invite only
        // hides every date it generates, matching the read policies.
        let visible = events ?? [];
        if (!isMgr) {
          const [{ data: rsvps }, { data: inviteSeries }] = await Promise.all([
            admin.from("event_rsvps").select("event_id").eq("user_id", tokenRow.user_id),
            admin.from("calendar_series").select("id").eq("invite_only", true),
          ]);
          const invited = new Set((rsvps ?? []).map((r) => r.event_id));
          const inviteOnlySeries = new Set((inviteSeries ?? []).map((s) => s.id));
          visible = visible.filter(
            (e) =>
              (!e.invite_only && !(e.series_id && inviteOnlySeries.has(e.series_id))) ||
              invited.has(e.id),
          );
        }

        const ics = buildCalendar({
          events: visible.map(toIcsEvent),
          calName: "UTS Jitsu",
          // All-day events are the club's calendar days, not UTC's.
          timeZone: CLUB_TIME_ZONE,
        });
        return new Response(ics, {
          status: 200,
          headers: {
            "content-type": "text/calendar; charset=utf-8",
            "content-disposition": 'inline; filename="uts-jitsu.ics"',
            "cache-control": "private, max-age=300",
          },
        });
      },
    },
  },
});
