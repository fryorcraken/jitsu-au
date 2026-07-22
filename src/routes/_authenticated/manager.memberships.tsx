import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/validation";
import { listMemberships, setMembershipStatus } from "@/lib/membership.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/memberships")({
  head: () => ({
    meta: [{ title: "Memberships | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ManagerMembershipsPage,
});

type Row = Awaited<ReturnType<typeof listMemberships>>[number];

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  expired: "bg-red-100 text-red-800",
  cancelled: "bg-slate-100 text-slate-800",
};

function ManagerMembershipsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchList = useServerFn(listMemberships);
  const setStatus = useServerFn(setMembershipStatus);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

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
        toast.error(e instanceof Error ? e.message : "Failed to load memberships");
        setLoading(false);
      });
  }, [isManager, fetchList]);

  async function update(row: Row, status: "active" | "cancelled" | "pending") {
    setPendingId(row.id);
    try {
      await setStatus({ data: { id: row.id, status } });
      const data = await fetchList();
      setRows(data as Row[]);
      toast.success(status === "active" ? "Membership activated" : `Membership ${status}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update membership");
    } finally {
      setPendingId(null);
    }
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
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link to="/manager/users">Users</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/reconciliation">Reconcile bank statement</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/membership-plans">Edit plans</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/settings">Settings</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/manager/api-tokens">Agent access</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/account">Back to account</Link>
            </Button>
          </div>
        </div>

        {loading ? (
          <p>Loading...</p>
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
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          STATUS_CLASS[r.status] ?? "bg-slate-100 text-slate-800",
                        )}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.status === "active" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pendingId === r.id}
                          onClick={() => update(r, "cancelled")}
                        >
                          <Undo2 className="mr-1 h-3 w-3" /> Cancel
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={pendingId === r.id}
                          onClick={() => update(r, "active")}
                        >
                          <Check className="mr-1 h-3 w-3" /> Activate
                        </Button>
                      )}
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
