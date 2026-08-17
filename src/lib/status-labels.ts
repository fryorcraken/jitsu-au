// What the club CALLS each status on screen. The naming counterpart to
// `status-colours.ts`, which owns what one looks like, and read by the same
// screens: `/membership`, `/manager/users`, a person's manager page and
// `/manager/memberships`.
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

/**
 * What one enrolment's state is called, given the kind of plan behind it.
 *
 * `kind` is optional and may be null: several screens carry a membership row
 * whose plan could not be resolved. Those fall back to the plain status word.
 */
export function membershipStatusLabel(m: { status: string; kind?: string | null }): string {
  if (m.status === "expired" && endsWithCredits(m.kind)) return "Used up";
  return MEMBERSHIP[m.status as MembershipStatus] ?? m.status;
}

/**
 * The funnel phase, as a manager reads it.
 *
 * `lapsed` is derived for two very different people: somebody whose paid
 * membership ended, and somebody who used up the free classes they were given
 * and never bought anything. Only the first has lapsed. The second is the club's
 * warmest lead, and telling the two apart at a glance is what the column is for.
 *
 * `latestPlanKind` (the newest membership's plan kind) is enough to separate
 * them, because the free trial is assigned when a waiver is approved and is
 * therefore always a person's OLDEST membership. A trial that is still their
 * newest one means nothing ever followed it.
 */
export function lifecycleLabel(status: string, latestPlanKind?: string | null): string {
  if (status === "lapsed" && latestPlanKind === "trial") return "Trial used up";
  return LIFECYCLE[status as LifecycleStatus] ?? status;
}
