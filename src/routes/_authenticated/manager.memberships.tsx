import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/site/StatusPill";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { MembershipRowActions } from "@/components/site/MembershipRowActions";
import { membershipClass } from "@/lib/status-colours";
import { membershipStatusLabel } from "@/lib/status-labels";
import { formatCents } from "@/lib/validation";
import { listMemberships } from "@/lib/membership.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/memberships")({
  head: () => ({
    meta: [{ title: "Memberships | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerMembershipsPage,
});

type Row = Awaited<ReturnType<typeof listMemberships>>[number];

function ManagerMembershipsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listMemberships);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
          const message = describeLoadError(e, "Could not load the memberships");
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

  async function refresh() {
    setRows((await fetchList()) as Row[]);
  }

  return (
    <>
      <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Memberships</h1>
            <p className="text-sm text-muted-foreground">
              Activate paid memberships once payment lands, or reconcile a bank statement.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/manager/users">Users</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/reconciliation">Reconcile bank statement</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/membership-plans">Membership plans</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/settings">Settings</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/account">Back to account</Link>
            </Button>
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadFailure
            what="The memberships"
            message={loadError}
            hint="This is not the same as nobody being on a plan, so do not raise one from here until it loads."
            onRetry={() => void load()}
          />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No memberships yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Member</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Student #</th>
                  <th className="px-3 py-2">Reference</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.member_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.member_email ?? r.user_id ?? "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.plan_name ?? "—"}</td>
                    <td className="px-3 py-2">{formatCents(r.price_cents)}</td>
                    <td className="px-3 py-2">{r.uts_student_number ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.payment_reference}</td>
                    <td className="px-3 py-2">
                      <Pill
                        label={membershipStatusLabel(r)}
                        preserveCase
                        className={membershipClass(r.status)}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MembershipRowActions membership={r} onChanged={refresh} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
