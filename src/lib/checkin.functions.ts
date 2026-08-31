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
import { attachableMemberships, lapsedMembershipIds, resolveCoverage } from "@/lib/checkin";
import type { CoverageCandidate, CoverageDecision } from "@/lib/checkin";
import { topUpHorizon } from "@/lib/calendar.functions";
import { ensureCasualInvoiceEmailed } from "@/lib/membership.functions";
import type { ClubUserEmail } from "@/lib/club-users";
import { loadHouseholdContacts } from "@/lib/household-email";

type CheckinClient = SupabaseClient<Database>;

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

/**
 * How many ids to put in one `.in()` filter. PostgREST renders it into the query
 * string, so a few hundred UUIDs blow past the proxy's request-line limit — the
 * same reason the calendar chunks its RSVP tally.
 */
const ID_CHUNK = 100;

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
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const { data, error } = await admin
      .from("memberships")
      .select(MEMBERSHIP_COLUMNS)
      .in("user_id", userIds.slice(i, i + ID_CHUNK));
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

/**
 * The contact address for each person on a roster, resolved through their
 * guardian where they have one.
 *
 * ⚠️ Read what this feeds before changing it. #106 classifies this call site as
 * a DELIVERY one, "check-in receipts", and there is no such thing: nothing in
 * this module sends an email, and the only consumer of the map is the roster's
 * `email` field, which `manager.check-in.tsx` uses solely to filter the list as
 * a manager types. It is never printed. So this is neither of #106's two sides
 * -- it is a search key -- and resolving it through the guardian is what makes
 * a parent's address find their children at the door, which is the useful
 * behaviour for the person holding the tablet.
 *
 * If a roster ever starts PRINTING this, it has to move to
 * `displayEmail`/`onBehalfOf` and say whose address it is, for the reason every
 * other display does: a bare address under a nine-year-old's name reads as a
 * mailbox somebody could write to.
 */
async function contactEmailsByUserId(
  admin: CheckinClient,
  userIds: string[],
): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const contacts = await loadHouseholdContacts(admin, userIds);
  const map = new Map<string, string>();
  for (const id of userIds) {
    const email = contacts.deliveryEmail(id);
    if (email) map.set(id, email);
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
    throw new Error("Someone else covered that check-in first. Reload to see where it landed.");
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
 */
export const listCheckInEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    const admin = await adminClient();
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

    // Attendance tally per class. Chunked: `.in()` becomes a query-string
    // filter, and a few hundred UUIDs blow past the proxy's request-line limit.
    const counts = new Map<string, number>();
    const ids = events.map((e) => e.id);
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data: rows, error: cErr } = await admin
        .from("session_checkins")
        .select("event_id")
        .in("event_id", ids.slice(i, i + CHUNK));
      if (cErr) throw new Error(cErr.message);
      for (const r of rows ?? []) counts.set(r.event_id, (counts.get(r.event_id) ?? 0) + 1);
    }

    return events.map((e) => ({ ...e, checked_in_count: counts.get(e.id) ?? 0 }));
  });

// ---- Manager: the door screen for one class ----

/**
 * Who is already in, and everyone who could be. The roster carries each person's
 * coverage preview so the manager sees what a tap will spend before they make
 * it. Only people with a waiver on file appear: a `profiles` row IS the waiver
 * on file, and the check-in's foreign key says the same thing in the database.
 */
export const getCheckInBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => checkInBoardSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    const admin = await adminClient();

    const { data: event, error: eErr } = await admin
      .from("calendar_events")
      .select("id, title, instructor_name, location, starts_at, ends_at, status")
      .eq("id", data.event_id)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!event) throw new Error("That class is not on the calendar.");

    const [{ data: profiles, error: pErr }, { data: checkins, error: cErr }] = await Promise.all([
      admin
        .from("profiles")
        .select("user_id, first_name, middle_name, last_name, preferred_name")
        .limit(ROSTER_LIMIT),
      admin
        .from("session_checkins")
        .select("id, user_id, checked_in_at, coverage, membership_id, consumed_credit, warnings")
        .eq("event_id", data.event_id)
        .order("checked_in_at", { ascending: false }),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (cErr) throw new Error(cErr.message);
    const people = profiles ?? [];
    if (people.length === ROSTER_LIMIT)
      console.warn(`[checkin] roster capped at ${ROSTER_LIMIT}; some people are not listed`);

    const userIds = people.map((p) => p.user_id);
    const [emails, candidates] = await Promise.all([
      contactEmailsByUserId(admin, userIds),
      coverageCandidatesByUser(admin, userIds),
    ]);

    const nameByUser = new Map(people.map((p) => [p.user_id, nameWithPreferred(p) || null]));
    const planByMembership = new Map<string, string | null>();
    for (const list of candidates.values())
      for (const m of list) planByMembership.set(m.id, m.plan_name);

    const roster = people.map((p) => {
      const decision = resolveCoverage({
        memberships: candidates.get(p.user_id) ?? [],
        at: event.starts_at,
      });
      return {
        user_id: p.user_id,
        name: nameByUser.get(p.user_id) ?? null,
        email: emails.get(p.user_id) ?? null,
        coverage: decision.coverage,
        plan_name: decision.plan_name,
        // Named to match `coveragePreviewLabel`, so the screen labels a roster
        // row with the very function the server labels a decision with.
        sessions_remaining_before: decision.sessions_remaining_before,
        consumes_credit: decision.consumes_credit,
        warnings: decision.warnings,
      };
    });

    return {
      event,
      roster,
      checkins: (checkins ?? []).map((c) => ({
        id: c.id,
        user_id: c.user_id,
        name: nameByUser.get(c.user_id) ?? null,
        checked_in_at: c.checked_in_at,
        coverage: c.coverage,
        plan_name: c.membership_id ? (planByMembership.get(c.membership_id) ?? null) : null,
        consumed_credit: c.consumed_credit,
        warnings: c.warnings,
      })),
    };
  });

