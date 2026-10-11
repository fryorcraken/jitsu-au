// Manager: raise a membership for the person whose page this is.
//
// The counterpart to a member pressing "Choose" on /membership, and it lands the
// same thing: for a priced plan, a PENDING invoice carrying the payment
// reference they would quote on a transfer, so it reconciles off a bank
// statement exactly like one they raised themselves. Activating stays the
// separate press it already was, because activating emails them and grants the
// member label. A free plan (the trial) has nothing to wait for and activates
// immediately, again matching what a member gets.
//
// Two choices exist here that a member never gets, and both are for the same
// case — a manager writing down an enrolment that already happened:
//
//   - the email can be turned off, so backfilling last semester does not invoice
//     anybody for it;
//   - insurance is a real choice rather than a requirement, because an enrolment
//     that genuinely happened without cover is history, not a sale.
//
// Plans no longer on sale are offered under their own heading, since backfilling
// a past training period is most of what this is for, but a manager should never
// pick one by accident.
//
// The rate is a choice the manager makes on screen, with the price written on
// each side of it. It used to be a side effect of a free-text box below the
// plan list: type a number and the invoice quietly came out at the student
// rate, while every price on the panel still said the public one, and a box that
// started empty invoiced a UTS student the public rate unless the manager copied
// their number across by hand. Now the plan list shows both prices, the student
// rate is preselected when their record holds a number, and the number sits
// inside that choice as what it is: the evidence for it, required to pick it.
//
// The server is unchanged and still decides: a number means the student rate,
// none means public (`isUtsStudent`). So picking public sends no number, and
// picking student refuses to submit without one rather than invoicing at the
// public rate with the student option visibly ticked.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { cn } from "@/lib/utils";
import {
  clubToday,
  formatCents,
  isUtsStudent,
  planStartIsChoosable,
  sellablePlans,
} from "@/lib/validation";
import { createMembership, listAllMembershipPlans } from "@/lib/membership.functions";

type Plan = Awaited<ReturnType<typeof listAllMembershipPlans>>[number];

type Rate = "student" | "public";

/** Both prices where a plan has two, so the list reads the same before any choice. */
function planLabel(plan: Plan): string {
  const publicPrice = formatCents(plan.public_price_cents);
  if (plan.student_price_cents == null) return `${plan.name} (${publicPrice})`;
  return `${plan.name} (${publicPrice}, students ${formatCents(plan.student_price_cents)})`;
}

