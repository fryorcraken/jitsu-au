import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/site/StatusPill";
import { formatDate } from "@/lib/dates";
import {
  ROLE_CLASS,
  UNREAD_CLASS,
  lifecycleClass,
  membershipClass,
  verificationClass,
} from "@/lib/status-colours";
import { lifecycleLabel, membershipStatusLabel } from "@/lib/status-labels";
import { lifecycleStatuses, normalizeEmail } from "@/lib/validation";
import { emailVerificationLabel } from "@/lib/email-verification";
import { listClubUsers } from "@/lib/membership.functions";
import { markInterestRegistrationsSeen } from "@/lib/leads.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { useNotifications } from "@/hooks/useNotifications";

export const Route = createFileRoute("/_authenticated/manager/users")({
  head: () => ({
    meta: [{ title: "Users | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerUsersPage,
});

type Row = Awaited<ReturnType<typeof listClubUsers>>[number];

type SortKey = "name" | "recent" | "status" | "sessions";

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ManagerUsersPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listClubUsers);
  const markLeadsSeen = useServerFn(markInterestRegistrationsSeen);
  const { refresh: refreshNotifications } = useNotifications();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  // Who registered interest since a manager last opened this screen, captured
  // before the watermark moved. Normalized addresses: a lead is keyed by the
  // address they typed, a person by their auth email.
  const [newEmails, setNewEmails] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<string>("all");
  const [role, setRole] = useState<string>("all");
  const [waiver, setWaiver] = useState<string>("all");
  const [student, setStudent] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("name");

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchList()
      .then((data) => {
        setRows(data as Row[]);
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Failed to load users");
        setLoading(false);
      });
  }, [isManager, fetchList]);

  // This screen is where new interest registrations are read, so opening it is
  // what clears them off the "needs attention" list. Club-wide, like the contact
  // inbox: whichever manager looks clears it for all of them.
  //
  // Stamped even if the list above failed to load, and even if the manager came
  // here for something else entirely. Both are deliberate. A registration is a
  // person, and that person stays on this list for good, so the worst a stamp
  // can cost is a badge, never the record of who signed up. That is what makes
  // this looser than the contact inbox, where the message exists nowhere else.
  //
  // The call hands back WHO the badge was about, and the table pills those rows
  // "new". Without that, following "Read them" for four registrations lands on
  // one row per person for the whole club, sorted by name, with nothing marking
  // the four: clearing the badge would destroy the only record of what it was
  // telling you. `manager.contact-messages.tsx` keeps its unread ids for the
  // same reason.
  //
  // Once per visit, which is why `isManager` is the only dependency.
  // `refreshNotifications` is a fresh closure on every render, so listing it
  // would stamp on every keystroke in the search box AND spin: stamp,
  // invalidate, refetch, re-render, stamp. Same shape, and the same disable, as
  // the load effect on /manager/contact-messages.
  useEffect(() => {
    if (!isManager) return;
    markLeadsSeen()
      .then((result) => {
        setNewEmails(new Set(result.newEmails));
        refreshNotifications();
      })
      // Silent: nobody asked for this, and the only cost of it failing is a
      // badge that clears on the next visit.
      .catch((e) => console.error("[manager/users] could not mark registrations seen:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (q) {
        const hay = `${r.name ?? ""} ${r.email ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (lifecycle !== "all" && r.lifecycle_status !== lifecycle) return false;
      if (role !== "all" && !r.roles.includes(role)) return false;
      if (waiver === "yes" && !r.has_waiver) return false;
      if (waiver === "no" && r.has_waiver) return false;
      if (student === "yes" && !r.is_uts_student) return false;
      if (student === "no" && r.is_uts_student) return false;
      return true;
    });

    const sorted = [...filtered];
    if (sort === "name") {
      sorted.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    } else if (sort === "sessions") {
      // Who has been training most, which is the question a manager actually
      // asks of this column.
      sorted.sort(
        (a, b) =>
          b.sessions_attended - a.sessions_attended || (a.name ?? "").localeCompare(b.name ?? ""),
      );
    } else if (sort === "recent") {
      // Newest first-seen at the top; users with no date sort last.
      sorted.sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""));
    } else {
      const order = ["member", "visitor", "applicant", "lead", "lapsed"];
      sorted.sort(
        (a, b) =>
          order.indexOf(a.lifecycle_status) - order.indexOf(b.lifecycle_status) ||
          (a.name ?? "").localeCompare(b.name ?? ""),
      );
    }
    return sorted;
  }, [rows, search, lifecycle, role, waiver, student, sort]);

  return (
    <>
      <section className="mx-auto max-w-7xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Users</h1>
            <p className="text-sm text-muted-foreground">
              The whole funnel, one row per person: leads, applicants, visitors, members and lapsed
              members.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/manager/memberships">Memberships</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/waivers">Signed waivers</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/account">Back to account</Link>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full max-w-xs"
          />
          <select
            aria-label="Filter by lifecycle status"
            className={selectClass}
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
          >
            <option value="all">All statuses</option>
            {/* The value stays the stored enum (it is what the filter matches
                on); only the text a manager reads is put through the label. */}
            {lifecycleStatuses.map((s) => (
              <option key={s} value={s}>
                {lifecycleLabel(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by role"
            className={selectClass}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="all">All roles</option>
            <option value="member">Member</option>
            <option value="manager">Manager</option>
          </select>
          <select
            aria-label="Filter by waiver"
            className={selectClass}
            value={waiver}
            onChange={(e) => setWaiver(e.target.value)}
          >
            <option value="all">Waiver: any</option>
            <option value="yes">Waiver: signed</option>
            <option value="no">Waiver: none</option>
          </select>
          <select
            aria-label="Filter by UTS student"
            className={selectClass}
            value={student}
            onChange={(e) => setStudent(e.target.value)}
          >
            <option value="all">Student: any</option>
            <option value="yes">Student: yes</option>
            <option value="no">Student: no</option>
          </select>
          <select
            aria-label="Sort by"
            className={selectClass}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="name">Sort: name (A to Z)</option>
            <option value="recent">Sort: most recent</option>
            <option value="status">Sort: lifecycle status</option>
            <option value="sessions">Sort: sessions attended</option>
          </select>
        </div>

        {loading ? (
          <p>Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users yet.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Showing {visible.length} of {rows.length}
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Roles</th>
                    <th className="px-3 py-2">UTS student</th>
                    {/* Size codes off the club's charts, for ordering kit. The
                        full label with the measurement is on the detail page;
                        a directory column only has room for the code. */}
                    <th className="px-3 py-2">Gi</th>
                    <th className="px-3 py-2">Belt</th>
                    <th className="px-3 py-2">Waiver</th>
                    <th className="px-3 py-2">Sessions</th>
                    <th className="px-3 py-2">Latest membership</th>
                    <th className="px-3 py-2">First seen</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.user_id ?? r.email ?? r.name ?? ""} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">
                        {r.user_id ? (
                          <Link
                            to="/manager/users/$userId"
                            params={{ userId: r.user_id }}
                            className="underline underline-offset-2 hover:no-underline"
                          >
                            {r.name ?? r.email ?? "View"}
                          </Link>
                        ) : (
                          // A lead has no person record yet, so nothing to open.
                          (r.name ?? "—")
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.email ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{r.email}</span>
                            {/* Registered interest since a manager last looked.
                                On the address, not the name, because that is
                                what the registration and the person record have
                                in common. */}
                            {newEmails.has(normalizeEmail(r.email)) ? (
                              <Pill label="new" className={UNREAD_CLASS} />
                            ) : null}
                            {/* Leads have no person record, so nothing has been
                                proven about them either way. Badging one would
                                claim more than the club knows. */}
                            {r.user_id ? (
                              <Pill
                                label={emailVerificationLabel(r.email_confirmed_at)}
                                className={verificationClass(
                                  emailVerificationLabel(r.email_confirmed_at),
                                )}
                              />
                            ) : null}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">{r.phone ?? "—"}</td>
                      <td className="px-3 py-2">
                        <Pill
                          label={lifecycleLabel(r.lifecycle_status, {
                            status: r.latest_membership_status ?? "",
                            kind: r.latest_plan_kind,
                            sessions_remaining: r.latest_sessions_remaining,
                          })}
                          preserveCase
                          className={lifecycleClass(r.lifecycle_status)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {r.roles.length ? (
                          <div className="flex flex-wrap gap-1">
                            {r.roles.map((roleName) => (
                              <Pill key={roleName} label={roleName} className={ROLE_CLASS} />
                            ))}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.is_uts_student ? (r.uts_student_number ?? "Yes") : "No"}
                      </td>
                      <td className="px-3 py-2">{r.gi_size ?? "—"}</td>
                      <td className="px-3 py-2">{r.belt_size ?? "—"}</td>
                      <td className="px-3 py-2">{formatDate(r.waiver_signed_at)}</td>
                      {/* Classes trained, whatever paid for them. Not the same
                          as credits used, which lives on the membership. */}
                      <td className="px-3 py-2">{r.sessions_attended || "—"}</td>
                      <td className="px-3 py-2">
                        {r.latest_plan_name ? (
                          <div className="flex flex-col gap-1">
                            <span>{r.latest_plan_name}</span>
                            {r.latest_membership_status ? (
                              <Pill
                                label={membershipStatusLabel({
                                  status: r.latest_membership_status,
                                  kind: r.latest_plan_kind,
                                  sessions_remaining: r.latest_sessions_remaining,
                                })}
                                preserveCase
                                className={membershipClass(r.latest_membership_status)}
                              />
                            ) : null}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">{formatDate(r.first_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}