// ---- Manager: the needs-attention list ----

/**
 * Every check-in nothing covered, across all classes — deliberately not scoped
 * to the class on screen, or an uncovered check-in from last Tuesday would be
 * invisible because the picker is on today. Each row carries the memberships it
 * could now be attached to, so fixing one is a single round trip.
 */
export const listUncoveredCheckIns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: CheckinClient; userId: string });
    const admin = await adminClient();

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
    const [{ data: profiles }, { data: events }, candidates] = await Promise.all([
      admin
        .from("profiles")
        .select("user_id, first_name, middle_name, last_name, preferred_name")
        .in("user_id", userIds),
      admin.from("calendar_events").select("id, title, starts_at").in("id", eventIds),
      coverageCandidatesByUser(admin, userIds),
    ]);

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
  });

// ---- Manager: the three writes ----

/**
 * Check one person in to one class.
 *
 * The row is inserted BEFORE any credit moves, on purpose. `UNIQUE (event_id,
 * user_id)` is the real guard against spending two credits for one class, so it
 * has to be claimed first and Postgres gets to pick the loser of a race. If
 * anything fails after the insert, the result is an uncovered check-in that the
 * needs-attention list already knows how to fix; the other order fails as a
 * spent credit with no attendance record, which nobody ever notices.
 */
export const checkInPerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => checkInSchema.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: CheckinClient; userId: string };
    await requireManager(ctx);
    const admin = await adminClient();

    const { data: event, error: eErr } = await admin
      .from("calendar_events")
      .select("id, starts_at, status")
      .eq("id", data.event_id)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!event) throw new Error("That class is not on the calendar.");
    if (event.status === "cancelled")
      throw new Error("That class was cancelled, so nobody can be checked in to it.");

    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("user_id")
      .eq("user_id", data.user_id)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!profile) throw new Error("Only someone with a waiver on file can be checked in.");

    const { data: inserted, error: iErr } = await admin
      .from("session_checkins")
      .insert({
        event_id: data.event_id,
        user_id: data.user_id,
        checked_in_by: ctx.userId,
        note: data.note?.trim() || null,
      })
      .select("id")
      .maybeSingle();

    if (iErr) {
      // Already on the list. Checking someone in twice is not an error at the
      // desk, so say so and stop rather than touching their credits again.
      if (iErr.code === "23505") return { already_checked_in: true, decision: null };
      throw new Error(iErr.message);
    }
    if (!inserted) throw new Error("Could not record the check-in.");

    const decision = await applyCoverage(admin, {
      checkInId: inserted.id,
      userId: data.user_id,
      at: event.starts_at,
    });
    return { already_checked_in: false, decision };
  });

/**
 * Give an uncovered check-in its cover, spending the credit at that moment.
 * With no `membership_id` it re-runs the door's own precedence, which is the
 * right answer once a late bank transfer has been reconciled.
 */
export const attachCheckInCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => attachCheckInSchema.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: CheckinClient; userId: string };
    await requireManager(ctx);
    const admin = await adminClient();

    const { data: row, error } = await admin
      .from("session_checkins")
      .select("id, user_id, event_id, coverage, checked_in_at")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("That check-in no longer exists.");
    if (row.coverage !== "none")
      throw new Error(
        "That check-in is already covered. Undo it first to change what paid for it.",
      );

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
  });

/**
 * Move an already-covered check-in onto a different membership.
 *
 * `attachCheckInCoverage` above handles the uncovered row; this handles the one
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
 */
export const transferCheckInCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transferCheckInSchema.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as { supabase: CheckinClient; userId: string };
    await requireManager(ctx);
    const admin = await adminClient();

    const { data: row, error } = await admin
      .from("session_checkins")
      .select(
        "id, user_id, event_id, coverage, membership_id, consumed_credit, closed_membership, checked_in_at",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("That check-in no longer exists.");
    if (row.coverage === "none")
      throw new Error("That check-in is not covered by anything yet, so attach it instead.");
    if (row.membership_id === data.membership_id)
      throw new Error("That check-in is already on that membership.");

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
      throw new Error("Someone else moved that check-in first. Reload to see where it landed.");

    await refundCheckInCredit(admin, row);

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
  .inputValidator((d: unknown) => undoCheckInSchema.parse(d))
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
    membership_id: string | null;
    consumed_credit: boolean | null;
    closed_membership: boolean | null;
  },
): Promise<{ refunded: boolean; reopened?: boolean }> {
  if (!row.consumed_credit || !row.membership_id) return { refunded: false };

  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: m, error: mErr } = await admin
      .from("memberships")
      .select("id, status, sessions_remaining, ends_at")
      .eq("id", row.membership_id)
      .maybeSingle();
    if (mErr) throw new Error(mErr.message);
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
    if (uErr) throw new Error(uErr.message);
    if ((updated ?? []).length > 0) return { refunded: true, reopened: reopen };
  }
  throw new Error("The check-in was released but the session could not be given back. Try again.");
}
