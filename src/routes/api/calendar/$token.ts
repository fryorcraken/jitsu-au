// Per-person ICS calendar feed: GET /api/calendar/<token>
//
// The token rides in the URL path (calendar apps can't send an auth header). We
// hash it and look up a live calendar_feed_tokens row; the feed then carries that
// person's events — public always, plus members-only ones if they are a PAID
// member (or a manager). There is deliberately no public/anon feed, so a
// subscriber never silently misses a members-only event.
//
// All DB access uses the service-role client, lazy-imported (route files ship to
// the client bundle, so it must never be a top-level import).
import { createFileRoute } from "@tanstack/react-router";
import { hashToken } from "@/lib/manager-api-tokens";
import { buildCalendar, type IcsEvent } from "@/lib/ics";
import type { CalendarClient, CalendarEventRow } from "@/lib/calendar-types";

const FEED_WINDOW_PAST_DAYS = 30;
const FEED_WINDOW_FUTURE_DAYS = 180;

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function toIcsEvent(e: CalendarEventRow): IcsEvent {
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
    allDay: e.all_day,
    summary: e.invite_only ? `${e.title} (invite only)` : e.title,
    description: detail || undefined,
    location: e.location,
    cancelled: e.status === "cancelled",
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
        if (!raw) return textResponse("Calendar not found.", 404);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = supabaseAdmin as unknown as CalendarClient;

        const token_hash = await hashToken(raw);
        const { data: tokenRow } = await admin
          .from("calendar_feed_tokens")
          .select("id, user_id")
          .eq("token_hash", token_hash)
          .is("revoked_at", null)
          .maybeSingle();
        if (!tokenRow) return textResponse("Calendar not found.", 404);

        // Best-effort usage stamp — never blocks the feed.
        void admin
          .from("calendar_feed_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", tokenRow.id);

        // Members-only events ride along only for a paid member (or a manager).
        const [{ data: paid }, { data: isMgr }] = await Promise.all([
          admin.rpc("has_active_paid_membership", { _user_id: tokenRow.user_id }),
          admin.rpc("has_role", { _user_id: tokenRow.user_id, _role: "manager" }),
        ]);
        const seesMembersOnly = Boolean(paid) || Boolean(isMgr);

        let query = admin
          .from("calendar_events")
          .select(
            "id, series_id, kind, title, description, instructor_name, location, starts_at, ends_at, all_day, status, visibility, invite_only",
          )
          .gte("starts_at", dateFromNow(-FEED_WINDOW_PAST_DAYS))
          .lte("starts_at", dateFromNow(FEED_WINDOW_FUTURE_DAYS))
          .order("starts_at", { ascending: true })
          .limit(1000);
        if (!seesMembersOnly) query = query.eq("visibility", "public");

        const { data: events, error } = await query;
        if (error) return textResponse("Could not build calendar.", 500);

        const ics = buildCalendar({
          events: (events ?? []).map(toIcsEvent),
          calName: "UTS Jitsu",
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
