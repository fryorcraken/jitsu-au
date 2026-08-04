import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/site/StatusPill";
import { lifecycleClass } from "@/lib/status-colours";
import { cn } from "@/lib/utils";
import {
  computeMembershipPrice,
  formatCents,
  insuranceSelection,
  isUtsStudent,
  sellablePlans,
  type LifecycleStatus,
} from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";
import { CLUB_TIME_ZONE, clubLocalDate } from "@/lib/calendar";
import { getMyMemberships, listMembershipPlans, startMembership } from "@/lib/membership.functions";
import { getCodeOfConductSigner } from "@/lib/code-of-conduct.functions";
import type { CodeOfConductState } from "@/lib/code-of-conduct";

export const Route = createFileRoute("/_authenticated/membership")({
  head: () => ({
    meta: [{ title: "Membership | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: MembershipPage,
});

type Plan = Awaited<ReturnType<typeof listMembershipPlans>>[number];
type Mine = Awaited<ReturnType<typeof getMyMemberships>>;

// The words are this page's own: a member reads "On trial", a manager reads
// "visitor". The colours are not, and come from the shared map so the badge a
// member sees matches the one a manager sees for the same phase.
const LIFECYCLE_COPY: Record<LifecycleStatus, { label: string; blurb: string }> = {
  lead: {
    label: "New here",
    blurb: "Welcome! Sign the waiver and your two free trial sessions are waiting.",
  },
  applicant: {
    label: "Waiver pending",
    blurb: "Your waiver is with the club for review. Hold tight!",
  },
  visitor: {
    label: "On trial",
    blurb: "You're on your free trial. Join a plan when you're ready to keep training.",
  },
  member: {
    label: "Member",
    blurb: "You're an active member. See you on the mat!",
  },
  lapsed: {
    label: "Lapsed",
    blurb: "Your membership has lapsed. Renew below to keep training.",
  },
};

/**
 * A one-line nudge to read the code of conduct, shown only to someone who has
 * not agreed to the current version.
 *
 * This page is where the club actually wants it signed: joining as a paying
 * member is the moment the house rules start to matter. It is still not a
 * condition of anything, so it renders as a note and never blocks a plan, and it
 * disappears entirely once they have agreed.
 */
function CodeOfConductNudge() {
  const fetchSigner = useServerFn(getCodeOfConductSigner);
  const [state, setState] = useState<CodeOfConductState | null>(null);

  useEffect(() => {
    fetchSigner({ data: { token: "" } })
      .then((res) => setState(res.status?.state ?? null))
      .catch(() => setState(null));
  }, [fetchSigner]);

  if (state === null || state === "signed") return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
      <p className="text-sm text-muted-foreground">
        {state === "outdated"
          ? "We have updated our code of conduct since you agreed to it. Please have another read."
          : "While you're here, please read our code of conduct and agree to it. It takes a minute."}
      </p>
      <Button asChild size="sm" variant="outline">
        <Link to="/code-of-conduct" search={{ t: undefined }}>
          Read it
        </Link>
      </Button>
    </div>
  );
}

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
  // The insurance checkbox is not raw state: it starts from the rules in
  // `insuranceSelection` and is only editable while the member has cover.
  const [insuranceTicked, setInsuranceTicked] = useState<boolean | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  // A non-empty UTS student number is what makes someone a student; there is no
  // separate "I'm a student" flag. It unlocks the discounted student rate. Same
  // rule the server uses for authoritative pricing, so the two can't disagree.
  const isStudent = isUtsStudent(studentNumber);

  // The member's current insurance cover: the latest ends_at across ACTIVE
  // insurance memberships. Pending insurance invoices are a promise, not
  // cover, so they never feed this.
  const insuranceEndsAt = useMemo(() => {
    const ends = (mine?.memberships ?? [])
      .filter((m) => m.kind === "insurance" && m.status === "active" && m.ends_at)
      .map((m) => m.ends_at!)
      .sort();
    return ends.length ? ends[ends.length - 1] : null;
  }, [mine]);

  const insuranceRules = useMemo(
    () => insuranceSelection({ insuranceEndsAt, now: new Date().toISOString() }),
    [insuranceEndsAt],
  );
  const insurancePlan = plans.find((p) => p.kind === "insurance") ?? null;
  const insuranceIncluded = insuranceTicked ?? insuranceRules.preselect;

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
          include_insurance: plan.kind !== "insurance" ? insuranceIncluded : false,
          hp: "",
        },
      });
      setInsuranceTicked(null);
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

  const lifecycle = mine?.lifecycle ?? "lead";
  const status = LIFECYCLE_COPY[lifecycle];

  // A dated plan drops off this list on its own once its `ends_on` passes —
  // there is no manager step to retire it, and no pro rata either way.
  const trainingPlans = sellablePlans(
    plans.filter((p) => p.kind === "period" || p.kind === "session"),
    new Date().toISOString(),
  );
  // Club-local, not UTC: a plan's own starts_on is a club-calendar day, so
  // "has this one started" is judged by the same calendar the plan's dates
  // are written in.
  const today = clubLocalDate(new Date(), CLUB_TIME_ZONE);
  const otherPlans = plans.filter((p) => p.kind === "trial" || p.kind === "insurance");

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
              {/* Not the shared <Pill>: this badge is a heading companion, so it
                  sits slightly larger and bolder, and its label is a sentence
                  ("On trial") that must not be title-cased. */}
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  lifecycleClass(lifecycle),
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
              {mine.sessions_attended > 0 && (
                <p className="mt-3 text-sm text-muted-foreground">
                  You have trained {mine.sessions_attended} time
                  {mine.sessions_attended === 1 ? "" : "s"} with us.
                </p>
              )}
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

        <CodeOfConductNudge />

        <div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold">Choose a plan</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Pay per class, or get a membership for the whole training period.
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

          {insurancePlan && trainingPlans.length > 0 && (
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={insuranceIncluded}
                disabled={!insuranceRules.canDeselect}
                onChange={(e) => setInsuranceTicked(e.target.checked)}
              />
              <span>
                <span className="text-sm font-medium">
                  Yearly insurance ({formatCents(computeMembershipPrice(insurancePlan, isStudent))}){" "}
                  {insuranceIncluded ? "included" : "not included"}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {insuranceRules.canDeselect
                    ? `Required to train. Your cover runs to ${insuranceEndsAt ? new Date(insuranceEndsAt).toLocaleDateString("en-AU") : ""}, so you can leave it off this time.`
                    : "Required to train, so it comes with your plan. It covers you and your club affiliation for a year."}
                </span>
              </span>
            </label>
          )}

          {!trainingPlans.some((p) => p.kind === "period") && (
            <p className="mt-4 text-sm text-muted-foreground">
              No membership is open for enrolment right now. Check back soon, or train casually in
              the meantime.
            </p>
          )}

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {trainingPlans.map((plan) => {
              const planPrice = computeMembershipPrice(plan, isStudent);
              const insurancePrice =
                insuranceIncluded && insurancePlan
                  ? computeMembershipPrice(insurancePlan, isStudent)
                  : 0;
              const price = planPrice + insurancePrice;
              const discounted =
                isStudent &&
                plan.student_price_cents != null &&
                plan.student_price_cents < plan.public_price_cents;
              // A pre-sale dated plan (offered ahead of its own starts_on, so
              // members can join before it begins) looks identical to one
              // already running unless the card says which it is.
              const hasStarted =
                plan.kind !== "period" || !plan.starts_on || plan.starts_on <= today;
              return (
                <div key={plan.code} className="flex flex-col rounded-2xl border bg-card p-6">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-lg font-semibold">{plan.name}</h3>
                    {plan.kind === "period" && plan.starts_on && (
                      <Pill
                        label={hasStarted ? "On now" : `Starts ${formatDateOnly(plan.starts_on)}`}
                        preserveCase
                        className={
                          hasStarted
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground"
                        }
                      />
                    )}
                  </div>
                  {plan.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                  )}
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-3xl font-bold tracking-tight">{formatCents(price)}</span>
                    {discounted && (
                      <span className="text-sm text-muted-foreground line-through">
                        {formatCents(plan.public_price_cents + insurancePrice)}
                      </span>
                    )}
                    {discounted && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Student rate
                      </span>
                    )}
                    {insurancePrice > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {formatCents(planPrice)} + {formatCents(insurancePrice)} insurance
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
                  {plan.kind === "period" && plan.starts_on && plan.ends_on && (
                    <p className="mt-4 text-xs text-muted-foreground">
                      {formatDateOnly(plan.starts_on)} to {formatDateOnly(plan.ends_on)}. Same price
                      however far into it you join, and there's no pro rata. Prefer to pay as you go
                      instead? Choose a casual class.
                    </p>
                  )}
                  <Button
                    className="mt-6"
                    disabled={pendingCode !== null}
                    onClick={() => choose(plan)}
                  >
                    {pendingCode === plan.code
                      ? "Starting..."
                      : hasStarted
                        ? "Choose & pay by transfer"
                        : `Join from ${formatDateOnly(plan.starts_on)}`}
                  </Button>
                </div>
              );
            })}
          </div>

          {otherPlans.length > 0 && (
            <div className="mt-8">
              <h3 className="text-lg font-semibold">Also available</h3>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {otherPlans.map((plan) => {
                  const price = computeMembershipPrice(plan, isStudent);
                  return (
                    <div key={plan.code} className="flex flex-col rounded-2xl border bg-card p-6">
                      <h4 className="text-base font-semibold">{plan.name}</h4>
                      {plan.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                      )}
                      <div className="mt-4 flex items-baseline gap-2">
                        <span className="text-3xl font-bold tracking-tight">
                          {formatCents(price)}
                        </span>
                      </div>
                      <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
                        {plan.session_credits != null && (
                          <li className="flex items-center gap-2">
                            <Check className="h-4 w-4 text-primary" />
                            {plan.session_credits} session{plan.session_credits === 1 ? "" : "s"}
                          </li>
                        )}
                        {plan.kind === "insurance" && (
                          <li className="flex items-center gap-2">
                            <Check className="h-4 w-4 text-primary" />
                            Cover for a year
                          </li>
                        )}
                      </ul>
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
          )}
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
