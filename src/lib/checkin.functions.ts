// Check-in server functions: the manager's door screen, and the only place in
// this app that ever spends `memberships.sessions_remaining`.
//
// Conventions mirror calendar.functions.ts: every entry point runs
// requireSupabaseAuth then re-checks has_role('manager'), and all DB access goes
// through the lazily-imported service-role client (this file ships to the client
// bundle, so the admin client is never top-level imported). `session_checkins`
// grants nothing to anon or authenticated, so these functions are the only way
// in and the manager check here is the real gate, not the route guard.
//
// The precedence rules themselves live in `@/lib/checkin` — pure and unit
// tested, and run unchanged in the browser to preview what a check-in will
// spend, so what a manager is warned about and what actually moves cannot
// disagree.
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  attachCheckInSchema,
  checkInBoardSchema,
  checkInSchema,
  nameWithPreferred,
  transferCheckInSchema,
  undoCheckInSchema,
} from "@/lib/validation";
import type { CheckInWarning } from "@/lib/validation";
import {
  attachableMemberships,
  lapsedMembershipIds,
  resolveCoverage,
  rosterHouseholdFields,
} from "@/lib/checkin";
import type { CoverageCandidate, CoverageDecision } from "@/lib/checkin";
import { topUpHorizon } from "@/lib/calendar.functions";
import { ensureCasualInvoiceEmailed } from "@/lib/membership.functions";
import type { ClubUserEmail } from "@/lib/club-users";
import { loadHouseholdContacts } from "@/lib/household-email";
import { chunks } from "@/lib/id-chunks";

type CheckinClient = SupabaseClient<Database>;

/**
 * Why a check-in write or read was refused, so a caller that is not a screen
 * (the manager agent API) can answer each with its own status instead of
 * parsing a sentence. The message is the one the screen shows, unchanged:
 * `CheckInError` is an `Error`, and the screens read `message`.
 *
 * - `not_found`: the class, the check-in or the membership is not there.
 * - `no_waiver`: the person has no record, which is what a waiver on file is.
 * - `class_cancelled`: a cancelled class cannot be checked in to.
 * - `already_covered` / `not_covered`: attach is for an uncovered check-in and
 *   move for a covered one; each names the other.
 * - `same_membership`: a move onto the membership it is already on.
 * - `claim_lost`: another manager attached or moved the same check-in first.
 * - `not_their_membership`: the membership named belongs to somebody else.
 * - `refund_failed`: a check-in was released (undone, or taken off its old
 *   membership by a move) but its session could not be given back. Retrying
 *   cannot fix it, since the release already happened: the next attempt finds
 *   nothing to undo, or an uncovered check-in to move.
 * - `move_incomplete`: a move released the check-in and gave the old
 *   membership its session back, but could not put it on the new one, so it is
 *   uncovered until somebody attaches it.
 */
export type CheckInRefusal =
  | "not_found"
  | "no_waiver"
  | "class_cancelled"
  | "already_covered"
  | "not_covered"
  | "same_membership"
  | "claim_lost"
  | "not_their_membership"
  | "refund_failed"
  | "move_incomplete";

export class CheckInError extends Error {
  reason: CheckInRefusal;
  constructor(reason: CheckInRefusal, message: string) {
    super(message);
    this.name = "CheckInError";
    this.reason = reason;
  }
}

const NO_SUCH_CLASS = "That class is not on the calendar.";
const NO_SUCH_CHECK_IN = "That check-in no longer exists.";

const CLASS_COLUMNS = "id, title, instructor_name, location, starts_at, ends_at, status";

/** A class on the calendar, or `not_found`. */
async function loadClass(admin: CheckinClient, eventId: string) {
  const { data: event, error } = await admin
    .from("calendar_events")
    .select(CLASS_COLUMNS)
    .eq("id", eventId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!event) throw new CheckInError("not_found", NO_SUCH_CLASS);
  return event;
}

/**
 * A class somebody can be checked in to: on the calendar and not cancelled.
 * One function for `check_in` and its preview, because the preview's promise is
 * to refuse exactly what the check-in would.
 */
async function loadCheckableClass(admin: CheckinClient, eventId: string) {
  const event = await loadClass(admin, eventId);
  if (event.status === "cancelled")
    throw new CheckInError(
      "class_cancelled",
      "That class was cancelled, so nobody can be checked in to it.",
    );
  return event;
}

/**
 * Refuse a named membership that is not the check-in's own person's.
 *
 * Coverage is strictly personal (`docs/check-in.md`), and `resolveCoverage`
 * reads a foreign id as "nothing eligible", so without this an attach would
 * land uncovered and say nothing more, and a MOVE would first release the
 * check-in and refund its real cover, then land it uncovered: a correction that
 * quietly makes things worse. The screens can never send one (they only offer
 * the person's own memberships), but the manager agent API takes any id an
 * agent types, so the guard lives here where both doors pass through it.
 */
async function assertMembershipIsTheirs(
  admin: CheckinClient,
  membershipId: string,
  userId: string,
): Promise<void> {
  const { data: m, error } = await admin
    .from("memberships")
    .select("id, user_id")
    .eq("id", membershipId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!m) throw new CheckInError("not_found", "That membership no longer exists.");
  if (m.user_id !== userId)
    throw new CheckInError(
      "not_their_membership",
      "That membership belongs to somebody else. A class is only covered by the membership of the person who trained.",
    );
}

