// What the club CALLS each status on screen. The naming counterpart to
// `status-colours.ts`, which owns what one looks like, and read by the same
// screens: `/membership`, `/manager/users`, a person's manager page,
// `/manager/memberships` and the check-in board.
//
// It exists because `memberships.status = 'expired'` is one stored word for two
// different endings. A training period or a year of insurance really does
// expire: a date passed and the thing is over. A free trial or a class pack
// cannot. It holds a NUMBER of classes, and it ends when they are used up. We
// were telling a member their two free classes had gone out of date, which is
// not something that can happen to them, and telling a manager the same word for
// "the semester finished" and "they came twice and stopped" — two people who
// need completely different follow-ups.
//
// The stored vocabulary is deliberately untouched: `expired` and `lapsed` are
// what the database, the manager agent API and every filter still speak. Only
// the words a human reads change, which is why this is a display module and not
// a migration.
//
// Every label comes out ready to render, sentence case included, so callers pass
// `preserveCase` to `<Pill>`. CSS `capitalize` would title-case a two-word label
// into "Used Up".
import { endsWithCredits } from "./validation";
import type { LifecycleStatus, MembershipStatus } from "./validation";

// Keyed by their unions, so adding a status fails to compile until it has been
// given a word, exactly as the colour maps do.
const MEMBERSHIP: Record<MembershipStatus, string> = {
  pending: "Pending",
  active: "Active",
  expired: "Expired",
  cancelled: "Cancelled",
};

const LIFECYCLE: Record<LifecycleStatus, string> = {
  lead: "Lead",
  applicant: "Applicant",
  visitor: "Visitor",
  member: "Member",
  lapsed: "Lapsed",
};

/** The one phase label that is not simply its status capitalised. */
export const TRIAL_USED_UP_LABEL = "Trial used up";

/** What the label layer needs to know about one enrolment. */
export type LabelledMembership = {
  status: string;
  /** The plan's kind. Optional and nullable: some rows cannot resolve a plan. */
  kind?: string | null;
  /** Credits left on the row. Null for a plan that was never sold as classes. */
  sessions_remaining?: number | null;
};

/**
 * Did this membership end because its last class was spent?
 *
 * All three conditions are asked, and the credit balance is the one that does
 * the real work. It is tempting to treat `expired` on a credit plan as proof on
 * its own, and that is wrong: a membership can sit `expired` with classes still
 * in it. Undoing a check-in refunds the credit but reopens the row only when
 * that same check-in is the one that closed it (`refundCheckInCredit` in
 * `checkin.functions.ts`), so undoing an EARLIER visit leaves `expired` with a
 * credit back on the row. A manager can also expire a row by hand through
 * `edit_invoice` or `setMembershipStatus`, on a trial nobody ever used.
 *
 * "Expired" was vague enough to survive those states. "Used up" is a specific
 * claim, and the same screen prints the balance next to it, so it has to be read
 * off the balance rather than inferred from the status.
 */
export function isUsedUp(m: LabelledMembership): boolean {
  return m.status === "expired" && endsWithCredits(m.kind) && m.sessions_remaining === 0;
}

/**
 * What one enrolment's state is called, given the plan behind it and what is
 * left on it.
 */
export function membershipStatusLabel(m: LabelledMembership): string {
  if (isUsedUp(m)) return "Used up";
  return MEMBERSHIP[m.status as MembershipStatus] ?? m.status;
}

/**
 * Is this person's funnel phase "they finished the free classes we gave them and
 * bought nothing"? The club's warmest lead, and the fact both the member's own
 * status card and the manager's pill are named from.
 *
 * `latest` is their newest membership. That is enough to separate this person
 * from someone whose paid membership ended, because the free trial is assigned
 * when a waiver is approved: a trial that is still their newest membership means
 * nothing followed it.
 */
export function isTrialUsedUp(status: string, latest?: LabelledMembership | null): boolean {
  return status === "lapsed" && latest?.kind === "trial" && isUsedUp(latest);
}

/**
 * The funnel phase, as a manager reads it.
 *
 * `lapsed` is derived for two very different people, and `isTrialUsedUp` is what
 * tells them apart. Everything else is its status, capitalised.
 */
export function lifecycleLabel(status: string, latest?: LabelledMembership | null): string {
  if (isTrialUsedUp(status, latest)) return TRIAL_USED_UP_LABEL;
  return LIFECYCLE[status as LifecycleStatus] ?? status;
}
