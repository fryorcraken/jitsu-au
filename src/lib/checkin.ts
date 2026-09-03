// Pure check-in logic: what covers a class, and which class is on right now.
//
// Side-effect free and server-import free (no supabase, no process.env) so the
// two rules that matter can be unit-tested without a database: the precedence
// order that decides whose credit gets spent, and the "which class did you mean"
// default that a manager relies on at the door.
//
// The same `resolveCoverage` runs in the browser to preview what will be spent
// and on the server to actually spend it, so the warning a manager reads and the
// credit that moves can never disagree.
import { CLUB_TIME_ZONE, clubLocalDate } from "./calendar";
import { membershipStatusLabel } from "./status-labels";
import { isUnpaid } from "./validation";
import type { CheckInWarning, CoverageSource } from "./validation";

/** A person's membership joined to its plan, as coverage resolution reads it. */
export type CoverageCandidate = {
  id: string;
  /** `membership_plans.kind` — widened to string by the generated DB types. */
  kind: string;
  plan_name: string | null;
  /** `memberships.status` — widened to string by the generated DB types. */
  status: string;
  price_cents: number;
  /** When a payment was recorded against it, if one has been. */
  paid_at: string | null;
  sessions_remaining: number | null;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
};

export type CoverageDecision = {
  membership_id: string | null;
  coverage: CoverageSource;
  plan_name: string | null;
  consumes_credit: boolean;
  /** The chosen membership's credits BEFORE, and the compare-and-set guard. */
  sessions_remaining_before: number | null;
  /** Credits AFTER, or null when nothing is consumed. */
  sessions_remaining_after: number | null;
  /** True when this takes the last credit, so the membership finishes. */
  closes_membership: boolean;
  warnings: CheckInWarning[];
};

/** Ascending, treating null as "after everything" rather than as zero. */
function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function endsAtMs(m: CoverageCandidate): number | null {
  return m.ends_at ? new Date(m.ends_at).getTime() : null;
}

/**
 * A membership whose entitlement is a BALANCE, not a window: no end date, and a
 * count of credits. The free trial and a casual pass are exactly this — "two
 * free classes, ever, no expiry".
 *
 * **No date gates these.** Someone having trained is a fact that already
 * happened, and paperwork catching up afterwards cannot unmake it: a waiver
 * signed at the door after the class started, or filed from paper a week later,
 * must still be payable by the credits it earned. What limits a balance is the
 * balance. So `starts_at` is not consulted for them at all, and a credit can pay
 * for a class held before the membership row existed.
 *
 * Credits are what make it a balance, so that is what this reads — a future
 * credit pack under some new kind works with no change here. Two shapes are
 * excluded, and both are shapes the database still permits because
 * `savePlanSchema` and the manager agent API do not run `planShapeError`:
 *   - **A `period` plan is never a balance**, however many credits are hung off
 *     it. Its dates ARE the entitlement, and the period tier spends nothing, so
 *     an undated one treated as a balance would cover every class the club has
 *     ever held, free and unwarned.
 *   - **Neither dates nor credits** is the malformed shape
 *     docs/memberships.md warns about. There is nothing to spend, so there is
 *     nothing to pay with.
 */
function isOpenBalance(m: CoverageCandidate): boolean {
  if (m.kind === "period") return false;
  return m.ends_at === null && m.sessions_remaining !== null;
}

/**
 * Active, dated, and the class ran before the window it was bought for. Only
 * ever asked of a DATED membership — a training period is a range of days, so
 * the range IS what was purchased. Kept as its own predicate because it is also
 * a DIAGNOSIS: a manager staring at "No cover" should be told the membership
 * starts later, not left to work it out.
 */
function startsAfter(m: CoverageCandidate, atMs: number): boolean {
  return (
    m.status === "active" &&
    !isOpenBalance(m) &&
    Boolean(m.starts_at) &&
    new Date(m.starts_at as string).getTime() > atMs
  );
}

/**
 * Is this membership live at instant `atMs`? Active status is not enough: there
 * is no expiry job anywhere in this app, so a semester that finished in June
 * still reads `status = 'active'` today. Trusting the status alone would keep
 * covering classes for months after the money ran out.
 *
 * Dates are asked only of a membership that was SOLD as a range of days. A
 * credit balance is never gated on one — see `isOpenBalance`.
 */