/** How far either side of today the class picker looks. */
const EVENT_WINDOW_DAYS = 14;
/** Roster cap. The club is small; a cap stops one bad query taking the screen. */
const ROSTER_LIMIT = 2000;
/** Uncovered check-ins shown in the needs-attention list. */
const UNCOVERED_LIMIT = 100;
/** Classes offered in the picker. Ample for a 28-day window at club volumes. */
const EVENT_LIMIT = 500;

const MEMBERSHIP_COLUMNS =
  "id, user_id, plan_id, status, price_cents, paid_at, sessions_remaining, starts_at, ends_at, created_at";

type MembershipSelection = Pick<
  Database["public"]["Tables"]["memberships"]["Row"],
  | "id"
  | "user_id"
  | "plan_id"
  | "status"
  | "price_cents"
  | "paid_at"
  | "sessions_remaining"
  | "starts_at"
  | "ends_at"
  | "created_at"
>;

async function adminClient(): Promise<CheckinClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as CheckinClient;
}

/** Throw unless the caller holds the `manager` role (checked via the RLS RPC). */
async function requireManager(context: { supabase: CheckinClient; userId: string }) {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

/** A YYYY-MM-DD date `days` from now (UTC date grid, as elsewhere). */
function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every membership these people hold, joined to its plan, keyed by person.
 * One query per table rather than a join so the shapes stay the generated ones.
 */
async function coverageCandidatesByUser(
  admin: CheckinClient,
  userIds: string[],
): Promise<Map<string, CoverageCandidate[]>> {
  const byUser = new Map<string, CoverageCandidate[]>();
  if (!userIds.length) return byUser;

  const { data: plans, error: pErr } = await admin
    .from("membership_plans")
    .select("id, name, kind");
  if (pErr) throw new Error(pErr.message);

  // Chunked, for the same reason the calendar chunks its RSVP tally: `.in()`
  // becomes a query-string filter, and the whole roster's worth of UUIDs blows
  // past the proxy's request-line limit. The board passes every person in the
  // club, so this is not a theoretical size.
  const rows: MembershipSelection[] = [];
  for (const slice of chunks(userIds)) {
    const { data, error } = await admin
      .from("memberships")
      .select(MEMBERSHIP_COLUMNS)
      .in("user_id", slice);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }

  const planById = new Map((plans ?? []).map((p) => [p.id, p]));
  for (const m of rows) {
    if (!m.user_id) continue;
    const plan = planById.get(m.plan_id);
    // `plan_id` is NOT NULL REFERENCES membership_plans, and the plans above are
    // read in full, so this cannot happen. If it ever does, drop the membership
    // rather than guess a kind: guessing "session" would let an undescribable
    // row spend a credit. Loud, because it would mean the FK is gone.
    if (!plan) {
      console.error(`[checkin] membership ${m.id} references a plan that does not exist`);
      continue;
    }
    const list = byUser.get(m.user_id) ?? [];
    list.push({
      id: m.id,
      kind: plan.kind,
      plan_name: plan.name,
      status: m.status,
      price_cents: m.price_cents,
      paid_at: m.paid_at,
      sessions_remaining: m.sessions_remaining,
      starts_at: m.starts_at,
      ends_at: m.ends_at,
      created_at: m.created_at,
    });
    byUser.set(m.user_id, list);
  }
  return byUser;
}

/** What a roster row needs to know about the household behind a person. */
type RosterContact = {
  /**
   * The contact address, resolved through their guardian where they have one.
   *
   * ⚠️ Read what this feeds before changing it. #106 classifies this call site
   * as a DELIVERY one, "check-in receipts", and there is no such thing: nothing
   * in this module sends an email, and the only consumer is the roster's
   * `email` field, which `manager.check-in.tsx` uses solely to filter the list
   * as a manager types. It is never printed. So this is neither of #106's two
   * sides -- it is a search key -- and resolving it through the guardian is
   * what makes a parent's address find their children at the door.
   *
   * If a roster ever starts PRINTING it, it has to say whose address it is, for
   * the reason every other display does: a bare address under a nine-year-old's
   * name reads as a mailbox somebody could write to.
   */
  email: string | null;
  /**
   * Whose account they are on, when they are on somebody's. This one IS
   * printed, which is the whole point of it: see the roster below.
   */
  guardianName: string | null;
};

/**
 * The household facts for each person on a roster, in one lookup.
 *
 * One read rather than two because both answers come out of the same place: a
 * second lookup would give the door two chances to disagree with itself about
 * who a child belongs to.
 */
async function rosterContactsByUserId(
  admin: CheckinClient,
  userIds: string[],
): Promise<Map<string, RosterContact>> {
  if (!userIds.length) return new Map();
  const contacts = await loadHouseholdContacts(admin, userIds);
  const map = new Map<string, RosterContact>();
  for (const id of userIds) {
    map.set(id, {
      email: contacts.deliveryEmail(id),
      guardianName: contacts.displayEmail(id).onBehalfOf?.name ?? null,
    });
  }
  return map;
}

/**
 * Close memberships that are still marked active but whose end date has passed.
 * Nothing else in this app enforces an end date, so a check-in is where a
 * finished semester finally stops reading as current. Best-effort: a failure
 * here must never stop someone getting on the mat.
 */
async function closeLapsed(
  admin: CheckinClient,
  candidates: CoverageCandidate[],
  keepOpen: string | null,
): Promise<void> {
  // Never close the membership this check-in just drew on. Coverage resolves at
  // the CLASS's start, so back-filling last week's roster can legitimately spend
  // a pack that has since run out of days; closing it in the same breath would
  // be correct as of now but would make the credit we just took unrefundable by
  // undo, which needs the row to still be active.
  const ids = lapsedMembershipIds(candidates, new Date().toISOString()).filter(
    (id) => id !== keepOpen,
  );
  if (!ids.length) return;
  // supabase-js returns `{ error }` rather than throwing, so this has to be
  // destructured: a try/catch around it would never fire.
  const { error } = await admin
    .from("memberships")
    .update({ status: "expired" })
    .in("id", ids)
    .eq("status", "active");
  if (error) console.error("[checkin] could not close lapsed memberships:", error.message);
}

/**
 * Spend the credit a decision calls for, using a compare-and-set on the balance
 * we read. Zero rows back means another manager moved that balance in between,
 * so the caller re-resolves rather than writing a number derived from stale data
 * — PostgREST cannot express `sessions_remaining = sessions_remaining - 1`,
 * which is exactly why the guard is on the expected value.
 */
async function spendCredit(admin: CheckinClient, decision: CoverageDecision): Promise<boolean> {
  const { data, error } = await admin
    .from("memberships")
    .update({
      sessions_remaining: decision.sessions_remaining_after,
      ...(decision.closes_membership ? { status: "expired" } : {}),
    })
    .eq("id", decision.membership_id as string)
    .eq("status", "active")
    .eq("sessions_remaining", decision.sessions_remaining_before as number)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * Work out what covers a check-in, take the credit, and record both on the row.
 *
 * Shared by checking someone in at the door and by attaching an uncovered
 * check-in afterwards, so a late attach applies exactly the rules the door would
 * have applied. `at` is the class's start instant, never "now".
 *
 * Exported, and taking its client as a parameter, so the credit-moving path can
 * be driven from a unit test — a `createServerFn` handler cannot be (it dies on
 * "No Start context found in AsyncLocalStorage"). Same seam as
 * `reconcileUnmatched` in membership.functions.ts.
 *
 * A casual credit (`coverage: "session"`) also gets `ensureCasualInvoiceEmailed`
 * here, not just at the point the membership was raised: this is the one place
 * every casual credit is actually spent, whatever door it came in through
 * (check-in, attach, or move), so it is the reliable point to guarantee the
 * member has an invoice or receipt for it — including a credit whose invoice
 * email was skipped or lost when the membership was raised.
 */
export async function applyCoverage(
  admin: CheckinClient,
  input: {
    checkInId: string;
    userId: string;
    at: string;
    onlyMembershipId?: string;
  },
): Promise<CoverageDecision> {
  const candidates =
    (await coverageCandidatesByUser(admin, [input.userId])).get(input.userId) ?? [];

  const resolve = (list: CoverageCandidate[]) =>
    resolveCoverage({ memberships: list, at: input.at, only: input.onlyMembershipId });

  let decision = resolve(candidates);
  if (decision.consumes_credit && !(await spendCredit(admin, decision))) {
    // Somebody took that credit while we were deciding. Re-read and try once.
    const fresh = (await coverageCandidatesByUser(admin, [input.userId])).get(input.userId) ?? [];
    decision = resolve(fresh);
    if (decision.consumes_credit && !(await spendCredit(admin, decision))) {
      // Two losses in a row: record it uncovered rather than double-spend or
      // throw. They were on the mat either way, and an uncovered check-in is
      // two clicks from correct.
      decision = {
        membership_id: null,
        coverage: "none",
        plan_name: null,
        consumes_credit: false,
        sessions_remaining_before: null,
        sessions_remaining_after: null,
        closes_membership: false,
        warnings: [...decision.warnings, "coverage_race" as CheckInWarning],
      };
    }
  }

  // Claim the check-in row, and only then is the credit really spent.
  //
  // `UNIQUE (event_id, user_id)` guards checking someone in, because that path
  // creates the row. It does NOT guard attaching cover afterwards: that row
  // already exists, so two managers attaching the same one — one from the
  // needs-attention list, one from the person's page — would both resolve, both
  // spend, and take two credits for one class. `.eq("coverage", "none")` makes
  // the row itself the claim: exactly one update matches, and the loser hands
  // back what it took.
  const { data: claimed, error } = await admin
    .from("session_checkins")
    .update({
      coverage: decision.coverage,
      membership_id: decision.membership_id,
      consumed_credit: decision.consumes_credit,
      closed_membership: decision.closes_membership,
      warnings: decision.warnings,
      // `checked_in_by` is deliberately NOT touched here. It records who put
      // this person on the mat, set once at insert; attaching cover afterwards
      // is a different act by possibly a different manager, and overwriting it
      // would erase the only record of who was on the door.
    })
    .eq("id", input.checkInId)
    .eq("coverage", "none")
    .select("id");

  if (error || (claimed ?? []).length === 0) {
    // Either the write failed or somebody else got there first. Both mean this
    // call must not keep the credit it took: refunding is safe precisely
    // because we know the exact row and amount we moved.
    if (decision.consumes_credit) await refundCredit(admin, decision);
    if (error) throw new Error(error.message);
    throw new CheckInError(
      "claim_lost",
      "Someone else covered that check-in first. Reload to see where it landed.",
    );
  }

  // Only now, and never the membership this check-in just drew on.
  await closeLapsed(admin, candidates, decision.membership_id);

  // Guarantee the casual credit this check-in just spent has an invoice or
  // receipt in the member's inbox. Best-effort and never awaited into a
  // failure: see the note on `ensureCasualInvoiceEmailed`.
  if (decision.coverage === "session" && decision.membership_id) {
    await ensureCasualInvoiceEmailed(admin, decision.membership_id);
  }

  return decision;
}

/**
 * Put back a credit this call took but could not record, restoring the closure
 * it caused. The mirror of `spendCredit`, guarded the same way so it cannot
 * clobber a concurrent decrement.
 */
async function refundCredit(admin: CheckinClient, decision: CoverageDecision): Promise<void> {
  const { error } = await admin
    .from("memberships")
    .update({
      sessions_remaining: decision.sessions_remaining_before,
      ...(decision.closes_membership ? { status: "active" } : {}),
    })
    .eq("id", decision.membership_id as string)
    .eq("sessions_remaining", decision.sessions_remaining_after as number);
  if (error) {
    // Nothing left to do but make it findable: the check-in did not stick, so
    // the credit is short by one and only a human can reconcile that.
    console.error(
      `[checkin] could not refund a credit on membership ${decision.membership_id}:`,
      error.message,
    );
  }
}

// ---- Manager: the classes a check-in can be recorded against ----

/**
 * The classes near today, newest horizon topped up first so a brand-new weekly
 * entry is checkable on the day it runs. Deliberately narrower than
 * `listManagerEvents`: no RSVP tallies, a two-week window, because this is a
 * screen a manager reloads between classes on a phone.
 *
 * A plain function taking its client, so the manager agent API reads the same
 * list (`list_check_in_classes`); the caller checks the manager role.
 */
export async function listCheckInEventRows(admin: CheckinClient) {
  await topUpHorizon(admin);

  const { data, error } = await admin
    .from("calendar_events")
    .select("id, title, instructor_name, location, starts_at, ends_at, status")
    .gte("starts_at", `${dateFromNow(-EVENT_WINDOW_DAYS)}T00:00:00.000Z`)
    .lte("starts_at", `${dateFromNow(EVENT_WINDOW_DAYS)}T23:59:59.999Z`)
    .order("starts_at", { ascending: true })
    .limit(EVENT_LIMIT);
  if (error) throw new Error(error.message);
  const events = data ?? [];
  // Ordered ascending, so hitting the cap drops the FUTURE end of the window —
  // including today's class, which is the one the screen exists for.
  if (events.length === EVENT_LIMIT)
    console.warn(`[checkin] class list capped at ${EVENT_LIMIT}; later classes are missing`);

  // Attendance tally per class, in slices (`id-chunks.ts` says why).
  const counts = new Map<string, number>();
  for (const slice of chunks(events.map((e) => e.id))) {
    const { data: rows, error: cErr } = await admin
      .from("session_checkins")
      .select("event_id")
      .in("event_id", slice);
    if (cErr) throw new Error(cErr.message);
    for (const r of rows ?? []) counts.set(r.event_id, (counts.get(r.event_id) ?? 0) + 1);
  }

  return events.map((e) => ({ ...e, checked_in_count: counts.get(e.id) ?? 0 }));
}

export const listCheckInEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    return listCheckInEventRows(await adminClient());
  });

