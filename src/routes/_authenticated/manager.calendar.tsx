import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { WEEKDAY_LABELS } from "@/lib/calendar";
import { calendarEventKinds } from "@/lib/validation";
import {
  cancelEvent,
  changeInstructor,
  createEvent,
  createSeries,
  deleteEvent,
  generateSessions,
  listEventRsvps,
  listManagerEvents,
  listSeries,
} from "@/lib/calendar.functions";
import type { CalendarSeriesRow } from "@/lib/calendar-types";

export const Route = createFileRoute("/_authenticated/manager/calendar")({
  head: () => ({
    meta: [{ title: "Calendar | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerCalendarPage,
});

type EventRow = {
  id: string;
  series_id: string | null;
  kind: string;
  title: string;
  instructor_name: string | null;
  location: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: string;
  visibility: string;
  invite_only: boolean;
  rsvps: { going: number; maybe: number; declined: number };
};

type RsvpRow = {
  user_id: string;
  name: string | null;
  email: string | null;
  response: string;
  updated_at: string;
};

const TZ = "Australia/Sydney";

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

const emptySeries = {
  title: "",
  instructor_name: "",
  location: "UTS Ultimo",
  weekday: 1,
  start_time: "18:00",
  duration_minutes: 90,
  starts_on: "",
  ends_on: "",
};

const emptyEvent = {
  title: "",
  kind: "grading" as (typeof calendarEventKinds)[number],
  instructor_name: "",
  location: "UTS Ultimo",
  starts_at: "",
  ends_at: "",
  visibility: "public" as "public" | "members",
  invite_only: false,
  description: "",
};

function ManagerCalendarPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  const fetchSeries = useServerFn(listSeries);
  const fetchEvents = useServerFn(listManagerEvents);
  const fetchRsvps = useServerFn(listEventRsvps);
  const addSeries = useServerFn(createSeries);
  const genSessions = useServerFn(generateSessions);
  const addEvent = useServerFn(createEvent);
  const setCancelled = useServerFn(cancelEvent);
  const setInstructor = useServerFn(changeInstructor);
  const removeEvent = useServerFn(deleteEvent);

  const [series, setSeries] = useState<CalendarSeriesRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [seriesForm, setSeriesForm] = useState({ ...emptySeries });
  const [openEnded, setOpenEnded] = useState(true);
  const [eventForm, setEventForm] = useState({ ...emptyEvent });
  // Which event's attendee list is expanded, and the rows for it.
  const [openRsvpEvent, setOpenRsvpEvent] = useState<string | null>(null);
  const [rsvpRows, setRsvpRows] = useState<RsvpRow[]>([]);
  const [rsvpLoading, setRsvpLoading] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const reload = useCallback(() => {
    return Promise.all([fetchSeries(), fetchEvents()])
      .then(([s, e]) => {
        setSeries(s as CalendarSeriesRow[]);
        setEvents(e as EventRow[]);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load the calendar");
        setLoading(false);
      });
  }, [fetchSeries, fetchEvents]);

  useEffect(() => {
    if (!isManager) return;
    reload();
  }, [isManager, reload]);

  async function submitSeries() {
    setBusy(true);
    try {
      const res = await addSeries({
        data: {
          title: seriesForm.title,
          instructor_name: seriesForm.instructor_name || undefined,
          location: seriesForm.location || undefined,
          weekday: Number(seriesForm.weekday),
          start_time: seriesForm.start_time,
          duration_minutes: Number(seriesForm.duration_minutes),
          starts_on: seriesForm.starts_on,
          // Open-ended series carry no end date at all.
          ends_on: openEnded ? null : seriesForm.ends_on || null,
        },
      });
      toast.success(`Session added. ${res.generated} date(s) put on the calendar.`);
      setSeriesForm({ ...emptySeries });
      setOpenEnded(true);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the session");
    } finally {
      setBusy(false);
    }
  }

  async function submitEvent() {
    setBusy(true);
    try {
      await addEvent({
        data: {
          title: eventForm.title,
          kind: eventForm.kind,
          instructor_name: eventForm.instructor_name || undefined,
          location: eventForm.location || undefined,
          starts_at: new Date(eventForm.starts_at).toISOString(),
          ends_at: new Date(eventForm.ends_at).toISOString(),
          visibility: eventForm.visibility,
          invite_only: eventForm.invite_only,
          description: eventForm.description || undefined,
        },
      });
      toast.success("Event added.");
      setEventForm({ ...emptyEvent });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the event");
    } finally {
      setBusy(false);
    }
  }

  async function generateFor(seriesId: string) {
    setBusy(true);
    try {
      const through = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
      const res = await genSessions({ data: { series_id: seriesId, through_date: through } });
      toast.success(`${res.generated} date(s) added.`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add more dates");
    } finally {
      setBusy(false);
    }
  }

  async function toggleCancel(ev: EventRow) {
    setBusy(true);
    try {
      await setCancelled({ data: { id: ev.id, cancelled: ev.status !== "cancelled" } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the event");
    } finally {
      setBusy(false);
    }
  }

  async function editInstructor(scope: "event" | "series", id: string, current: string | null) {
    const name = window.prompt("Instructor name (leave blank to clear):", current ?? "");
    if (name === null) return;
    setBusy(true);
    try {
      await setInstructor({ data: { scope, id, instructor_name: name } });
      toast.success(
        scope === "series"
          ? "Instructor changed for this session and its upcoming dates."
          : "Instructor changed for this date.",
      );
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the instructor");
    } finally {
      setBusy(false);
    }
  }

  async function remove(ev: EventRow) {
    if (!window.confirm(`Delete "${ev.title}"? Cancel it instead to keep the record.`)) return;
    setBusy(true);
    try {
      await removeEvent({ data: { id: ev.id } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the event");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRsvpList(eventId: string) {
    if (openRsvpEvent === eventId) {
      setOpenRsvpEvent(null);
      return;
    }
    setOpenRsvpEvent(eventId);
    setRsvpLoading(true);
    try {
      const rows = await fetchRsvps({ data: { event_id: eventId } });
      setRsvpRows(rows as RsvpRow[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load who's coming");
      setRsvpRows([]);
    } finally {
      setRsvpLoading(false);
    }
  }

  const inputCls =
    "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <section className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Set up regular sessions, add events, cancel or change the instructor, and see who's
            coming.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/calendar">View public calendar</Link>
        </Button>
      </div>

      {/* ---- Regular sessions ---- */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Regular sessions</h2>
        <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Title
            <Input
              value={seriesForm.title}
              onChange={(e) => setSeriesForm({ ...seriesForm, title: e.target.value })}
              placeholder="Beginner Gi"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Instructor
            <Input
              value={seriesForm.instructor_name}
              onChange={(e) => setSeriesForm({ ...seriesForm, instructor_name: e.target.value })}
              placeholder="Sensei"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Location
            <Input
              value={seriesForm.location}
              onChange={(e) => setSeriesForm({ ...seriesForm, location: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Day
            <select
              className={inputCls}
              value={seriesForm.weekday}
              onChange={(e) => setSeriesForm({ ...seriesForm, weekday: Number(e.target.value) })}
            >
              {WEEKDAY_LABELS.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Start time
            <Input
              type="time"
              value={seriesForm.start_time}
              onChange={(e) => setSeriesForm({ ...seriesForm, start_time: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Length (minutes)
            <Input
              type="number"
              value={seriesForm.duration_minutes}
              onChange={(e) =>
                setSeriesForm({ ...seriesForm, duration_minutes: Number(e.target.value) })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            First date
            <Input
              type="date"
              value={seriesForm.starts_on}
              onChange={(e) => setSeriesForm({ ...seriesForm, starts_on: e.target.value })}
            />
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium">
            Runs until
            <select
              className={inputCls}
              value={openEnded ? "open" : "fixed"}
              onChange={(e) => setOpenEnded(e.target.value === "open")}
            >
              <option value="open">No end date, keeps running</option>
              <option value="fixed">Ends on a set date</option>
            </select>
            {!openEnded && (
              <Input
                type="date"
                className="mt-1"
                value={seriesForm.ends_on}
                onChange={(e) => setSeriesForm({ ...seriesForm, ends_on: e.target.value })}
              />
            )}
          </div>
          <div className="flex items-end">
            <Button
              onClick={submitSeries}
              disabled={
                busy ||
                !seriesForm.title ||
                !seriesForm.starts_on ||
                (!openEnded && !seriesForm.ends_on)
              }
            >
              Add session
            </Button>
          </div>
        </div>

        {series.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Session</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Runs</th>
                  <th className="px-3 py-2">Instructor</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{s.title}</td>
                    <td className="px-3 py-2">
                      {WEEKDAY_LABELS[s.weekday]} {s.start_time} · {s.duration_minutes}m
                    </td>
                    <td className="px-3 py-2">
                      {s.starts_on} {s.ends_on ? `to ${s.ends_on}` : "onwards"}
                    </td>
                    <td className="px-3 py-2">{s.instructor_name ?? "Not set"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => generateFor(s.id)}
                          disabled={busy}
                        >
                          Add dates
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => editInstructor("series", s.id, s.instructor_name)}
                          disabled={busy}
                        >
                          Instructor
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- One-off event ---- */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Add an event</h2>
        <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Title
            <Input
              value={eventForm.title}
              onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
              placeholder="Grading"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Kind
            <select
              className={inputCls}
              value={eventForm.kind}
              onChange={(e) =>
                setEventForm({ ...eventForm, kind: e.target.value as typeof eventForm.kind })
              }
            >
              {calendarEventKinds.map((k) => (
                <option key={k} value={k} className="capitalize">
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Who can see it
            <select
              className={inputCls}
              value={eventForm.visibility}
              onChange={(e) =>
                setEventForm({
                  ...eventForm,
                  visibility: e.target.value as typeof eventForm.visibility,
                })
              }
            >
              <option value="public">Everyone</option>
              <option value="members">Paid members only</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Starts
            <Input
              type="datetime-local"
              value={eventForm.starts_at}
              onChange={(e) => setEventForm({ ...eventForm, starts_at: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Ends
            <Input
              type="datetime-local"
              value={eventForm.ends_at}
              onChange={(e) => setEventForm({ ...eventForm, ends_at: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Instructor
            <Input
              value={eventForm.instructor_name}
              onChange={(e) => setEventForm({ ...eventForm, instructor_name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
            Description
            <Input
              value={eventForm.description}
              onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 self-end text-xs font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={eventForm.invite_only}
              onChange={(e) => setEventForm({ ...eventForm, invite_only: e.target.checked })}
            />
            Show an &quot;invite only&quot; badge
          </label>
          <div className="flex items-end">
            <Button
              onClick={submitEvent}
              disabled={busy || !eventForm.title || !eventForm.starts_at || !eventForm.ends_at}
            >
              Add event
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          &quot;Invite only&quot; is only a label. It does not hide the event or stop anyone
          replying. Use &quot;Paid members only&quot; to actually restrict who can see it.
        </p>
      </div>

      {/* ---- Upcoming events ---- */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">What's coming up</h2>
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing on the calendar yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Instructor</th>
                  <th className="px-3 py-2">Seen by</th>
                  <th className="px-3 py-2">Coming</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => {
                  const cancelled = ev.status === "cancelled";
                  const expanded = openRsvpEvent === ev.id;
                  return (
                    <>
                      <tr key={ev.id} className={cn("border-t", cancelled && "opacity-60")}>
                        <td className="px-3 py-2 font-medium">
                          <span className={cn(cancelled && "line-through")}>{ev.title}</span>
                          {ev.kind !== "session" && (
                            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs capitalize text-primary">
                              {ev.kind}
                            </span>
                          )}
                          {ev.invite_only && (
                            <span className="ml-2 rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary">
                              Invite only
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">{fmt(ev.starts_at)}</td>
                        <td className="px-3 py-2">{ev.instructor_name ?? "Not set"}</td>
                        <td className="px-3 py-2">
                          {ev.visibility === "members" ? "Paid members" : "Everyone"}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="underline underline-offset-2"
                            onClick={() => toggleRsvpList(ev.id)}
                          >
                            {ev.rsvps.going} going
                            {ev.rsvps.maybe > 0 ? `, ${ev.rsvps.maybe} maybe` : ""}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => editInstructor("event", ev.id, ev.instructor_name)}
                              disabled={busy}
                            >
                              Instructor
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => toggleCancel(ev)}
                              disabled={busy}
                            >
                              {cancelled ? "Restore" : "Cancel"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => remove(ev)}
                              disabled={busy}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${ev.id}-rsvps`} className="border-t bg-muted/30">
                          <td colSpan={6} className="px-3 py-3">
                            {rsvpLoading ? (
                              <p className="text-xs text-muted-foreground">Loading...</p>
                            ) : rsvpRows.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                Nobody has replied yet.
                              </p>
                            ) : (
                              <ul className="space-y-1 text-xs">
                                {rsvpRows.map((r) => (
                                  <li key={r.user_id} className="flex flex-wrap gap-2">
                                    <span className="font-medium">
                                      {r.name || r.email || "Someone"}
                                    </span>
                                    {r.name && r.email && (
                                      <span className="text-muted-foreground">{r.email}</span>
                                    )}
                                    <span className="capitalize text-muted-foreground">
                                      {r.response === "declined" ? "can't make it" : r.response}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