function isLive(m: CoverageCandidate, atMs: number): boolean {
  if (m.status !== "active") return false;
  if (startsAfter(m, atMs)) return false;
  const ends = endsAtMs(m);
  return ends === null || ends >= atMs;
}

function hasCredits(m: CoverageCandidate): boolean {
  return m.sessions_remaining !== null && m.sessions_remaining > 0;
}

/**
 * Pick the membership that runs out soonest, so nothing expires unused: fewest
 * credits left, then the earliest end date, then the oldest. Fully deterministic
 * (down to the id) so a retry, or a second manager, reaches the same row.
 */
function soonestToRunOut(a: CoverageCandidate, b: CoverageCandidate): number {
  const byCredits = nullsLast(a.sessions_remaining, b.sessions_remaining);
  if (byCredits !== 0) return byCredits;
  const byEnd = nullsLast(endsAtMs(a), endsAtMs(b));
  if (byEnd !== 0) return byEnd;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * What pays for this class, and what that costs them.
 *
 * Precedence, highest first:
 *   1. A **free trial** with credits left. The trial is the club's promise
 *      ("your first two sessions, free"): if an unlimited pass swallowed one,
 *      the member has effectively paid for something they were given, and the
 *      club loses the number its funnel is judged on.
 *   2. Any other **credit** membership (a casual pass). A credit is a finite
 *      prepaid balance with its own lifetime; an unlimited membership costs
 *      nothing extra to draw on. Spending the finite thing first is the only
 *      order in which a pass bought before a semester does not quietly die
 *      unused.
 *   3. An unlimited **period** membership, which absorbs what nothing else
 *      covers and is never used up.
 *   4. Nothing. `insurance` never covers a class — it is affiliation, not mat
 *      time — and neither does a pending, expired or cancelled membership.
 *
 * `at` is the CLASS's start instant, not the current time, so a manager checking
 * people in ten minutes late (or fixing yesterday's roster this morning) gets
 * the same answer they would have got at the door.
 */
export function resolveCoverage(input: {
  memberships: CoverageCandidate[];
  at: string;
  /**
   * Restrict the choice to one membership (a manager overriding which one
   * absorbs a check-in). Warnings are still read off the whole set, so the
   * override does not hide what else is wrong with their account.
   */
  only?: string;
}): CoverageDecision {
  const atMs = new Date(input.at).getTime();
  const eligible = input.only
    ? input.memberships.filter((m) => m.id === input.only)
    : input.memberships;
  const live = eligible.filter((m) => isLive(m, atMs));

  const warnings: CheckInWarning[] = [];
  // Diagnoses, gathered whether or not they end up mattering: they are what
  // turns "no cover" from a dead end into something a manager can act on.
  const endedButActive = (m: CoverageCandidate) =>
    m.status === "active" && endsAtMs(m) !== null && (endsAtMs(m) as number) < atMs;
  if (input.memberships.some(endedButActive)) warnings.push("membership_ended");
  if (input.memberships.some((m) => isLive(m, atMs) && m.sessions_remaining === 0))
    warnings.push("credits_exhausted");
  // "They are training on an invoice nobody has paid." This used to key on
  // `status === "pending"`, back when raising a membership left it waiting for
  // money and being authorised meant it had arrived. Now that authorising and
  // paying are separate, an unpaid member is `active` like everyone else, and a
  // status check would warn about nobody at all — which is exactly when the door
  // most needs telling.
  if (input.memberships.some(isUnpaid)) warnings.push("payment_pending");

  const tiers: { source: CoverageSource; pool: CoverageCandidate[] }[] = [
    { source: "trial", pool: live.filter((m) => m.kind === "trial" && hasCredits(m)) },
    {
      source: "session",
      // Deliberately "credit-bearing and not a trial/period/insurance plan"
      // rather than `kind === 'session'`, so a future pack under a new kind
      // works without a code change.
      pool: live.filter(
        (m) => hasCredits(m) && m.kind !== "trial" && m.kind !== "period" && m.kind !== "insurance",
      ),
    },
    { source: "period", pool: live.filter((m) => m.kind === "period") },
  ];

  for (const tier of tiers) {
    const chosen = [...tier.pool].sort(soonestToRunOut)[0];
    if (!chosen) continue;
    if (tier.source === "period") {
      return {
        membership_id: chosen.id,
        coverage: "period",
        plan_name: chosen.plan_name,
        consumes_credit: false,
        sessions_remaining_before: chosen.sessions_remaining,
        sessions_remaining_after: null,
        closes_membership: false,
        warnings,
      };
    }
    const before = chosen.sessions_remaining as number;
    const after = before - 1;
    if (after === 0) warnings.push("last_credit");
    return {
      membership_id: chosen.id,
      coverage: tier.source,
      plan_name: chosen.plan_name,
      consumes_credit: true,
      sessions_remaining_before: before,
      sessions_remaining_after: after,
      closes_membership: after === 0,
      warnings,
    };
  }

  // Purely a DIAGNOSIS of "no cover", which is why it is pushed here and not up
  // with the others: holding a membership that starts later is perfectly normal
  // (pre-buying next training period does exactly that), so saying so beside a
  // green covered pill — and freezing it into `session_checkins.warnings` — would
  // be noise. It only ever earns its place when nothing paid for the class.
  if (input.memberships.some((m) => startsAfter(m, atMs))) warnings.push("not_started");
  warnings.push("no_cover");
  return {
    membership_id: null,
    coverage: "none",
    plan_name: null,
    consumes_credit: false,
    sessions_remaining_before: null,
    sessions_remaining_after: null,
    closes_membership: false,
    warnings,
  };
}

/**
 * Memberships still marked active whose end date has passed, so a check-in can
 * close them on sight. Nothing else in this app enforces an end date, so this is
 * where a finished semester finally stops reading as current.
 *
 * Keyed off the real clock, never off a class's start instant: pre-marking a
 * roster for next month must not expire anything early.
 */
export function lapsedMembershipIds(memberships: CoverageCandidate[], now: string): string[] {
  const nowMs = new Date(now).getTime();
  return memberships
    .filter((m) => m.status === "active" && m.ends_at && new Date(m.ends_at).getTime() < nowMs)
    .map((m) => m.id);
}

/**
 * The badge a manager reads before pressing the button. Takes the fields rather
 * than a whole decision so the check-in screen can label a roster row with the
 * same function that labels a decision, and the two can never word it
 * differently.
 */
export function coveragePreviewLabel(input: {
  coverage: string;
  plan_name: string | null;
  consumes_credit: boolean;
  sessions_remaining_before: number | null;
}): string {
  if (input.coverage === "none") return "No cover";
  const plan = input.plan_name ?? "Membership";
  if (!input.consumes_credit) return plan;
  return `${plan}, ${input.sessions_remaining_before ?? 0} left`;
}

/**
 * The memberships a manager may attach an uncovered check-in to, with the
 * unusable ones labelled rather than hidden — "finished" is the answer to "why
 * can't I pick that one?". Each is asked the real question, by running the same
 * resolution restricted to it, so the list cannot claim a membership is usable
 * when attaching it would resolve to nothing.
 */
export function attachableMemberships(candidates: CoverageCandidate[], at: string) {
  const atMs = new Date(at).getTime();
  return candidates.map((m) => {
    const decision = resolveCoverage({ memberships: candidates, at, only: m.id });
    return {
      id: m.id,
      plan_name: m.plan_name,
      status: m.status,
      sessions_remaining: m.sessions_remaining,
      usable: decision.coverage !== "none",
      reason:
        decision.coverage !== "none"
          ? null
          : m.status !== "active"
            ? // Lower-cased on purpose: this reason is read as prose beside the
              // others below ("Free trial · 0 left · used up"), not as a status
              // pill, so it must not arrive title-cased mid-sentence.
              membershipStatusLabel(m).toLowerCase()
            : m.sessions_remaining === 0
              ? "no credits left"
              : startsAfter(m, atMs)
                ? "starts after this class"
                : "not valid for this class",
    };
  });
}

export type PickableEvent = { id: string; starts_at: string; status: string };

/**
 * The event nearest `nowMs`, measured in both directions. `preferFuture` only
 * breaks an exact tie; otherwise the earlier start wins so the order is stable.
 */
function closestByStart<T extends PickableEvent>(
  events: T[],
  nowMs: number,
  preferFuture: boolean,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const e of events) {
    const startMs = new Date(e.starts_at).getTime();
    const distance = Math.abs(startMs - nowMs);
    if (distance < bestDistance) {
      best = e;
      bestDistance = distance;
      continue;
    }
    if (distance !== bestDistance || !best) continue;
    const bestMs = new Date(best.starts_at).getTime();
    const takeIt = preferFuture ? startMs > bestMs : startMs < bestMs;
    if (takeIt) best = e;
  }
  return best;
}

/**
 * The class the check-in screen should open on: today's, or the nearest one.
 *
 * "Today" is today **at the club** (Australia/Sydney), not in UTC — at 09:00 in
 * Sydney the UTC date is still yesterday, which would put every morning class on
 * the wrong day. Distance is measured in both directions because at 20:15 the
 * class being checked in is the 18:00 that just finished, not tomorrow's.
 *
 * Cancelled events are never offered: you cannot check people in to a class that
 * did not run.
 */
export function pickDefaultEvent<T extends PickableEvent>(
  events: T[],
  now: Date | string,
  timeZone: string = CLUB_TIME_ZONE,
): T | null {
  const nowDate = typeof now === "string" ? new Date(now) : now;
  const nowMs = nowDate.getTime();
  const scheduled = events.filter((e) => e.status !== "cancelled");
  if (scheduled.length === 0) return null;

  const today = clubLocalDate(nowDate, timeZone);
  const onToday = scheduled.filter((e) => clubLocalDate(new Date(e.starts_at), timeZone) === today);
  if (onToday.length > 0) return closestByStart(onToday, nowMs, false);

  // No class today: a manager opening the screen is more likely setting up for
  // the next one than fixing the last one, so an exact tie goes to the future.
  return closestByStart(scheduled, nowMs, true);
}

/**
 * What a roster row shows to tell one child from another at the door, and what
 * it deliberately withholds about everybody else.
 *
 * The club takes children, so a search for a surname -- or, since the roster's
 * contact address resolves through the guardian, for a parent's email --
 * returns every sibling at once. Picking the wrong one files a class against
 * the wrong child: their attendance, their credit, their grading record.
 *
 * `guardian_name` says which family; `age` is the one that separates two
 * children IN that family, which a parent's name cannot do.
 *
 * ## Why an age and not the date of birth
 *
 * An age answers the door's actual question -- which of these two is the child
 * in front of me -- because a child's apparent age is the thing a manager can
 * see. A full date of birth answers it no better: two siblings far enough apart
 * to be told apart by their birthdays are told apart by their ages, and twins
 * are told apart by neither.
 *
 * What it costs is nothing, and what it saves is that a child's date of birth
 * never crosses the wire, never reaches a browser, and never enters the roster
 * the screen keeps on the device (`checkin-cache.ts`). A date of birth is an
 * identity-document field; an age is not. This screen is a tablet in the
 * entrance of a public hall, so the difference is worth having.
 *
 * The withholding is the rule worth keeping in one place: an age is carried for
 * a dependant and for nobody else, because an ordinary member's answers no
 * question at the door. Being a dependant is what makes it answer one, and
 * `guardianName` is how this module knows: set for a dependant, null otherwise.
 */
export function rosterHouseholdFields(input: {
  guardianName: string | null;
  dateOfBirth: string | null;
  /** Injected so the rule is testable without freezing the clock. */
  now?: Date;
}): { guardian_name: string | null; age: number | null } {
  const isDependant = input.guardianName != null;
  return {
    guardian_name: input.guardianName,
    age: isDependant ? ageOn(input.dateOfBirth, input.now ?? new Date()) : null,
  };
}

/**
 * Whole years from `dateOfBirth` to `now`, or null when there is no usable date.
 *
 * Not derived from a day count: a leap year makes that wrong by a day around a
 * birthday, and "10" turning into "9" on the wrong morning is exactly the kind
 * of small wrongness a manager stops trusting the column over.
 */
function ageOn(dateOfBirth: string | null, now: Date): number | null {
  if (!dateOfBirth) return null;
  const born = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - born.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1;
  return age >= 0 ? age : null;
}