// ---- Manager: the door screen for one class ----

type RosterProfile = {
  user_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  date_of_birth: string | null;
};

/**
 * One person's row on the door's roster: who they are, and what checking them
 * in to a class starting `at` would spend. The board builds every row with it
 * and `previewCheckInRow` builds one, so the preview an agent reads back to a
 * manager and the badge beside the button cannot be worked out differently.
 */
function rosterRow(
  p: RosterProfile,
  contact: RosterContact | undefined,
  memberships: CoverageCandidate[],
  at: string,
) {
  const decision = resolveCoverage({ memberships, at });
  return {
    user_id: p.user_id,
    name: nameWithPreferred(p) || null,
    email: contact?.email ?? null,
    // What tells one child from another at the door, and what is withheld
    // about everybody else. The rule is in `checkin.ts` with its reasoning
    // and its tests, because the withholding half is a privacy decision
    // rather than a rendering detail.
    ...rosterHouseholdFields({
      guardianName: contact?.guardianName ?? null,
      dateOfBirth: p.date_of_birth,
    }),
    coverage: decision.coverage,
    plan_name: decision.plan_name,
    // Named to match `coveragePreviewLabel`, so the screen labels a roster
    // row with the very function the server labels a decision with.
    sessions_remaining_before: decision.sessions_remaining_before,
    consumes_credit: decision.consumes_credit,
    warnings: decision.warnings,
  };
}

