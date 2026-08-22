import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LoadingPanel } from "@/components/site/LoadingPanel";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAuth, useRoles } from "@/hooks/useAuth";
import {
  CLUB_TIME_ZONE,
  DEFAULT_EVENT_LOCATION,
  WEEKDAY_LABELS,
  defaultEndForStart,
  zonedWallTimeToUtc,
} from "@/lib/calendar";
import {
  cancelEvent,
  createCalendarEntry,
  deleteEvent,
  listEventRsvps,
  listManagerEvents,
  stopRepeating,
  updateCalendarEntry,
} from "@/lib/calendar.functions";

export const Route = createFileRoute("/_authenticated/manager/calendar")({
  head: () => ({
    meta: [{ title: "Calendar | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerCalendarPage,
});

/** One date on the calendar. A repeating entry contributes one of these per week. */
type EventRow = {
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
  rsvps: { going: number; maybe: number; declined: number };
};

type RsvpRow = {
  user_id: string;
  name: string | null;
  email: string | null;
  response: string;
  updated_at: string;
};

/** "This date only" or "this date and every future one" (repeating entries only). */
type Scope = "event" | "series";

const TZ = CLUB_TIME_ZONE;

/**
 * Read a `datetime-local` value ("YYYY-MM-DDTHH:MM") as CLUB wall-clock time.
 * `new Date(value)` would parse it in the browser's zone, so a manager working
 * from a laptop set to UTC would save 18:00 and see it listed back as 5:00 am.
 * The list and the public page both render in club time.
 */
function clubLocalToIso(value: string): string {
  const [date, time] = value.split("T");
  return zonedWallTimeToUtc(date, time.slice(0, 5), TZ).toISOString();
}

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

/**
 * One form for everything on the calendar. Repeating is a property of the entry,
 * not a separate kind of thing, so the schedule fields swap in place rather than
 * living in a second form.
 */
const emptyEntry = {
  title: "",
  repeats: "never" as "never" | "weekly",
  // Only when it does not repeat.
  starts_at: "",
  ends_at: "",
  // Only when it repeats weekly.
  weekday: 1,
  start_time: "18:00",
  duration_minutes: 90,
  starts_on: "",
  ends_on: "",
  openEnded: true,
  // Shared, all optional except the title.
  instructor_name: "",
  location: DEFAULT_EVENT_LOCATION,
  description: "",
  visibility: "public" as "public" | "members",
  invite_only: false,
};

const inputCls =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ManagerCalendarPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  const fetchEvents = useServerFn(listManagerEvents);
  const fetchRsvps = useServerFn(listEventRsvps);
  const addEntry = useServerFn(createCalendarEntry);
  const saveEntry = useServerFn(updateCalendarEntry);
  const endRepeat = useServerFn(stopRepeating);
  const setCancelled = useServerFn(cancelEvent);
  const removeEvent = useServerFn(deleteEvent);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...emptyEntry });
  // Whether "Ends" holds the manager's own answer rather than the one derived
  // from "Starts". Kept out of `form` because it describes the editing session,
  // not the entry being created.
  const [endEdited, setEndEdited] = useState(false);

  // Which event is open for editing, and the draft for it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editScope, setEditScope] = useState<Scope>("event");
  const [editForm, setEditForm] = useState({
    title: "",
    instructor_name: "",
    location: "",
    description: "",
    visibility: "public" as "public" | "members",
    invite_only: false,
  });

  // Cancelling a repeating date asks the same this-date/all-future question.
  const [scopeAsk, setScopeAsk] = useState<{ id: string; cancelled: boolean } | null>(null);

  // Which event's attendee list is expanded, and the rows for it.
  const [openRsvpEvent, setOpenRsvpEvent] = useState<string | null>(null);
  const [rsvpRows, setRsvpRows] = useState<RsvpRow[]>([]);
  const [rsvpLoading, setRsvpLoading] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const reload = useCallback(() => {
    return fetchEvents()
      .then((e) => {
        setEvents(e as EventRow[]);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load the calendar");
        setLoading(false);
      });
  }, [fetchEvents]);

  useEffect(() => {
    if (!isManager) return;
    reload();
  }, [isManager, reload]);

  const canSubmit =
    Boolean(form.title.trim()) &&
    (form.repeats === "never"
      ? Boolean(form.starts_at && form.ends_at)
      : Boolean(form.starts_on) && (form.openEnded || Boolean(form.ends_on)));

  async function submit() {
    setBusy(true);
    try {
      const res = await addEntry({
        data: {
          title: form.title,
          instructor_name: form.instructor_name || undefined,
          location: form.location || undefined,
          description: form.description || undefined,
          visibility: form.visibility,
          invite_only: form.invite_only,
          repeat:
            form.repeats === "never"
              ? {
                  type: "never" as const,
                  starts_at: clubLocalToIso(form.starts_at),
                  ends_at: clubLocalToIso(form.ends_at),
                }
              : {
                  type: "weekly" as const,
                  weekday: Number(form.weekday),
                  start_time: form.start_time,
                  duration_minutes: Number(form.duration_minutes),
                  starts_on: form.starts_on,
                  // An open-ended entry carries no end date at all.
                  ends_on: form.openEnded ? null : form.ends_on || null,
                },
        },
      });
      toast.success(
        res.repeats
          ? `Added. ${res.generated} date(s) are on the calendar, and more appear as they get close.`
          : "Added to the calendar.",
      );
      setForm({ ...emptyEntry });
      setEndEdited(false);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add it to the calendar");
    } finally {
      setBusy(false);
    }
  }

  function startEditing(ev: EventRow) {
    if (editingId === ev.id) {
      setEditingId(null);
      return;
    }
    setEditingId(ev.id);
    // A one-off entry has no other dates to choose between.
    setEditScope("event");
    setEditForm({
      title: ev.title,
      instructor_name: ev.instructor_name ?? "",
      location: ev.location ?? "",
      description: ev.description ?? "",
      visibility: ev.visibility === "members" ? "members" : "public",
      invite_only: ev.invite_only,
    });
  }

  async function saveEdit(ev: EventRow) {
    const scope: Scope = ev.series_id ? editScope : "event";
    setBusy(true);
    try {
      await saveEntry({
        data: {
          scope,
          // Always the date that was clicked, in both scopes: the server resolves
          // the series from it, so "all future dates" means from HERE forward.
          id: ev.id,
          title: editForm.title,
          instructor_name: editForm.instructor_name,
          location: editForm.location,
          description: editForm.description,
          visibility: editForm.visibility,
          invite_only: editForm.invite_only,
        },
      });
      toast.success(
        scope === "series" ? "Saved for this date and all future ones." : "Saved for this date.",
      );
      setEditingId(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the changes");
    } finally {
      setBusy(false);
    }
  }

  function askCancel(ev: EventRow) {
    const cancelled = ev.status !== "cancelled";
    // Nothing to choose between when it happens once.
    if (!ev.series_id) {
      applyCancel(ev.id, cancelled, "event");
      return;
    }
    setScopeAsk({ id: ev.id, cancelled });
  }

  async function applyCancel(id: string, cancelled: boolean, scope: Scope) {
    setScopeAsk(null);
    setBusy(true);
    try {
      await setCancelled({ data: { scope, id, cancelled } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the entry");
    } finally {
      setBusy(false);
    }
  }

  async function stopRepeats(ev: EventRow) {
    if (!ev.series_id) return;
    if (
      !window.confirm(
        `Stop "${ev.title}" repeating? Future dates are removed. Past ones stay on the record.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await endRepeat({ data: { series_id: ev.series_id } });
      toast.success("It stops repeating. Past dates are untouched.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not stop it repeating");
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
      toast.error(e instanceof Error ? e.message : "Could not delete the entry");
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
    setRsvpRows([]);
    setRsvpLoading(true);
    try {
      const rows = await fetchRsvps({ data: { event_id: eventId } });
      // Expanding another event before this resolves would otherwise render one
      // event's attendees under another's row.
      setOpenRsvpEvent((current) => {
        if (current === eventId) setRsvpRows(rows as RsvpRow[]);
        return current;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load who's coming");
      setRsvpRows([]);
    } finally {
      setRsvpLoading(false);
    }
  }

  return (
    <section className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Add anything to the calendar, one-off or weekly, then edit, cancel and see who's coming.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/calendar">View public calendar</Link>
        </Button>
      </div>

      {/* ---- Add anything ---- */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Add to the calendar</h2>
        <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Title
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Beginner Gi, Grading, End of semester social"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            Repeats
            <select
              className={inputCls}
              value={form.repeats}
              onChange={(e) => setForm({ ...form, repeats: e.target.value as "never" | "weekly" })}
            >
              <option value="never">Doesn't repeat</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            Who can see it
            <select
              className={inputCls}
              value={form.visibility}
              onChange={(e) =>
                setForm({ ...form, visibility: e.target.value as "public" | "members" })
              }
            >
              <option value="public">Everyone</option>
              <option value="members">Paid members only</option>
            </select>
          </label>

          {form.repeats === "never" ? (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Starts
                <Input
                  type="datetime-local"
                  value={form.starts_at}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      starts_at: e.target.value,
                      // Picking a start fills in an end an hour later, so the
                      // common case needs one date picker, not two.
                      ends_at: defaultEndForStart(e.target.value, prev.ends_at, endEdited),
                    }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Ends
                <Input
                  type="datetime-local"
                  value={form.ends_at}
                  onChange={(e) => {
                    setEndEdited(true);
                    setForm((prev) => ({ ...prev, ends_at: e.target.value }));
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Day
                <select
                  className={inputCls}
                  value={form.weekday}
                  onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
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
                  value={form.start_time}
                  onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Length (minutes)
                <Input
                  type="number"
                  value={form.duration_minutes}
                  onChange={(e) => setForm({ ...form, duration_minutes: Number(e.target.value) })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                First date
                <Input
                  type="date"
                  value={form.starts_on}
                  onChange={(e) => setForm({ ...form, starts_on: e.target.value })}
                />
              </label>
              <div className="flex flex-col gap-1 text-xs font-medium">
                Runs until
                <select
                  className={inputCls}
                  value={form.openEnded ? "open" : "fixed"}
                  onChange={(e) => setForm({ ...form, openEnded: e.target.value === "open" })}
                >
                  <option value="open">No end date, keeps running</option>
                  <option value="fixed">Ends on a set date</option>
                </select>
                {!form.openEnded && (
                  <Input
                    type="date"
                    className="mt-1"
                    value={form.ends_on}
                    onChange={(e) => setForm({ ...form, ends_on: e.target.value })}
                  />
                )}
              </div>
            </>
          )}

          <label className="flex flex-col gap-1 text-xs font-medium">
            Instructor (optional)
            <Input
              value={form.instructor_name}
              onChange={(e) => setForm({ ...form, instructor_name: e.target.value })}
              placeholder="Sensei"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Location (optional)
            <Input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
            Description (optional)
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>

          <label className="flex items-center gap-2 self-end text-xs font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={form.invite_only}
              onChange={(e) => setForm({ ...form, invite_only: e.target.checked })}
            />
            Show an &quot;invite only&quot; badge
          </label>
          <div className="flex items-end">
            <Button onClick={submit} disabled={busy || !canSubmit}>
              Add to calendar
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          &quot;Invite only&quot; is only a label. It does not hide the entry or stop anyone
          replying. Use &quot;Paid members only&quot; to actually restrict who can see it. A weekly
          entry keeps future dates appearing on its own, so there is nothing to press.
        </p>
      </div>

      {/* ---- Everything coming up ---- */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">What's coming up</h2>
        {loading ? (
          <LoadingPanel className="p-0" />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing on the calendar yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Entry</th>
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
                  const repeats = Boolean(ev.series_id);
                  const expanded = openRsvpEvent === ev.id;
                  const editing = editingId === ev.id;
                  const asking = scopeAsk?.id === ev.id;
                  return (
                    // Key belongs on the array element (the Fragment), not its
                    // children, otherwise the list reconciles by index.
                    <Fragment key={ev.id}>
                      <tr className={cn("border-t", cancelled && "opacity-60")}>
                        <td className="px-3 py-2 font-medium">
                          <span className={cn(cancelled && "line-through")}>{ev.title}</span>
                          {repeats && (
                            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              Weekly
                            </span>
                          )}
                          {ev.invite_only && (
                            <span className="ml-2 rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary">
                              Invite only
                            </span>
                          )}
                          {cancelled && (
                            <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                              Cancelled
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
                              onClick={() => startEditing(ev)}
                              disabled={busy}
                            >
                              {editing ? "Close" : "Edit"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => askCancel(ev)}
                              disabled={busy}
                            >
                              {cancelled ? "Restore" : "Cancel"}
                            </Button>
                            {/* Deleting one date of a repeat would just be
                                regenerated at the next top-up, so a repeat gets
                                "Stop repeating" instead. */}
                            {repeats ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => stopRepeats(ev)}
                                disabled={busy}
                              >
                                Stop repeating
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => remove(ev)}
                                disabled={busy}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {asking && (
                        <tr className="border-t bg-muted/30">
                          <td colSpan={6} className="px-3 py-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-medium">
                                {scopeAsk.cancelled ? "Cancel" : "Restore"} which dates?
                              </span>
                              <Button
                                size="sm"
                                onClick={() => applyCancel(ev.id, scopeAsk.cancelled, "event")}
                                disabled={busy}
                              >
                                This date only
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => applyCancel(ev.id, scopeAsk.cancelled, "series")}
                                disabled={busy}
                              >
                                This and all future dates
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setScopeAsk(null)}>
                                Never mind
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}

                      {editing && (
                        <tr className="border-t bg-muted/30">
                          <td colSpan={6} className="px-3 py-3">
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                              {repeats && (
                                <label className="flex flex-col gap-1 text-xs font-medium lg:col-span-3">
                                  Apply the changes to
                                  <select
                                    className={inputCls}
                                    value={editScope}
                                    onChange={(e) => setEditScope(e.target.value as Scope)}
                                  >
                                    <option value="event">This date only</option>
                                    <option value="series">This and all future dates</option>
                                  </select>
                                </label>
                              )}
                              <label className="flex flex-col gap-1 text-xs font-medium">
                                Title
                                <Input
                                  value={editForm.title}
                                  onChange={(e) =>
                                    setEditForm({ ...editForm, title: e.target.value })
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium">
                                Instructor
                                <Input
                                  value={editForm.instructor_name}
                                  onChange={(e) =>
                                    setEditForm({ ...editForm, instructor_name: e.target.value })
                                  }
                                  placeholder="Leave blank to clear"
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium">
                                Location
                                <Input
                                  value={editForm.location}
                                  onChange={(e) =>
                                    setEditForm({ ...editForm, location: e.target.value })
                                  }
                                  placeholder="Leave blank to clear"
                                />
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium">
                                Who can see it
                                <select
                                  className={inputCls}
                                  value={editForm.visibility}
                                  onChange={(e) =>
                                    setEditForm({
                                      ...editForm,
                                      visibility: e.target.value as "public" | "members",
                                    })
                                  }
                                >
                                  <option value="public">Everyone</option>
                                  <option value="members">Paid members only</option>
                                </select>
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-medium sm:col-span-2">
                                Description
                                <Input
                                  value={editForm.description}
                                  onChange={(e) =>
                                    setEditForm({ ...editForm, description: e.target.value })
                                  }
                                />
                              </label>
                              <label className="flex items-center gap-2 self-end text-xs font-medium">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-input"
                                  checked={editForm.invite_only}
                                  onChange={(e) =>
                                    setEditForm({ ...editForm, invite_only: e.target.checked })
                                  }
                                />
                                Show an &quot;invite only&quot; badge
                              </label>
                              <div className="flex flex-wrap items-end gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => saveEdit(ev)}
                                  disabled={busy || !editForm.title.trim()}
                                >
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setEditingId(null)}
                                  disabled={busy}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              The day and time of a weekly entry are not editable here. Dates
                              already on the calendar would become wrong. Stop it repeating and add
                              it again at the new time.
                            </p>
                          </td>
                        </tr>
                      )}

                      {expanded && (
                        <tr className="border-t bg-muted/30">
                          <td colSpan={6} className="px-3 py-3">
                            {rsvpLoading ? (
                              <p
                                role="status"
                                aria-live="polite"
                                className="text-xs text-muted-foreground"
                              >
                                Loading
                              </p>
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
                    </Fragment>
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
