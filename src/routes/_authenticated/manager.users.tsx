import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { lifecycleStatuses } from "@/lib/validation";
import { emailVerificationLabel } from "@/lib/email-verification";
import { listClubUsers } from "@/lib/membership.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/users")({
  head: () => ({
    meta: [{ title: "Users | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerUsersPage,
});

type Row = Awaited<ReturnType<typeof listClubUsers>>[number];

const LIFECYCLE_CLASS: Record<string, string> = {
  lead: "bg-slate-100 text-slate-800",
  applicant: "bg-amber-100 text-amber-800",
  visitor: "bg-sky-100 text-sky-800",
  member: "bg-green-100 text-green-800",
  lapsed: "bg-red-100 text-red-800",
};

// Verified means someone opened a link we sent to that address. Amber rather
// than red: an unverified address is a thing to notice before emailing someone
// a sign-in link, not a fault.
const VERIFICATION_CLASS: Record<string, string> = {
  verified: "bg-green-100 text-green-800",
  unverified: "bg-amber-100 text-amber-800",
};

const MEMBERSHIP_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  expired: "bg-red-100 text-red-800",
  cancelled: "bg-slate-100 text-slate-800",
};

type SortKey = "name" | "recent" | "status";

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU") : "none";
}

function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {label}
    </span>
  );
}

function ManagerUsersPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listClubUsers);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

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
            {lifecycleStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
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
                    <th className="px-3 py-2">Waiver</th>
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
                            {/* Leads have no person record, so nothing has been
                                proven about them either way. Badging one would
                                claim more than the club knows. */}
                            {r.user_id ? (
                              <Pill
                                label={emailVerificationLabel(r.email_confirmed_at)}
                                className={
                                  VERIFICATION_CLASS[emailVerificationLabel(r.email_confirmed_at)]
                                }
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
                          label={r.lifecycle_status}
                          className={
                            LIFECYCLE_CLASS[r.lifecycle_status] ?? "bg-slate-100 text-slate-800"
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        {r.roles.length ? (
                          <div className="flex flex-wrap gap-1">
                            {r.roles.map((roleName) => (
                              <Pill
                                key={roleName}
                                label={roleName}
                                className="bg-indigo-100 text-indigo-800"
                              />
                            ))}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.is_uts_student ? (r.uts_student_number ?? "Yes") : "No"}
                      </td>
                      <td className="px-3 py-2">{fmtDate(r.waiver_signed_at)}</td>
                      <td className="px-3 py-2">
                        {r.latest_plan_name ? (
                          <div className="flex flex-col gap-1">
                            <span>{r.latest_plan_name}</span>
                            {r.latest_membership_status ? (
                              <Pill
                                label={r.latest_membership_status}
                                className={
                                  MEMBERSHIP_CLASS[r.latest_membership_status] ??
                                  "bg-slate-100 text-slate-800"
                                }
                              />
                            ) : null}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">{fmtDate(r.first_seen_at)}</td>
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