const BOARD_CHECKIN_COLUMNS =
  "id, user_id, checked_in_at, coverage, membership_id, consumed_credit, warnings, note";

/** One check-in on the board, as Here now lists it and the preview reports it. */
function boardCheckIn(
  c: {
    id: string;
    user_id: string;
    checked_in_at: string;
    coverage: string;
    membership_id: string | null;
    consumed_credit: boolean;
    warnings: string[];
    note: string | null;
  },
  name: string | null,
  planByMembership: Map<string, string | null>,
) {
  return {
    id: c.id,
    user_id: c.user_id,
    name,
    checked_in_at: c.checked_in_at,
    coverage: c.coverage,
    membership_id: c.membership_id,
    plan_name: c.membership_id ? (planByMembership.get(c.membership_id) ?? null) : null,
    consumed_credit: c.consumed_credit,
    warnings: c.warnings,
    note: c.note,
  };
}

/**
 * Who is checked in to one class, newest first: Here now on the door screen,
 * and `list_attendance` on the agent API. Reads only the people checked in to
 * it, so a question about one class costs one class's worth of reads rather
 * than the whole club's roster.
 */
export async function loadClassAttendance(admin: CheckinClient, data: { event_id: string }) {
  const event = await loadClass(admin, data.event_id);

  const { data: rows, error } = await admin
    .from("session_checkins")
    .select(BOARD_CHECKIN_COLUMNS)
    .eq("event_id", data.event_id)
    .order("checked_in_at", { ascending: false });
  if (error) throw new Error(error.message);
  const checkins = rows ?? [];

  const userIds = [...new Set(checkins.map((c) => c.user_id))];
  const [{ data: profiles, error: pErr }, candidates] = await Promise.all([
    userIds.length
      ? admin
          .from("profiles")
          .select("user_id, first_name, middle_name, last_name, preferred_name")
          .in("user_id", userIds)
      : Promise.resolve({ data: [], error: null }),
    coverageCandidatesByUser(admin, userIds),
  ]);
  if (pErr) throw new Error(pErr.message);

  const nameByUser = new Map(
    (profiles ?? []).map((p) => [p.user_id, nameWithPreferred(p) || null]),
  );
  const planByMembership = new Map<string, string | null>();
  for (const list of candidates.values())
    for (const m of list) planByMembership.set(m.id, m.plan_name);

  return {
    event,
    checkins: checkins.map((c) =>
      boardCheckIn(c, nameByUser.get(c.user_id) ?? null, planByMembership),
    ),
  };
}

