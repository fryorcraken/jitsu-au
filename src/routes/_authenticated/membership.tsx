import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { computeMembershipPrice, formatCents, type LifecycleStatus } from "@/lib/validation";
import { getMyMemberships, listMembershipPlans, startMembership } from "@/lib/membership.functions";

export const Route = createFileRoute("/_authenticated/membership")({
  head: () => ({
    meta: [{ title: "Membership | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: MembershipPage,
});

type Plan = Awaited<ReturnType<typeof listMembershipPlans>>[number];
type Mine = Awaited<ReturnType<typeof getMyMemberships>>;

const LIFECYCLE_COPY: Record<LifecycleStatus, { label: string; blurb: string; className: string }> =
  {
    prospect: {
      label: "Prospect",
      blurb: "Welcome! Start with two free trial sessions, then pick a plan.",
      className: "bg-slate-100 text-slate-800",
    },
    trial: {
      label: "On trial",
      blurb: "You're on your free trial. Join a plan when you're ready to keep training.",
      className: "bg-amber-100 text-amber-800",
    },
    member: {
      label: "Member",
      blurb: "You're an active member. See you on the mat!",
      className: "bg-green-100 text-green-800",
    },
    expired: {
      label: "Expired",
      blurb: "Your membership has lapsed. Renew below to keep training.",
      className: "bg-red-100 text-red-800",
    },
  };

function MembershipPage() {
  const navigate = useNavigate();
  const fetchPlans = useServerFn(listMembershipPlans);
  const fetchMine = useServerFn(getMyMemberships);
  const start = useServerFn(startMembership);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [mine, setMine] = useState<Mine | null>(null);
  const [loading, setLoading] = useState(true);
  const [studentNumber, setStudentNumber] = useState("");
  const [sessionDate, setSessionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  // A non-empty UTS student number is what makes someone a student; there is no
  // separate "I'm a student" flag. It unlocks the discounted student rate.
  const isStudent = studentNumber.trim().length > 0;

  const reload = useMemo(
    () => () => {
      return Promise.all([fetchPlans(), fetchMine()]).then(([p, m]) => {
        setPlans(p);
        setMine(m);
        // Prefill the student number from the member's waiver so they don't
        // retype it (blank there means they never gave one).
        if (m.uts_student_number) setStudentNumber(m.uts_student_number);
      });
    },
    [fetchPlans, fetchMine],
  );

  useEffect(() => {
    reload()
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load memberships"))
      .finally(() => setLoading(false));
  }, [reload]);

  async function choose(plan: Plan) {
    setPendingCode(plan.code);
    try {
      const res = await start({
        data: {
          plan_code: plan.code,
          is_student: isStudent,
          uts_student_number: studentNumber.trim(),
          session_date: plan.kind === "session" ? sessionDate : "",
          hp: "",
        },
      });
      await reload();
      if (res.activated) {
        toast.success("You're all set. Your membership is active.");
      } else {
        toast.success("Check your email for bank-transfer instructions.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start membership");
    } finally {
      setPendingCode(null);
    }
  }

  if (loading) {
    return (
      <>
        <div className="p-8">Loading...</div>
      </>
    );
  }

  const lifecycle = mine?.lifecycle ?? "prospect";
  const status = LIFECYCLE_COPY[lifecycle];

  return (
    <>
      <section className="mx-auto max-w-4xl space-y-8 px-4 py-12">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black">Membership</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a plan, pay by bank transfer, and you're on the mat.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <CardTitle>Your status</CardTitle>
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  status.className,
                )}
              >
                {status.label}
              </span>
            </div>
            <CardDescription>{status.blurb}</CardDescription>
          </CardHeader>
          {mine && mine.memberships.length > 0 && (
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-3 py-2">Plan</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Price</th>
                      <th className="px-3 py-2">Reference</th>
                      <th className="px-3 py-2">Valid until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.memberships.map((m) => (
                      <tr key={m.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{m.plan_name ?? "—"}</td>
                        <td className="px-3 py-2 capitalize">{m.status}</td>
                        <td className="px-3 py-2">{formatCents(m.price_cents)}</td>
                        <td className="px-3 py-2">
                          {m.status === "pending" ? (
                            <span className="font-mono text-xs">{m.payment_reference}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {m.ends_at
                            ? new Date(m.ends_at).toLocaleDateString("en-AU")
                            : m.sessions_remaining != null
                              ? `${m.sessions_remaining} sessions`
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mine.memberships.some((m) => m.status === "pending") && (
                <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <Mail className="h-4 w-4" />
                  Awaiting a bank transfer? We emailed you the account details and your payment
                  reference. Include the reference so we can match your payment automatically.
                </p>
              )}
            </CardContent>
          )}
        </Card>

        <div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold">Choose a plan</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                UTS students pay a discounted rate. Just add your student number.
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <Label htmlFor="sid" className="text-xs">
                UTS student number <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="sid"
                value={studentNumber}
                onChange={(e) => setStudentNumber(e.target.value)}
                maxLength={20}
                placeholder="e.g. 12345678"
                className="mt-1 h-8"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Add it to get the student rate.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {plans.map((plan) => {
              const price = computeMembershipPrice(plan, isStudent);
              const discounted =
                isStudent &&
                plan.student_price_cents != null &&
                plan.student_price_cents < plan.public_price_cents;
              return (
                <div key={plan.code} className="flex flex-col rounded-2xl border bg-card p-6">
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  {plan.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                  )}
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-3xl font-bold tracking-tight">{formatCents(price)}</span>
                    {discounted && (
                      <span className="text-sm text-muted-foreground line-through">
                        {formatCents(plan.public_price_cents)}
                      </span>
                    )}
                    {discounted && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Student rate
                      </span>
                    )}
                  </div>
                  <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
                    {plan.session_credits != null && (
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        {plan.session_credits} session{plan.session_credits === 1 ? "" : "s"}
                      </li>
                    )}
                    {plan.duration_days != null && (
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        Valid {plan.duration_days} days
                      </li>
                    )}
                  </ul>
                  {plan.kind === "session" && (
                    <div className="mt-4">
                      <Label htmlFor={`sd-${plan.code}`} className="text-xs">
                        Session date
                      </Label>
                      <Input
                        id={`sd-${plan.code}`}
                        type="date"
                        value={sessionDate}
                        onChange={(e) => setSessionDate(e.target.value)}
                        className="mt-1 h-8"
                      />
                    </div>
                  )}
                  <Button
                    className="mt-6"
                    disabled={pendingCode !== null}
                    onClick={() => choose(plan)}
                  >
                    {pendingCode === plan.code
                      ? "Starting..."
                      : price === 0
                        ? "Start free"
                        : "Choose & pay by transfer"}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          Haven't signed your training waiver yet?{" "}
          <Link to="/waiver" className="underline hover:text-foreground">
            Sign it here
          </Link>{" "}
          before your first class.
        </p>
      </section>
    </>
  );
}
