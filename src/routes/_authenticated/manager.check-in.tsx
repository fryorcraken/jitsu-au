import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/site/StatusPill";
import { coverageClass } from "@/lib/status-colours";
import { cn } from "@/lib/utils";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { CLUB_TIME_ZONE } from "@/lib/calendar";
import { coveragePreviewLabel, pickDefaultEvent } from "@/lib/checkin";
import {
  attachCheckInCoverage,
  checkInPerson,
  getCheckInBoard,
  listCheckInEvents,
  listUncoveredCheckIns,
  undoCheckIn,
} from "@/lib/checkin.functions";

export const Route = createFileRoute("/_authenticated/manager/check-in")({
  head: () => ({
    meta: [{ title: "Check in | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: CheckInPage,
});

type EventRow = Awaited<ReturnType<typeof listCheckInEvents>>[number];
type Board = Awaited<ReturnType<typeof getCheckInBoard>>;
type RosterRow = Board["roster"][number];
type UncoveredRow = Awaited<ReturnType<typeof listUncoveredCheckIns>>[number];

const TZ = CLUB_TIME_ZONE;

/** How many roster matches to show before asking the manager to keep typing. */
const MATCH_LIMIT = 25;

// Warnings are stored as stable codes so the wording can change without a
// migration. This is that wording.
const WARNING_TEXT: Record<string, string> = {
  no_cover: "nothing covers this class",
  last_credit: "that was their last session",
  membership_ended: "a membership has passed its end date",
  credits_exhausted: "a membership has no sessions left",
  payment_pending: "waiting on a payment",
  coverage_race: "another check-in took the session first",
  not_started: "a membership starts after this class",
};

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

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

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

// `no_cover` is dropped when something more specific explains it, since the row
// already carries a red "No cover" pill. When it is all we have, say it anyway:
// a bare dash under "No cover" is what makes an uncovered check-in impossible to
// diagnose from this screen.
function Warnings({ codes }: { codes: string[] }) {
  const explained = codes.filter((c) => c !== "no_cover");
  const shown = explained.length ? explained : codes;
  const text = shown.map((c) => WARNING_TEXT[c] ?? c).join("; ");
  if (!text) return <span className="text-muted-foreground">—</span>;
  return <span className="text-xs text-muted-foreground">{text}</span>;
}

function CheckInPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  const fetchEvents = useServerFn(listCheckInEvents);
  const fetchBoard = useServerFn(getCheckInBoard);
  const fetchUncovered = useServerFn(listUncoveredCheckIns);
  const checkIn = useServerFn(checkInPerson);
  const undo = useServerFn(undoCheckIn);
  const attach = useServerFn(attachCheckInCoverage);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventId, setEventId] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [uncovered, setUncovered] = useState<UncoveredRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [openAttach, setOpenAttach] = useState<string | null>(null);
  const [attachChoice, setAttachChoice] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  // The class list, and the one the screen opens on: today's, or the nearest.
  useEffect(() => {
    if (!isManager) return;
    fetchEvents()
      .then((rows) => {
        const list = rows as EventRow[];
        setEvents(list);
        setEventId((current) => current ?? pickDefaultEvent(list, new Date())?.id ?? null);
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Could not load the classes");
        setLoading(false);
      });
  }, [isManager, fetchEvents]);

  const reloadBoard = useCallback(() => {
    if (!eventId) return Promise.resolve();
    return fetchBoard({ data: { event_id: eventId } })
      .then((b) => setBoard(b as Board))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not load the roster"));
  }, [eventId, fetchBoard]);

  const reloadUncovered = useCallback(() => {
    return fetchUncovered()
      .then((rows) => setUncovered(rows as UncoveredRow[]))
      .catch(() => {
        /* the needs-attention list is secondary; never block the door on it */
      });
  }, [fetchUncovered]);

  useEffect(() => {
    if (!isManager) return;
    reloadBoard();
  }, [isManager, reloadBoard]);

  useEffect(() => {
    if (!isManager) return;
    reloadUncovered();
  }, [isManager, reloadUncovered]);

  const selectedEvent = events.find((e) => e.id === eventId) ?? null;
  const isCancelled = board?.event.status === "cancelled";

  const checkedInIds = useMemo(
    () => new Set((board?.checkins ?? []).map((c) => c.user_id)),
    [board],
  );

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (board?.roster ?? [])
      .filter((r) => !checkedInIds.has(r.user_id))
      .filter(
        (r) =>
          !q ||
          (r.name ?? "").toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q),
      );
    return rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [board, checkedInIds, search]);

  async function doCheckIn(row: RosterRow) {
    if (!eventId) return;
    setBusy(true);
    try {
      const res = await checkIn({ data: { event_id: eventId, user_id: row.user_id } });
      const who = row.name ?? "They";
      if (res.already_checked_in) {
        toast.info(`${who} were already checked in.`);
      } else if (res.decision?.coverage === "none") {
        toast.warning(`${who} are in, but nothing covers it. Added to needs attention.`);
      } else {
        const left = res.decision?.sessions_remaining_after;
        const plan = res.decision?.plan_name ?? "their membership";
        toast.success(
          left == null ? `${who} are in, on ${plan}.` : `${who} are in. ${plan}, ${left} left.`,
        );
      }
      setSearch("");
      await Promise.all([reloadBoard(), reloadUncovered()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not check them in");
    } finally {
      setBusy(false);
    }
  }

  async function doUndo(id: string, name: string | null) {
    setBusy(true);
    try {
      const res = await undo({ data: { id } });
      if (!res.removed) {
        // Somebody else undid it while this screen was open. Saying "removed"
        // would claim this click did something it did not.
        toast.info("That check-in was already removed.");
      } else {
        toast.success(
          res.refunded
            ? `Removed ${name ?? "the check-in"} and gave the session back.`
            : `Removed ${name ?? "the check-in"}.`,
        );
      }
      await Promise.all([reloadBoard(), reloadUncovered()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not undo that check-in");
    } finally {
      setBusy(false);
    }
  }

  async function doAttach(row: UncoveredRow) {
    setBusy(true);
    try {
      const chosen = attachChoice[row.id];
      const res = await attach({
        data: { id: row.id, ...(chosen ? { membership_id: chosen } : {}) },
      });
      if (res.decision.coverage === "none") {
        toast.warning("Still nothing covers that class. Sort their membership out first.");
      } else {
        const left = res.decision.sessions_remaining_after;
        const plan = res.decision.plan_name ?? "their membership";
        toast.success(left == null ? `Attached to ${plan}.` : `Attached to ${plan}. ${left} left.`);
        setOpenAttach(null);
      }
      await Promise.all([reloadBoard(), reloadUncovered()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not attach that check-in");
    } finally {
      setBusy(false);
    }
  }

  if (rolesLoading || !isManager) return null;

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Check in</h1>
          <p className="text-muted-foreground">
            Mark who is on the mat. Checking someone in uses one of their sessions.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/manager/calendar">Calendar</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/manager/users">Users</Link>
          </Button>
        </div>
      </div>

      {/* ---- Which class ---- */}
      <div className="rounded-lg border p-4">
        <label className="mb-2 block text-sm font-medium" htmlFor="class-picker">
          Class
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <select
            id="class-picker"
            className={cn(selectClass, "min-w-[22rem] max-w-full")}
            value={eventId ?? ""}
            onChange={(e) => setEventId(e.target.value || null)}
            disabled={loading || events.length === 0}
          >
            {events.length === 0 && <option value="">No classes in the next fortnight</option>}
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {fmt(e.starts_at)} · {e.title}
                {e.status === "cancelled" ? " (cancelled)" : ""} · {e.checked_in_count} in
              </option>
            ))}
          </select>
          {selectedEvent?.location && (
            <span className="text-sm text-muted-foreground">{selectedEvent.location}</span>
          )}
        </div>
        {isCancelled && (
          <p className="mt-3 text-sm font-medium text-destructive">
            This class was cancelled, so nobody can be checked in to it.
          </p>
        )}
        {events.length === 0 && !loading && (
          <p className="mt-3 text-sm text-muted-foreground">
            A check-in has to belong to a class on the calendar.{" "}
            <Link className="underline" to="/manager/calendar">
              Add one first
            </Link>
            .
          </p>
        )}
      </div>

      {/* ---- Here now ---- */}
      <div className="space-y-2">
        <h2 className="text-xl font-bold">Here now{board ? ` (${board.checkins.length})` : ""}</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Covered by</th>
                <th className="px-3 py-2">Why</th>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(board?.checkins ?? []).length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-muted-foreground" colSpan={5}>
                    Nobody yet.
                  </td>
                </tr>
              )}
              {(board?.checkins ?? []).map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2 font-medium">
                    <Link
                      className="hover:underline"
                      to="/manager/users/$userId"
                      params={{ userId: c.user_id }}
                    >
                      {c.name ?? "Unknown"}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Pill
                      label={c.coverage === "none" ? "No cover" : (c.plan_name ?? "Membership")}
                      className={coverageClass(c.coverage)}
                      preserveCase
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Warnings codes={c.warnings} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtTime(c.checked_in_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => doUndo(c.id, c.name)}
                    >
                      Undo
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Everyone else ---- */}
      <div className="space-y-2">
        <h2 className="text-xl font-bold">Check someone in</h2>
        <Input
          autoFocus
          placeholder="Search by name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches.length === 1 && !busy && !isCancelled)
              doCheckIn(matches[0]);
          }}
        />
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">What pays for it</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {matches.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-muted-foreground" colSpan={4}>
                    {search.trim()
                      ? "Nobody by that name has a waiver on file."
                      : "Everyone is checked in."}
                  </td>
                </tr>
              )}
              {matches.slice(0, MATCH_LIMIT).map((r) => (
                <tr key={r.user_id} className="border-t">
                  <td className="px-3 py-2 font-medium">{r.name ?? "Unknown"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.email ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Pill
                      label={coveragePreviewLabel(r)}
                      className={coverageClass(r.coverage)}
                      preserveCase
                    />
                    {/* Only when nothing pays for it: "No cover" on its own is a
                        dead end, and this is the row a manager is looking at
                        while the person stands in front of them. */}
                    {r.coverage === "none" && (
                      <div className="mt-1">
                        <Warnings codes={r.warnings} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      disabled={busy || !eventId || isCancelled}
                      onClick={() => doCheckIn(r)}
                    >
                      Check in
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {matches.length > MATCH_LIMIT && (
          <p className="text-sm text-muted-foreground">
            {matches.length - MATCH_LIMIT} more. Keep typing to narrow it down.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Only people with a waiver on file can be checked in. A walk-in signs the{" "}
          <Link className="underline" to="/waiver">
            waiver
          </Link>{" "}
          first.
        </p>
      </div>

      {/* ---- Needs attention ---- */}
      <div className="space-y-2">
        <h2 className="text-xl font-bold">
          Needs attention{uncovered.length ? ` (${uncovered.length})` : ""}
        </h2>
        <p className="text-sm text-muted-foreground">
          Check-ins nothing covered, from every class. Once the person is sorted out, attach the
          check-in here and the session is used then.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">Person</th>
                <th className="px-3 py-2">Class</th>
                <th className="px-3 py-2">Why</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {uncovered.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-muted-foreground" colSpan={4}>
                    Nothing to sort out.
                  </td>
                </tr>
              )}
              {uncovered.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-t">
                    <td className="px-3 py-2 font-medium">
                      <Link
                        className="hover:underline"
                        to="/manager/users/$userId"
                        params={{ userId: row.user_id }}
                      >
                        {row.name ?? "Unknown"}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {row.event_title ?? "Unknown class"}
                      <span className="block text-xs text-muted-foreground">
                        {row.event_starts_at ? fmt(row.event_starts_at) : fmt(row.checked_in_at)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Warnings codes={row.warnings} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant={row.would_cover ? "default" : "outline"}
                        disabled={busy}
                        onClick={() => setOpenAttach(openAttach === row.id ? null : row.id)}
                      >
                        {openAttach === row.id ? "Close" : "Attach"}
                      </Button>
                    </td>
                  </tr>
                  {openAttach === row.id && (
                    <tr className="border-t bg-muted/30">
                      <td className="px-3 py-3" colSpan={4}>
                        <div className="flex flex-wrap items-center gap-3">
                          <select
                            className={selectClass}
                            value={attachChoice[row.id] ?? ""}
                            onChange={(e) =>
                              setAttachChoice((prev) => ({ ...prev, [row.id]: e.target.value }))
                            }
                          >
                            <option value="">Whatever covers it now</option>
                            {row.memberships.map((m) => (
                              <option key={m.id} value={m.id} disabled={!m.usable}>
                                {m.plan_name ?? "Membership"}
                                {m.sessions_remaining != null
                                  ? ` · ${m.sessions_remaining} left`
                                  : ""}
                                {m.usable ? "" : ` · ${m.reason}`}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" disabled={busy} onClick={() => doAttach(row)}>
                            Attach
                          </Button>
                          {!row.would_cover && !attachChoice[row.id] && (
                            <span className="text-sm text-muted-foreground">
                              Nothing covers it yet. Give them a membership first, or pick one
                              above.
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