/**
 * Who is already in, and everyone who could be. The roster carries each person's
 * coverage preview so the manager sees what a tap will spend before they make
 * it. Only people with a waiver on file appear: a `profiles` row IS the waiver
 * on file, and the check-in's foreign key says the same thing in the database.
 *
 * Who is already in is `loadClassAttendance`, the read the agent API's
 * `list_attendance` makes; the caller checks the manager role.
 */
export async function loadCheckInBoard(admin: CheckinClient, data: { event_id: string }) {
  const [{ event, checkins }, { data: profiles, error: pErr }] = await Promise.all([
    loadClassAttendance(admin, data),
    admin
      .from("profiles")
      .select("user_id, first_name, middle_name, last_name, preferred_name, date_of_birth")
      .limit(ROSTER_LIMIT),
  ]);
  if (pErr) throw new Error(pErr.message);
  const people = profiles ?? [];
  if (people.length === ROSTER_LIMIT)
    console.warn(`[checkin] roster capped at ${ROSTER_LIMIT}; some people are not listed`);

  const userIds = people.map((p) => p.user_id);
  const [emails, candidates] = await Promise.all([
    rosterContactsByUserId(admin, userIds),
    coverageCandidatesByUser(admin, userIds),
  ]);

  const roster = people.map((p) =>
    rosterRow(p, emails.get(p.user_id), candidates.get(p.user_id) ?? [], event.starts_at),
  );

  return { event, roster, checkins };
}

export const getCheckInBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => checkInBoardSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    return loadCheckInBoard(await adminClient(), data);
  });

/**
 * One person's row of the board for one class, and their check-in to it if
 * they have one: what `get_check_in_preview` on the agent API reports.
 *
 * Built by the board's own row builders (`rosterRow`, `boardCheckIn`) from the
 * same reads, for one person rather than the whole club. Reading the full
 * board for one answer cost a lookup of every member's address and every
 * membership in the club, and the roster's cap meant somebody past it would be
 * told they had no waiver when `check_in` would accept them.
 *
 * Refuses what `check_in` refuses, through the same `loadCheckableClass`: a
 * class that is not on the calendar, a cancelled class, and somebody with no
 * waiver on file. A preview of what a check-in would spend, for a check-in that
 * cannot happen, would be the one thing a manager is asked to confirm that is
 * not so.
 */
