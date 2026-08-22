import { createFileRoute, Link } from "@tanstack/react-router";
import { LoadingPanel } from "@/components/site/LoadingPanel";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarPlus, Clock, MapPin, User } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getCalendar, getMyCalendarFeedUrl, getMyRsvps, setRsvp } from "@/lib/calendar.functions";
import type { RsvpResponse } from "@/lib/validation";
import { buildPageMeta } from "@/lib/seo";

export const Route = createFileRoute("/calendar")({
  head: () => ({
    meta: buildPageMeta({
      title: "Calendar | UTS Jitsu",
      description:
        "Upcoming UTS Jitsu training sessions and club events. Sign in to RSVP and add the calendar to your phone.",
      ogDescription: "Upcoming UTS Jitsu training sessions and club events.",
      path: "/calendar",
    }),
    links: [{ rel: "canonical", href: "https://jitsu.au/calendar" }],
  }),
  component: CalendarPage,
});

type CalendarEvent = {
  id: string;
  series_id: string | null;
  title: string;
  description: string | null;
  instructor_name: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  visibility: string;
  invite_only: boolean;
};

const TZ = "Australia/Sydney";

function dayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: TZ,
  });
}

function timeRange(ev: CalendarEvent): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZone: TZ };
  const start = new Date(ev.starts_at).toLocaleTimeString("en-AU", opts);
  const end = new Date(ev.ends_at).toLocaleTimeString("en-AU", opts);
  return `${start} to ${end}`;
}

const RSVP_OPTIONS: { value: RsvpResponse; label: string }[] = [
  { value: "going", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "declined", label: "Can't make it" },
];

