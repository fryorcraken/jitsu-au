import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/site/StatusPill";
import { CopyButton } from "@/components/site/CopyButton";
import { ClubAccountDetails } from "@/components/site/ClubAccountDetails";
import { lifecycleClass } from "@/lib/status-colours";
import { isTrialUsedUp, membershipStatusLabel, TRIAL_USED_UP_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";
import {
  computeMembershipPrice,
  formatCents,
  insuranceSelection,
  isUnpaid,
  isUtsStudent,
  membershipSearchSchema,
  sellablePlans,
  unpaidInvoices,
  type ClubPaymentDetails,
  type LifecycleStatus,
} from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";
import { CLUB_TIME_ZONE, clubLocalDate } from "@/lib/calendar";
import {
  getMyMemberships,
  getPaymentInstructions,
  listMembershipPlans,
  startMembership,
} from "@/lib/membership.functions";
import { firstWord, subjectVoice } from "@/lib/subject-voice";
import {
  listHouseholdInvoices,
  listMyHousehold,
  type HouseholdInvoices,
  type HouseholdPerson,
} from "@/lib/household.functions";
import { getCodeOfConductSigner } from "@/lib/code-of-conduct.functions";
import type { CodeOfConductState } from "@/lib/code-of-conduct";

export const Route = createFileRoute("/_authenticated/membership")({
  validateSearch: membershipSearchSchema,
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
 * The status card's words for this member.
 *
 * `lapsed` is derived for two different people, and the copy above only fits one
 * of them. Somebody who came to their free classes and used them all has not
 * lapsed and has no membership to renew: nothing of theirs expired, they
 * finished the trial. Which of the two this is comes from `isTrialUsedUp` rather
 * than being decided again here, so the member's card and the manager's pill
 * cannot end up disagreeing about the same person. Only the blurb is this page's
 * own. `memberships` arrives newest first.
 */
function lifecycleCopy(
  lifecycle: LifecycleStatus,
  memberships: { status: string; kind: string | null; sessions_remaining: number | null }[],
) {
  if (isTrialUsedUp(lifecycle, memberships[0]))
    return {
      label: TRIAL_USED_UP_LABEL,
      blurb: "You've used your free trial classes. Pick a plan below to keep training.",
    };
  return LIFECYCLE_COPY[lifecycle];
}

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

/**
 * Which person on the account this page is about.
 *
 * Only rendered when there IS somebody else on the account. For everybody
 * else it would be a control with one option, which is not a choice.
 *
 * It is the FIRST thing under the heading on purpose. A plan bought for the
 * wrong child is an invoice, an email and a membership under the wrong name,
 * and the moment to prevent that is before the plan is picked, not in a confirm
 * afterwards.
 */
function WhoIsThisFor({
  people,
  selectedId,
  onSelect,
}: {
  people: HouseholdPerson[];
  selectedId: string | undefined;
  onSelect: (userId: string | undefined) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm font-medium">Who is this for?</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {people.map((person) => {
          const active = person.is_self ? !selectedId : selectedId === person.user_id;
          return (
            <Button
              key={person.user_id}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              onClick={() => onSelect(person.is_self ? undefined : person.user_id)}
            >
              {person.is_self ? "You" : (firstWord(person.name) ?? "Someone on your account")}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** How a line of an invoice is named when its plan could not be resolved. */
function lineName(planName: string | null) {
  return planName ?? "Membership";
}

/**
 * Everything a member needs to actually pay: the amount, the reference, and the
 * club's account details, on the page instead of in their inbox.
 *
 * The invoice email still goes out exactly as before. This is the copy they can
 * get back to without going hunting through it, which is the whole point: the
 * reference is the thing that reconciles a transfer, and it is the thing people
 * most often come back for while standing in their banking app.
 */
function HowToPay({
  owed,
  details,
  detailsUnreadable,
  showWho,
}: {
  /**
   * Everybody on the account with something outstanding, in household order.
   *
   * A list per person rather than one flat list of invoices: a parent with
   * three children makes three separate transfers with three different
   * references, and the only question they are actually asking this panel is
   * "which one is which".
   */
  owed: HouseholdInvoices[];
  /** Null when the club has not published a complete set of account details. */
  details: ClubPaymentDetails | null;
  /** True when the settings could not be read, which reads differently. */
  detailsUnreadable: boolean;
  /** Name each transfer. False for an account with nobody else on it. */
  showWho: boolean;
}) {
  const transfers = owed.flatMap((person) =>
    person.invoices.map((invoice) => ({ person, invoice })),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>How to pay</CardTitle>
        <CardDescription>
          {transfers.length > 1
            ? "Each of these is a separate transfer. Put its own reference in the description, or we cannot tell which one it pays."
            : "Transfer the amount below and put the reference in the description. We activate the membership as soon as it lands, and email you to confirm."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {transfers.map(({ person, invoice }) => (
          <div key={invoice.reference} className="rounded-lg border bg-muted/30 p-4">
            {showWho && (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                For {person.is_self ? "you" : (person.name ?? "someone on your account")}
              </p>
            )}
            <p className="text-sm font-medium">
              {invoice.lines.map((l) => lineName(l.plan_name)).join(" + ")}
            </p>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Amount
                </dt>
                <dd className="mt-1 text-2xl font-bold tracking-tight">
                  {formatCents(invoice.total_cents)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Payment reference
                </dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-lg font-semibold tracking-wide">
                    {invoice.reference}
                  </span>
                  <CopyButton text={invoice.reference} label="Copy reference" />
                </dd>
              </div>
            </dl>
            {/* A bundle is two invoices on our side and one transfer on theirs.
                Showing the split stops the total reading as a wrong price for
                the plan they picked. */}
            {invoice.lines.length > 1 && (
              <ul className="mt-4 space-y-1 border-t pt-3 text-sm text-muted-foreground">
                {invoice.lines.map((line) => (
                  <li key={line.membership_id} className="flex justify-between gap-4">
                    <span>{lineName(line.plan_name)}</span>
                    <span>{formatCents(line.price_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {/* The amount and reference above are the member's own data and always
            render. Only the club's account details can be missing, and the
            component says which kind of missing it is. */}
        <ClubAccountDetails details={details} unreadable={detailsUnreadable} />

        <p className="text-xs text-muted-foreground">
          Paid already? It can take a day or two to reach us. Nothing to do, we will email you when
          it clears.
        </p>
      </CardContent>
    </Card>
  );
}

function MembershipPage() {
  const navigate = useNavigate();
  const { for: subjectParam } = Route.useSearch();
  const fetchPlans = useServerFn(listMembershipPlans);
  const fetchMine = useServerFn(getMyMemberships);
  const fetchInstructions = useServerFn(getPaymentInstructions);
  const fetchHousehold = useServerFn(listMyHousehold);
  const fetchOwed = useServerFn(listHouseholdInvoices);
  const start = useServerFn(startMembership);

  // WHO this page is about. Absent means the account holder, which is what
  // every visit was before a family could share a login. It only ever names
  // somebody the server will allow: `getMyMemberships` and `startMembership`
  // both run the household gate on it, so a hand-typed id buys nothing.
  const [household, setHousehold] = useState<HouseholdPerson[]>([]);
  const [owed, setOwed] = useState<HouseholdInvoices[]>([]);
  const subjectId = subjectParam;
  const subject = household.find((p) => p.user_id === subjectId) ?? null;
  const dependants = household.filter((p) => !p.is_self);
  const voice = subjectVoice(subject && !subject.is_self ? firstWord(subject.name) : null);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [mine, setMine] = useState<Mine | null>(null);
  const [account, setAccount] = useState<{
    details: ClubPaymentDetails | null;
    unreadable: boolean;
  }>({ details: null, unreadable: false });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [studentNumber, setStudentNumber] = useState("");
  const [sessionDate, setSessionDate] = useState(() => new Date().toISOString().slice(0, 10));
  // The insurance checkbox is not raw state: it starts from the rules in
  // `insuranceSelection` and is only editable while the member has cover.
  const [insuranceTicked, setInsuranceTicked] = useState<boolean | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  // Set after a purchase that needs paying: the "how to pay" panel sits above
  // the plan the member just chose, which on a phone is well off screen.
  const [scrollToPay, setScrollToPay] = useState(false);
  const payRef = useRef<HTMLDivElement | null>(null);

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
      return Promise.all([
        fetchPlans(),
        fetchMine({ data: subjectId ? { userId: subjectId } : {} }),
        // The club's account details are the one thing here the member cannot
        // supply themselves, but they are also the one thing that is not their
        // own data: a failure degrades this panel into "we could not load
        // these" instead of failing the whole page.
        fetchInstructions().catch((e) => {
          console.error("[membership] club account details failed to load:", e);
          return { ok: false, details: null };
        }),
        // Who is on this account, and what the whole account still owes. Both
        // are about the caller rather than the subject, so switching person
        // does not re-ask them for a different answer.
        fetchHousehold(),
        fetchOwed(),
      ]).then(([p, m, s, people, outstanding]) => {
        setPlans(p);
        setMine(m);
        setHousehold(people);
        setOwed(outstanding);
        setAccount({ details: s.details, unreadable: !s.ok });
        // Prefill the student number from the member's waiver so they don't
        // retype it (blank there means they never gave one).
        if (m.uts_student_number) setStudentNumber(m.uts_student_number);
        // Handed back as well as stored: `choose` needs to know what the member
        // owes NOW, and reading it out of state would still see the old value.
        return m;
      });
    },
    [fetchPlans, fetchMine, fetchInstructions, fetchHousehold, fetchOwed, subjectId],
  );

  // `reload()` on its own runs after choosing a plan, where that handler
  // reports its own failure; this is the one the page loads through.
  const load = useMemo(
    () => () => {
      setLoading(true);
      return reload()
        .then(() => setLoadError(null))
        .catch((e) => {
          const message = describeLoadError(e, "Could not load your membership");
          setLoadError(message);
          toast.error(message);
        })
        .finally(() => setLoading(false));
    },
    [reload],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Runs after the panel has rendered, so the ref is attached by the time we
  // reach for it. A member who ends up with nothing to pay just clears the flag.
  //
  // `?.` on the method too: this is a convenience on top of a panel that is
  // already on screen, and an environment without `scrollIntoView` must lose the
  // scroll, not throw out of an effect and take the whole page with it.
  useEffect(() => {
    if (!scrollToPay) return;
    payRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    setScrollToPay(false);
  }, [scrollToPay]);

  async function choose(plan: Plan) {
    setPendingCode(plan.code);
    try {
      await start({
        data: {
          plan_code: plan.code,
          is_student: isStudent,
          uts_student_number: studentNumber.trim(),
          session_date: plan.kind === "session" ? sessionDate : "",
          include_insurance: plan.kind !== "insurance" ? insuranceIncluded : false,
          // WHO the plan is for. Absent buys for the account holder, exactly as
          // before; named, it buys for one of their children and the invoice,
          // the reference and the membership all land under that child.
          userId: subjectId,
          hp: "",
        },
      });
      setInsuranceTicked(null);
      const refreshed = await reload();
      // What they owe after the purchase, not whether the plan itself activated:
      // a free plan bought with insurance bundled activates AND leaves an
      // invoice, and "you're all set" is the wrong thing to tell someone who
      // still has to transfer money.
      if (unpaidInvoices(refreshed.memberships).length > 0) {
        // The details are now on this page, above the plan they just picked, so
        // send them there rather than to their inbox. The email still goes out.
        toast.success(
          voice.isSelf
            ? "Your invoice is ready. The payment details are at the top of this page."
            : `${voice.Whose} invoice is ready. The payment details are at the top of this page.`,
        );
        setScrollToPay(true);
      } else {
        toast.success(
          voice.isSelf
            ? "You're all set. Your membership is active."
            : `All set. ${voice.Whose} membership is active.`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start membership");
    } finally {
      setPendingCode(null);
    }
  }

  if (loading) return <Loading className="p-8" />;

  // In place of the page, not beside it. With nothing loaded the status card
  // falls back to "lead" and greets a paid-up member as somebody new, and the
  // plan list would be empty, which reads as a club with nothing to sell.
  if (loadError)
    return (
      <section className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-3xl font-black">Membership</h1>
        <LoadFailure
          className="mt-6"
          what="Your membership"
          message={loadError}
          hint="Nothing has changed, and anything you have already paid for is still yours."
          onRetry={() => void load()}
        />
        <Button asChild variant="outline" className="mt-4">
          <Link to="/account">Back to account</Link>
        </Button>
      </section>
    );

  const lifecycle = mine?.lifecycle ?? "lead";
  const status = lifecycleCopy(lifecycle, mine?.memberships ?? []);
  // What the member still owes, as transfers rather than as rows: a bundled
  // plan + insurance is two memberships behind one reference and one payment.
  const unpaid = unpaidInvoices(mine?.memberships ?? []);

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
              {voice.isSelf
                ? "Pick a plan, pay by bank transfer, and you're on the mat."
                : `Pick a plan for ${voice.who}, pay by bank transfer, and they're on the mat.`}
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>

        {/* Only for an account that has somebody else on it. */}
        {dependants.length > 0 && (
          <WhoIsThisFor
            people={household}
            selectedId={subjectId}
            onSelect={(next) =>
              // Through the URL rather than component state, so the choice
              // survives a reload and can be linked to from a child's page.
              void navigate({ to: "/membership", search: next ? { for: next } : {} })
            }
          />
        )}

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <CardTitle>{voice.isSelf ? "Your status" : `${voice.Whose} status`}</CardTitle>
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
                      {/* Not "Valid until": a plan sold as a number of classes
                          has no date to be valid until, and this cell counts
                          for it instead. */}
                      <th className="px-3 py-2">Ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.memberships.map((m) => (
                      <tr key={m.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{m.plan_name ?? "—"}</td>
                        <td className="px-3 py-2">{membershipStatusLabel(m)}</td>
                        <td className="px-3 py-2">{formatCents(m.price_cents)}</td>
                        <td className="px-3 py-2">
                          {isUnpaid(m) ? (
                            <span className="font-mono text-xs">{m.payment_reference}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {/* A plan sold as a number of classes has no date to
                              run out on, so this column counts instead. */}
                          {m.ends_at
                            ? new Date(m.ends_at).toLocaleDateString("en-AU")
                            : m.sessions_remaining != null
                              ? `${m.sessions_remaining} session${m.sessions_remaining === 1 ? "" : "s"} left`
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
            </CardContent>
          )}
        </Card>

        {/* `scroll-mt-20` clears the member-space header (`sticky top-0 h-14`),
            which would otherwise sit over the card's title once the scroll after
            a purchase lands. */}
        {/* The WHOLE account's outstanding transfers, not just the person on
            screen: a parent switching between children to see what each owes
            would be a worse version of a list they can read at once. Falls back
            to the subject's own when the household read failed, so a broken
            extra never hides an invoice the member has to pay. */}
        {(owed.length > 0 || unpaid.length > 0) && (
          <div ref={payRef} className="scroll-mt-20">
            <HowToPay
              owed={
                owed.length > 0
                  ? owed
                  : [{ user_id: subjectId ?? "", name: null, is_self: true, invoices: unpaid }]
              }
              details={account.details}
              detailsUnreadable={account.unreadable}
              showWho={dependants.length > 0}
            />
          </div>
        )}

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
                    {/* No credit cap on a training period means unlimited mat
                        time for its dates, which is the main thing being
                        bought. Saying nothing at all read as an omission. */}
                    {plan.session_credits == null && plan.kind === "period" && (
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        Unlimited classes
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