export async function previewCheckInRow(
  admin: CheckinClient,
  data: { event_id: string; user_id: string },
) {
  const event = await loadCheckableClass(admin, data.event_id);

  const [{ data: profile, error: pErr }, { data: checkin, error: cErr }] = await Promise.all([
    admin
      .from("profiles")
      .select("user_id, first_name, middle_name, last_name, preferred_name, date_of_birth")
      .eq("user_id", data.user_id)
      .maybeSingle(),
    admin
      .from("session_checkins")
      .select(BOARD_CHECKIN_COLUMNS)
      .eq("event_id", data.event_id)
      .eq("user_id", data.user_id)
      .maybeSingle(),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (cErr) throw new Error(cErr.message);
  if (!profile)
    throw new CheckInError("no_waiver", "Only someone with a waiver on file can be checked in.");

  const [contacts, candidates] = await Promise.all([
    rosterContactsByUserId(admin, [data.user_id]),
    coverageCandidatesByUser(admin, [data.user_id]),
  ]);
  const mine = candidates.get(data.user_id) ?? [];
  const row = rosterRow(profile, contacts.get(data.user_id), mine, event.starts_at);
  const planByMembership = new Map(mine.map((m) => [m.id, m.plan_name]));
  return {
    event,
    row,
    checkin: checkin ? boardCheckIn(checkin, row.name, planByMembership) : null,
  };
}

// ---- Manager: the needs-attention list ----

/**
 * Every check-in nothing covered, across all classes — deliberately not scoped
 * to the class on screen, or an uncovered check-in from last Tuesday would be
 * invisible because the picker is on today. Each row carries the memberships it
 * could now be attached to, so fixing one is a single round trip.
 *
 * A plain function taking its client, so the manager agent API reads the same
 * list (`list_uncovered_check_ins`); the caller checks the manager role.
 */
export async function listUncoveredCheckInRows(admin: CheckinClient) {
  const { data: rows, error } = await admin
    .from("session_checkins")
    .select("id, event_id, user_id, checked_in_at, warnings, note")
    .eq("coverage", "none")
    .order("checked_in_at", { ascending: false })
    .limit(UNCOVERED_LIMIT);
  if (error) throw new Error(error.message);
  const uncovered = rows ?? [];
  if (uncovered.length === UNCOVERED_LIMIT)
    console.warn(`[checkin] needs-attention list capped at ${UNCOVERED_LIMIT}`);
  if (!uncovered.length) return [];

  const userIds = [...new Set(uncovered.map((r) => r.user_id))];
  const eventIds = [...new Set(uncovered.map((r) => r.event_id))];
  const [{ data: profiles, error: pErr }, { data: events, error: eErr }, candidates] =
    await Promise.all([
      admin
        .from("profiles")
        .select("user_id, first_name, middle_name, last_name, preferred_name")
        .in("user_id", userIds),
      admin.from("calendar_events").select("id, title, starts_at").in("id", eventIds),
      coverageCandidatesByUser(admin, userIds),
    ]);
  // A failed lookup is an error, not a row with no name and no class: the
  // class's start is what `would_cover` and `memberships` are worked out
  // against, so a missing one would answer for the wrong moment.
  if (pErr) throw new Error(pErr.message);
  if (eErr) throw new Error(eErr.message);

  const nameByUser = new Map(
    (profiles ?? []).map((p) => [p.user_id, nameWithPreferred(p) || null]),
  );
  const eventById = new Map((events ?? []).map((e) => [e.id, e]));

  return uncovered.map((r) => {
    const event = eventById.get(r.event_id) ?? null;
    const mine = candidates.get(r.user_id) ?? [];
    const at = event?.starts_at ?? r.checked_in_at;
    return {
      id: r.id,
      user_id: r.user_id,
      name: nameByUser.get(r.user_id) ?? null,
      event_id: r.event_id,
      event_title: event?.title ?? null,
      event_starts_at: event?.starts_at ?? null,
      checked_in_at: r.checked_in_at,
      warnings: r.warnings,
      note: r.note,
      // What it would resolve to right now: usually the whole answer, since
      // the reason it is uncovered is normally a payment that has since landed.
      would_cover: resolveCoverage({ memberships: mine, at }).coverage !== "none",
      memberships: attachableMemberships(mine, at),
    };
  });
}

export const listUncoveredCheckIns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    return listUncoveredCheckInRows(await adminClient());
  });

// ---- Manager: the writes ----

/**
 * Check one person in to one class.
 *
 * The row is inserted BEFORE any credit moves, on purpose. `UNIQUE (event_id,
 * user_id)` is the real guard against spending two credits for one class, so it
 * has to be claimed first and Postgres gets to pick the loser of a race. If
 * anything fails after the insert, the result is an uncovered check-in that the
 * needs-attention list already knows how to fix; the other order fails as a
 * spent credit with no attendance record, which nobody ever notices.
 *
 * A plain function taking its client and the acting manager, so the manager
 * agent API checks people in through the same code (`check_in`); the caller
 * checks the manager role.
 */
export async function checkInPersonRow(
  admin: CheckinClient,
  data: { event_id: string; user_id: string; note?: string },
  actingAs: string,
) {
  const event = await loadCheckableClass(admin, data.event_id);

  const { data: profile, error: pErr } = await admin
    .from("profiles")
    .select("user_id")
    .eq("user_id", data.user_id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!profile)
    throw new CheckInError("no_waiver", "Only someone with a waiver on file can be checked in.");

  // Two attempts, for one race: the insert collides with a check-in that is
  // undone before we can read it back. Answering "already checked in" then
  // would tell the caller somebody is on the list who is not on it any more,
  // so the second attempt checks them in for real.
  let inserted: { id: string } | null = null;
  for (let attempt = 0; attempt < 2 && !inserted; attempt++) {
    const { data: row, error: iErr } = await admin
      .from("session_checkins")
      .insert({
        event_id: data.event_id,
        user_id: data.user_id,
        checked_in_by: actingAs,
        note: data.note?.trim() || null,
      })
      .select("id")
      .maybeSingle();

    if (!iErr) {
      inserted = row;
      break;
    }
    if (iErr.code !== "23505") throw new Error(iErr.message);

    // Already on the list. Checking someone in twice is not an error at the
    // desk, so say so and stop rather than touching their credits again. The
    // existing row's id comes back with it, so a caller that was never told
    // its first attempt landed (an agent retrying) can still undo or move the
    // check-in it made.
    const { data: existing, error: xErr } = await admin
      .from("session_checkins")
      .select("id")
      .eq("event_id", data.event_id)
      .eq("user_id", data.user_id)
      .maybeSingle();
    if (xErr) throw new Error(xErr.message);
    if (existing) return { already_checked_in: true, checkin_id: existing.id, decision: null };
  }
  if (!inserted) throw new Error("Could not record the check-in.");

  const decision = await applyCoverage(admin, {
    checkInId: inserted.id,
    userId: data.user_id,
    at: event.starts_at,
  });
  return { already_checked_in: false, checkin_id: inserted.id, decision };
}

