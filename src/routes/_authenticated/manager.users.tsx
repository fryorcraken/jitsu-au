import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pill } from "@/components/site/StatusPill";
import { UserLink } from "@/components/site/UserLink";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
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
import { deleteLead, markInterestRegistrationsSeen } from "@/lib/leads.functions";
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
  const removeLead = useServerFn(deleteLead);
  const { refresh: refreshNotifications } = useNotifications();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  // The lead a manager has asked to delete, held until they confirm. The row
  // stays in the table until the server says the rows are gone, so a refusal
  // leaves the directory exactly as it was.
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [deletingEmail, setDeletingEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useMemo(
    () => () => {
      setLoading(true);
      return fetchList()
        .then((data) => {
          setRows(data as Row[]);
          setLoadError(null);
        })
        .catch((e) => {
          const message = describeLoadError(e, "Could not load the members");
          setLoadError(message);
          toast.error(message);
        })
        .finally(() => setLoading(false));
    },
    [fetchList],
  );

  useEffect(() => {
    if (!isManager) return;
    void load();
  }, [isManager, load]);

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

  async function onDeleteLead(row: Row) {
    if (!row.email) return;
    const email = row.email;
    setDeletingEmail(email);
    try {
      await removeLead({ data: { email } });
      const wanted = normalizeEmail(email);
      setRows((prev) =>
        prev.filter((r) => r.user_id || !r.email || normalizeEmail(r.email) !== wanted),
      );
      toast.success("Enquiry deleted");
    } catch (e) {
      // Nothing was lost: the row is still in the table and still in the
      // database. The likeliest refusal is that this address now belongs to
      // somebody who has signed a waiver, and the message says so.
      toast.error(e instanceof Error ? e.message : "Could not delete that enquiry");
    } finally {
      setDeletingEmail(null);
      setPendingDelete(null);
    }
  }

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
          <Loading />
        ) : loadError ? (
          <LoadFailure
            what="The member list"
            message={loadError}
            hint="This is not the same as the club having no members."
            onRetry={() => void load()}
          />
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
                    <th className="px-3 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.user_id ?? r.email ?? r.name ?? ""} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">
                        {/* A lead has no person record yet, so `UserLink` prints
                            the name instead of linking to a page that is not
                            there. The address stands in when a row has no name:
                            it is the only thing a lead is guaranteed to have. */}
                        <UserLink userId={r.user_id} name={r.name ?? r.email} />
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
                      {/* Only a lead can be deleted from here. Everyone else has
                          a signed waiver, a membership or attendance behind
                          them, and what the club is allowed to destroy of that
                          is still an open question, so the button is not drawn
                          rather than drawn and refused. */}
                      <td className="px-3 py-2 text-right">
                        {!r.user_id && r.email ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            // Named after whose enquiry it deletes: one row of
                            // a long directory, and nothing about a button
                            // called "Delete" says which row it belongs to.
                            aria-label={`Delete the enquiry from ${r.name ?? r.email}`}
                            disabled={deletingEmail === r.email}
                            onClick={() => setPendingDelete(r)}
                          >
                            {deletingEmail === r.email ? "Deleting..." : "Delete"}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete the enquiry from {pendingDelete?.name ?? pendingDelete?.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every interest form filed under {pendingDelete?.email}, with the name,
              phone number and message on it, and takes them off this list. The club keeps no copy,
              and it can't be undone. Anything they sent through the contact form is separate. This
              does not touch it, and it stays in Contact messages until you delete it there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingDelete && onDeleteLead(pendingDelete)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