function CalendarPage() {
  const loadCalendar = useServerFn(getCalendar);
  const loadRsvps = useServerFn(getMyRsvps);
  const saveRsvp = useServerFn(setRsvp);
  const loadFeedUrl = useServerFn(getMyCalendarFeedUrl);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [seesMembersOnly, setSeesMembersOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rsvps, setRsvps] = useState<Record<string, RsvpResponse | undefined>>({});
  const [savingRsvp, setSavingRsvp] = useState<Set<string>>(new Set());
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [feedFailed, setFeedFailed] = useState(false);

  const refreshRsvps = useCallback(() => {
    loadRsvps()
      .then((rows) => {
        const map: Record<string, RsvpResponse> = {};
        for (const r of rows) map[r.event_id] = r.response as RsvpResponse;
        setRsvps(map);
      })
      .catch(() => {});
  }, [loadRsvps]);

  useEffect(() => {
    loadCalendar()
      .then((data) => {
        setEvents(data.events as CalendarEvent[]);
        setSignedIn(data.signed_in);
        setSeesMembersOnly(data.sees_members_only);
        setLoading(false);
        if (data.signed_in) {
          refreshRsvps();
          // The link is minted on first ask and shown on every visit after that,
          // so there is nothing for the member to press to get one.
          loadFeedUrl()
            .then(({ url }) => setFeedUrl(url))
            .catch(() => setFeedFailed(true));
        }
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Could not load the calendar");
        setLoading(false);
      });
  }, [loadCalendar, loadFeedUrl, refreshRsvps]);

  async function respond(eventId: string, response: RsvpResponse) {
    // Per-event, so replying to one event doesn't re-enable another's buttons.
    setSavingRsvp((s) => new Set(s).add(eventId));
    // Optimistic update; revert on error.
    const prev = rsvps[eventId];
    setRsvps((m) => ({ ...m, [eventId]: response }));
    try {
      await saveRsvp({ data: { event_id: eventId, response } });
    } catch (e) {
      setRsvps((m) => ({ ...m, [eventId]: prev }));
      toast.error(e instanceof Error ? e.message : "Could not save your RSVP");
    } finally {
      setSavingRsvp((s) => {
        const next = new Set(s);
        next.delete(eventId);
        return next;
      });
    }
  }

  async function copyFeedUrl() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      toast.success("Calendar link copied.");
    } catch {
      // Clipboard access can be blocked (older browsers, no secure context).
      // The link is on screen either way, so this is only a convenience.
      toast.error("Could not copy it. Select the link and copy it by hand.");
    }
  }

  // Group events by their Sydney-local day for a simple agenda layout.
  const groups: { heading: string; items: CalendarEvent[] }[] = [];
  for (const ev of events) {
    const heading = dayHeading(ev.starts_at);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.items.push(ev);
    else groups.push({ heading, items: [ev] });
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Calendar</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">What's on.</h1>
        <p className="mt-5 text-lg text-muted-foreground">
          Training sessions and club events. Sign in to let us know you're coming and to add the
          calendar to your phone or laptop.
        </p>

        <div className="mt-8 rounded-lg border bg-muted/30 p-4">
          {signedIn ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <CalendarPlus className="h-4 w-4 text-primary" />
                Add this calendar to your own
              </div>
              <p className="text-sm text-muted-foreground">
                Add this private link to your calendar app. New sessions, events and cancellations
                then stay in sync on their own.
                {seesMembersOnly
                  ? " Your link includes members-only events."
                  : " Members-only events are included once you have a paid membership."}
              </p>
              {feedUrl ? (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-3 py-2 text-xs">
                    {feedUrl}
                  </code>
                  <Button size="sm" variant="outline" onClick={copyFeedUrl}>
                    Copy
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {feedFailed
                    ? "We could not load your link just now. Refresh the page to try again."
                    : "Loading your link..."}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Link
                to="/auth"
                search={{ redirect: "/calendar" }}
                className="font-semibold text-primary underline"
              >
                Sign in
              </Link>{" "}
              to tell us you're coming and to add this calendar to your phone. New here?{" "}
              <Link to="/register-interest" className="font-semibold text-primary underline">
                Start your free trial.
              </Link>
            </p>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-20">
        {loading ? (
          <LoadingPanel className="p-0" />
        ) : groups.length === 0 ? (
          <p className="text-muted-foreground">Nothing scheduled right now. Check back soon.</p>
        ) : (
          <div className="space-y-8">
            {groups.map((group) => (
              <div key={group.heading}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.heading}
                </h2>
                <div className="space-y-3">
                  {group.items.map((ev) => {
                    const cancelled = ev.status === "cancelled";
                    // Recently-finished events stay listed for context, but you
                    // can't say you're coming to something that already ran.
                    const past = new Date(ev.ends_at) < new Date();
                    return (
                      <div
                        key={ev.id}
                        className={cn("rounded-lg border p-4", (cancelled || past) && "opacity-60")}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className={cn("text-lg font-semibold", cancelled && "line-through")}>
                            {ev.title}
                          </h3>
                          {ev.visibility === "members" && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              Members only
                            </span>
                          )}
                          {ev.invite_only && (
                            <span className="rounded-full border border-primary/40 px-2 py-0.5 text-xs font-medium text-primary">
                              Invite only
                            </span>
                          )}
                          {cancelled && (
                            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                              Cancelled
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" /> {timeRange(ev)}
                          </span>
                          {/* Location is optional now: a social or a grading at a
                              venue not yet booked should show nothing rather than
                              a default the club never chose. */}
                          {ev.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5" /> {ev.location}
                            </span>
                          )}
                          {ev.instructor_name && (
                            <span className="flex items-center gap-1">
                              <User className="h-3.5 w-3.5" /> {ev.instructor_name}
                            </span>
                          )}
                        </div>
                        {ev.description && (
                          <p className="mt-2 text-sm text-muted-foreground">{ev.description}</p>
                        )}

                        {!cancelled && !past && (
                          <div className="mt-3 border-t pt-3">
                            {signedIn ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-medium text-muted-foreground">
                                  Coming along?
                                </span>
                                {RSVP_OPTIONS.map((opt) => (
                                  <Button
                                    key={opt.value}
                                    size="sm"
                                    variant={rsvps[ev.id] === opt.value ? "default" : "outline"}
                                    onClick={() => respond(ev.id, opt.value)}
                                    disabled={savingRsvp.has(ev.id)}
                                  >
                                    {opt.label}
                                  </Button>
                                ))}
                              </div>
                            ) : (
                              <Link
                                to="/auth"
                                search={{ redirect: "/calendar" }}
                                className="text-sm font-medium text-primary underline"
                              >
                                Sign in to RSVP
                              </Link>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </SiteLayout>
  );
}