export const checkInPerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => checkInSchema.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: CheckinClient; userId: string };
    await requireManager(ctx);
    return checkInPersonRow(await adminClient(), data, ctx.userId);
  });

/**
 * Give an uncovered check-in its cover, spending the credit at that moment.
 * With no `membership_id` it re-runs the door's own precedence, which is the
 * right answer once a late bank transfer has been reconciled.
 *
 * A plain function taking its client (`attach_check_in` on the agent API).
 */
export async function attachCheckInRow(
  admin: CheckinClient,
  data: { id: string; membership_id?: string },
) {
  const { data: row, error } = await admin
    .from("session_checkins")
    .select("id, user_id, event_id, coverage, checked_in_at")
    .eq("id", data.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new CheckInError("not_found", NO_SUCH_CHECK_IN);
  if (row.coverage !== "none")
    throw new CheckInError(
      "already_covered",
      "That check-in is already covered. To change what paid for it, move it from the person's page.",
    );
  if (data.membership_id) await assertMembershipIsTheirs(admin, data.membership_id, row.user_id);

  const { data: event } = await admin
    .from("calendar_events")
    .select("starts_at")
    .eq("id", row.event_id)
    .maybeSingle();

  const decision = await applyCoverage(admin, {
    checkInId: row.id,
    userId: row.user_id,
    at: event?.starts_at ?? row.checked_in_at,
    onlyMembershipId: data.membership_id,
  });
  return { decision };
}

export const attachCheckInCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => attachCheckInSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    return attachCheckInRow(await adminClient(), data);
  });

/**
 * Move an already-covered check-in onto a different membership.
 *
 * `attachCheckInRow` above handles the uncovered row; this handles the one
 * that is covered by the wrong membership. Until now the only way to correct
 * that was to undo the check-in and record it again, which deletes the row and
 * loses `checked_in_at` — the record of when they were actually on the mat.
 *
 * The order is the same guard `undoCheckInRow` uses, for the same reason:
 * RELEASE the check-in first, with a compare-and-swap against the coverage it
 * had, and only refund once that update is ours. Exactly one caller can win the
 * release, so exactly one refund is ever attempted. Refunding first would let
 * two managers moving the same check-in hand back two credits for one class.
 *
 * Once released the row is genuinely uncovered, so the move finishes through
 * `applyCoverage` — the same code the door and the attach path run, which means
 * a target that cannot actually cover the class (wrong dates, no credits left)
 * lands it uncovered and warns, rather than being force-fitted. The old
 * membership has its credit back either way, which is the honest outcome: the
 * manager asked to take the class off it.
 *
 * A plain function taking its client (`move_check_in` on the agent API).
 */
export async function transferCheckInRow(
  admin: CheckinClient,
  data: { id: string; membership_id: string },
) {
  const { data: row, error } = await admin
    .from("session_checkins")
    .select(
      "id, user_id, event_id, coverage, membership_id, consumed_credit, closed_membership, checked_in_at",
    )
    .eq("id", data.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new CheckInError("not_found", NO_SUCH_CHECK_IN);
  if (row.coverage === "none")
    throw new CheckInError(
      "not_covered",
      "That check-in is not covered by anything yet, so attach it instead.",
    );
  if (row.membership_id === data.membership_id)
    throw new CheckInError("same_membership", "That check-in is already on that membership.");
  // Before the release below, which refunds the old cover: refusing after it
  // would leave the class uncovered and the old credit handed back.
  await assertMembershipIsTheirs(admin, data.membership_id, row.user_id);

  // The claim. Losing it means another manager is already moving this row.
  //
  // Pinned on `membership_id` as well as `coverage`, because coverage alone
  // does not identify the state this call read. Two managers moving the same
  // check-in: the first releases it, refunds A and re-covers it from B, all
  // before the second's update runs — whose `coverage` filter then matches
  // the NEW state and releases it a second time, refunding A again off a
  // stale row while B's credit stays spent and the class ends up uncovered.
  // Pinning the membership makes the second update match nothing, which is
  // the whole point of a compare-and-swap.
  let claim = admin
    .from("session_checkins")
    .update({
      coverage: "none",
      membership_id: null,
      consumed_credit: false,
      closed_membership: false,
    })
    .eq("id", row.id)
    .eq("coverage", row.coverage);
  claim = row.membership_id
    ? claim.eq("membership_id", row.membership_id)
    : claim.is("membership_id", null);
  const { data: released, error: relErr } = await claim.select("id");
  if (relErr) throw new Error(relErr.message);
  if ((released ?? []).length === 0)
    throw new CheckInError(
      "claim_lost",
      "Someone else moved that check-in first. Reload to see where it landed.",
    );

  try {
    await refundCheckInCredit(admin, row);
  } catch (e) {
    // Released, so the class is uncovered as well as the old membership being
    // short. A move's caller has to be told both, or it reports only the
    // missing session and nobody attaches the class to what was asked for.
    if (e instanceof CheckInError && e.reason === "refund_failed")
      throw new CheckInError(
        "refund_failed",
        "The class was taken off the old membership, but its session could not be given back, so that membership is one session short. The class is uncovered for now: attach it to the membership you wanted, and tell whoever looks after the club's records about the missing session. Moving it again will not fix either.",
      );
    throw e;
  }

  // From here the check-in is released and the old membership has its session
  // back. A failure now must say so, not read as worth retrying: a retry finds
  // an uncovered check-in and is refused as not_covered, which hides that the
  // first half of the move happened.
  try {
    const { data: event } = await admin
      .from("calendar_events")
      .select("starts_at")
      .eq("id", row.event_id)
      .maybeSingle();

    const decision = await applyCoverage(admin, {
      checkInId: row.id,
      userId: row.user_id,
      at: event?.starts_at ?? row.checked_in_at,
      onlyMembershipId: data.membership_id,
    });
    return { decision };
  } catch (e) {
    if (e instanceof CheckInError) throw e;
    console.error(`[checkin] move of ${row.id} released but not re-covered:`, e);
    throw new CheckInError(
      "move_incomplete",
      "The class was taken off the old membership, which has its session back, but could not be put on the new one. It is uncovered for now: attach it to the membership you wanted.",
    );
  }
}

export const transferCheckInCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => transferCheckInSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    return transferCheckInRow(await adminClient(), data);
  });

