import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/site/StatusPill";
import { UserLink } from "@/components/site/UserLink";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { MembershipRowActions } from "@/components/site/MembershipRowActions";
import { PaidNote } from "@/components/site/PaymentReceived";
import { InsuranceReminderNote } from "@/components/site/InsuranceReminderNote";
import { formatDate } from "@/lib/dates";
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

  const endingSoon = rows.filter((r) => r.insurance_reminder?.ends_within_14_days);

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
          <>
            {/* Where the "insurance ends in the next 14 days" attention item
              lands: the people, first, so a manager can mention it at the door.
              Only those still owed the reminder, so somebody who has renewed
              is not on it. */}
            {endingSoon.length > 0 && (
              <section
                aria-labelledby="insurance-ending"
                className="rounded-lg border border-primary/40 bg-accent/40 p-4"
              >
                <h2 id="insurance-ending" className="text-lg font-bold">
                  Insurance ending in the next 14 days
                </h2>
                <p className="text-sm text-muted-foreground">
                  Each of them is emailed 14 days before and again on the day. Mention it if you see
                  them at training.
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {endingSoon.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium">
                        <UserLink userId={r.user_id} name={r.member_name} />
                      </span>
                      , ends {formatDate(r.ends_at)}
                      <InsuranceReminderNote state={r.insurance_reminder} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
                        {/* `memberships.user_id` is ON DELETE SET NULL, and the
                          name is looked up through it, so a row whose person is
                          gone has neither. That row reads "Unknown" as plain
                          text, not a link to a page that is not there. The
                          invoice itself survives on purpose
                          (`docs/erasing-personal-data.md`). */}
                        <div className="font-medium">
                          <UserLink userId={r.user_id} name={r.member_name} />
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{r.member_email ?? r.user_id ?? "—"}</span>
                          {/* Whose address that is. An invoice for a child carries
                            the PARENT's address, because the parent is who to
                            chase for the money, and printed bare it reads as a
                            nine-year-old with a bank account. `listMemberships`
                            has carried this since #112 and no screen printed it;
                            `list_invoices` already says the same thing, and the
                            two surfaces must not disagree about whether they say
                            it at all. Null for every account holder. */}
                          {r.member_email_belongs_to ? (
                            <span>({r.member_email_belongs_to}&apos;s)</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {r.plan_name ?? "—"}
                        {r.kind === "insurance" && r.ends_at ? (
                          <div className="text-xs text-muted-foreground">
                            Ends {formatDate(r.ends_at)}
                          </div>
                        ) : null}
                        <InsuranceReminderNote state={r.insurance_reminder} />
                      </td>
                      <td className="px-3 py-2">
                        {formatCents(r.price_cents)}
                        <PaidNote paidAt={r.paid_at} reference={r.paid_reference} />
                      </td>
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
          </>
        )}
      </section>
    </>
  );
}