export function AddMembershipCard({
  userId,
  studentNumberOnFile,
  onAdded,
}: {
  userId: string;
  /** The UTS student number on their record, if any. Prefills the box. */
  studentNumberOnFile: string | null;
  onAdded: () => Promise<unknown>;
}) {
  const fetchPlans = useServerFn(listAllMembershipPlans);
  const create = useServerFn(createMembership);
  const send = useResilientSubmit<{ ok: true; reference: string | null }>(INTAKE_SUBMIT);

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [planCode, setPlanCode] = useState("");
  const [studentNumber, setStudentNumber] = useState("");
  const [rate, setRate] = useState<Rate>("public");
  const [sessionDate, setSessionDate] = useState("");
  // Prefilled with today rather than left blank, because today is the answer
  // almost every time and an empty date field asks a question nobody had.
  //
  // `startsOnSet` is what makes the prefill safe. Re-raising the same plan
  // resolves back to the existing unpaid invoice and MOVES its window to the
  // date sent, so a card that always sent its default would silently drag a
  // deliberately backdated invoice forward to today the next time a manager
  // opened this panel to fix something else. Untouched means "no opinion", which
  // for a new membership is today anyway. Correcting one that already exists is
  // the Start date button on its row, where the field opens on the date it holds.
  const [startsOn, setStartsOn] = useState(() => clubToday());
  const [startsOnSet, setStartsOnSet] = useState(false);

  // Abandoning an edit has to put the date back to "no opinion" too, or the
  // guard only holds in one direction: a manager who typed February, thought
  // better of it and closed the panel would come back to a field still showing
  // February and still marked as set, and the next unrelated raise would carry
  // it. Same for switching plans — a date chosen for one plan is not an answer
  // about another.
  function forgetStartDate() {
    setStartsOn(clubToday());
    setStartsOnSet(false);
  }
  const [includeInsurance, setIncludeInsurance] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || plans || plansError) return;
    fetchPlans()
      .then((rows) => setPlans(rows as Plan[]))
      .catch((e) =>
        setPlansError(e instanceof Error ? e.message : "We could not load the plan list."),
      );
  }, [open, plans, plansError, fetchPlans]);

  const now = new Date().toISOString();
  const onSale = plans ? sellablePlans(plans, now) : [];
  const onSaleCodes = new Set(onSale.map((p) => p.code));
  const retired = (plans ?? []).filter((p) => !onSaleCodes.has(p.code));
  const chosen = (plans ?? []).find((p) => p.code === planCode) ?? null;
  // The same question the server asks, asked of the plan's own window rather
  // than of its kind, so the field appears exactly where a date would change
  // something. A training period's dates belong to the plan, and a class-credit
  // plan has no window to place.
  const startIsChoosable = chosen ? planStartIsChoosable(chosen) : false;
  const onFile = studentNumberOnFile?.trim() || "";
  // Only a plan with a student price asks which rate. On any other plan the
  // number changes nothing about the price, and is sent only so the invoice
  // records the same thing a member's own purchase would.
  const hasStudentRate = chosen?.student_price_cents != null;
  const sentNumber = rate === "student" ? studentNumber.trim() || null : null;
  const missingNumber = hasStudentRate && rate === "student" && !isUtsStudent(studentNumber);

  async function submit() {
    if (!planCode || missingNumber) return;
    const outcome = await send.submit({
      run: async (signal) => {
        const res = await create({
          signal,
          data: {
            user_id: userId,
            plan_code: planCode,
            uts_student_number: sentNumber,
            session_date: sessionDate || null,
            // Sent only where it means something: the server refuses a start
            // date on a plan that has none, and sending today's date for every
            // casual class would turn that guard into a wall.
            starts_on: startIsChoosable && startsOnSet ? startsOn || null : null,
            include_insurance: includeInsurance,
            send_email: sendEmail,
          },
        });
        if (!res?.ok) throw new Error("That membership was not raised. Try again.");
        return res;
      },
    });
    if (outcome.ok) {
      // Keep the panel open on the fresh list: raising two invoices in a row
      // (a training period and a casual class) is a normal afternoon.
      setPlanCode("");
      setSessionDate("");
      forgetStartDate();
      await onAdded();
    }
  }

  function openPanel() {
    // Taken from the record each time the panel opens rather than once, so a
    // number edited for one invoice does not quietly ride on the next, and a
    // number added to their profile since is picked up.
    setStudentNumber(onFile);
    setRate(onFile ? "student" : "public");
    setOpen(true);
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={openPanel}>
        Add a membership
      </Button>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">Add a membership</h3>
          <p className="text-sm text-muted-foreground">
            This raises an invoice, the same as if they had chosen the plan themselves. A plan with
            a price stays pending until you press Activate; a free plan starts straight away.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            forgetStartDate();
          }}
        >
          Close
        </Button>
      </div>

      {plansError ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive">{plansError}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setPlansError(null);
              setPlans(null);
            }}
          >
            Try again
          </Button>
        </div>
      ) : !plans ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading the plan list...
        </p>
      ) : plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no membership plans yet, so there is nothing to put anyone on.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="add-plan">Plan</Label>
            <select
              id="add-plan"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
              value={planCode}
              onChange={(e) => {
                setPlanCode(e.target.value);
                forgetStartDate();
              }}
            >
              <option value="">Choose a plan...</option>
              {onSale.length > 0 && (
                <optgroup label="On sale">
                  {onSale.map((p) => (
                    <option key={p.code} value={p.code}>
                      {planLabel(p)}
                    </option>
                  ))}
                </optgroup>
              )}
              {retired.length > 0 && (
                <optgroup label="No longer on sale">
                  {retired.map((p) => (
                    <option key={p.code} value={p.code}>
                      {planLabel(p)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {chosen?.student_price_cents != null && (
            <fieldset className="space-y-3 sm:col-span-2">
              <legend className="mb-2 text-sm font-medium">Rate</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="add-rate"
                  className="mt-1"
                  checked={rate === "student"}
                  onChange={() => setRate("student")}
                />
                <span>
                  Student rate, {formatCents(chosen.student_price_cents)}
                  <span className="block text-xs text-muted-foreground">
                    For a UTS student. Needs their student number, which goes on the invoice.
                  </span>
                </span>
              </label>
              {rate === "student" && (
                <div className="ml-6 max-w-sm space-y-2">
                  <Label htmlFor="add-student-number">UTS student number</Label>
                  <Input
                    id="add-student-number"
                    value={studentNumber}
                    onChange={(e) => setStudentNumber(e.target.value)}
                    aria-invalid={missingNumber || undefined}
                    aria-describedby="add-student-number-hint"
                  />
                  <p
                    id="add-student-number-hint"
                    className={cn(
                      "text-xs",
                      missingNumber ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {studentNumberHint(onFile, studentNumber.trim())}
                  </p>
                </div>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="add-rate"
                  className="mt-1"
                  checked={rate === "public"}
                  onChange={() => setRate("public")}
                />
                <span>Public rate, {formatCents(chosen.public_price_cents)}</span>
              </label>
            </fieldset>
          )}

          {/* Only a casual class reconciles per session, so this only appears
              for one. Every other plan kind ignores it. */}
          {chosen?.kind === "session" && (
            <div className="space-y-2">
              <Label htmlFor="add-session-date">Class date</Label>
              <Input
                id="add-session-date"
                type="date"
                value={sessionDate}
                onChange={(e) => setSessionDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Defaults to today, so each drop-in payment reconciles to its own class.
              </p>
            </div>
          )}

          {/* Only a plan that runs for a fixed number of days has a start to
              place: the yearly insurance. Everyone who buys a training period
              gets its dates, and a class-credit plan ends with its classes. */}
          {startIsChoosable && (
            <div className="space-y-2">
              <Label htmlFor="add-starts-on">Start date</Label>
              <Input
                id="add-starts-on"
                type="date"
                value={startsOn}
                onChange={(e) => {
                  setStartsOn(e.target.value);
                  setStartsOnSet(true);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Defaults to today. Set it back when you are writing down cover that really began
                earlier; it runs {chosen?.duration_days ?? 365} days from whatever you pick.
              </p>
            </div>
          )}

          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={includeInsurance}
              onChange={(e) => setIncludeInsurance(e.target.checked)}
            />
            <span>
              Add yearly insurance as a second invoice
              <span className="block text-xs text-muted-foreground">
                Rides on the same payment reference, so one transfer covers both. Leave it off when
                you are recording an enrolment that really did happen without cover.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
            />
            <span>
              Email them the payment instructions
              <span className="block text-xs text-muted-foreground">
                Turn this off when you are backfilling something already settled, so nobody is
                invoiced for last semester.
              </span>
            </span>
          </label>

          <div className="space-y-3 sm:col-span-2">
            <Button
              onClick={() => void submit()}
              disabled={!planCode || missingNumber || send.busy}
            >
              {send.busy ? "Adding..." : "Add membership"}
            </Button>
            <SubmitStatus
              status={send.status}
              attempt={send.attempt}
              attempts={send.attempts}
              error={send.error}
              failureKind={send.failureKind}
              onRetry={() => void submit()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Where the number came from, or what is missing. */
function studentNumberHint(onFile: string, typed: string): string {
  if (!typed)
    return "Add their UTS student number to use the student rate, or choose the public rate.";
  if (onFile && typed === onFile) return "From their profile.";
  if (onFile) return `For this invoice only. Their profile still says ${onFile}.`;
  return "For this invoice only. Their profile has no student number.";
}