/**
 * Undo a check-in and give back whatever it spent.
 *
 * The row is deleted FIRST, with `RETURNING`, so the delete is the guard: two
 * managers undoing at once means only one gets a row back and only one refund is
 * ever attempted. A refund that then fails loses a credit, which is visible and
 * fixable; refunding first would let a retry hand out sessions nobody paid for.
 *
 * A hard delete rather than a tombstone: `UNIQUE (event_id, user_id)` means a
 * soft-deleted row would block checking the same person back in, and the record
 * that matters — a credit moving, and when — is on the membership.
 */
export const undoCheckIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => undoCheckInSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    return undoCheckInRow(await adminClient(), data.id);
  });

/**
 * The body of `undoCheckIn`, taking its client as a parameter so the refund can
 * be driven from a unit test (see the note on `applyCoverage`).
 */
export async function undoCheckInRow(
  admin: CheckinClient,
  id: string,
): Promise<{ removed: boolean; refunded: boolean; reopened?: boolean }> {
  const { data: deleted, error } = await admin
    .from("session_checkins")
    .delete()
    .eq("id", id)
    .select("id, membership_id, consumed_credit, closed_membership")
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Nothing deleted: another manager undid it first. Say so rather than
  // reporting a no-op as a successful removal.
  if (!deleted) return { removed: false, refunded: false };

  const { refunded, reopened } = await refundCheckInCredit(admin, deleted);
  return { removed: true, refunded, reopened };
}

/**
 * Give back the credit a check-in spent, and reopen the membership if that
 * check-in is what closed it.
 *
 * Takes the check-in's own record of what it took (`consumed_credit`,
 * `membership_id`, `closed_membership`) rather than re-deciding, because by the
 * time this runs the check-in has already been released — deleted by an undo, or
 * detached by a transfer. Only the row's own record still knows what to put back.
 *
 * The caller must release the check-in FIRST, and release it with a
 * compare-and-swap, so that exactly one caller ever reaches here for a given
 * check-in. Refunding before releasing would let a retry hand out sessions
 * nobody paid for.
 */
export async function refundCheckInCredit(
  admin: CheckinClient,
  row: {
    id: string;
    membership_id: string | null;
    consumed_credit: boolean | null;
    closed_membership: boolean | null;
  },
): Promise<{ refunded: boolean; reopened?: boolean }> {
  if (!row.consumed_credit || !row.membership_id) return { refunded: false };
  const membershipId = row.membership_id;

  // The check-in is already released, so any failure from here leaves the
  // membership a session short with nothing left to retry. Say exactly that,
  // and leave the membership's id in the log, since no screen can add a
  // session back.
  const lost = (cause: unknown) => {
    console.error(
      `[checkin] check-in ${row.id} was released but its session on membership ${membershipId} was not given back:`,
      cause,
    );
    return new CheckInError(
      "refund_failed",
      "The check-in was released, but its session could not be given back, so that membership is one session short. Doing it again will not fix it: tell whoever looks after the club's records.",
    );
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: m, error: mErr } = await admin
      .from("memberships")
      .select("id, status, sessions_remaining, ends_at")
      .eq("id", membershipId)
      .maybeSingle();
    if (mErr) throw lost(mErr.message);
    // The membership is gone: nothing to refund, and the check-in is already
    // released, so there is nothing left to reconcile.
    if (!m || m.sessions_remaining === null) return { refunded: false };

    // Reopen only what THIS check-in closed, and only if the end date has not
    // also passed — a membership a manager expired by hand stays expired.
    const stillWithinDates = !m.ends_at || new Date(m.ends_at).getTime() >= Date.now();
    const reopen = Boolean(row.closed_membership) && m.status === "expired" && stillWithinDates;

    const { data: updated, error: uErr } = await admin
      .from("memberships")
      .update({
        sessions_remaining: m.sessions_remaining + 1,
        ...(reopen ? { status: "active" } : {}),
      })
      .eq("id", m.id)
      .eq("sessions_remaining", m.sessions_remaining)
      .select("id");
    if (uErr) throw lost(uErr.message);
    if ((updated ?? []).length > 0) return { refunded: true, reopened: reopen };
  }
  throw lost("the balance kept changing under two attempts");
}
