import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildPaymentReference,
  computeMembershipPrice,
  createMembershipSchema,
  deleteMembershipSchema,
  formatCents,
  importBankStatementSchema,
  isUtsStudent,
  markMembershipPaidSchema,
  haystackContainsRef,
  matchesMembershipReference,
  matchTransactionSchema,
  membershipDeleteMessage,
  normalizeRef,
  greetingName,
  nameWithPreferred,
  planMembershipWindow,
  profileFullName,
  saveClubSettingsSchema,
  savePlanSchema,
  sellablePlans,
  setMembershipStatusSchema,
  startMembershipSchema,
  whyMembershipCannotBeDeleted,
} from "@/lib/validation";
import type {
  CreateMembershipInput,
  MembershipDeleteBlocker,
  MembershipPlanKind,
  MembershipStatus,
  SavePlanInput,
} from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";
import type {
  BankTransactionRow,
  MembershipClient,
  MembershipPlanRow,
  MembershipRow,
} from "@/lib/membership-types";
import type {
  ClubUserEmail,
  ClubUserLead,
  ClubUserProfile,
  ClubUserWaiver,
} from "@/lib/club-users";
import { userEmails } from "@/lib/supabase-rpc";
import { requireManager } from "@/lib/require-manager";

/**
 * Resolve auth emails (the one email store) for a set of user ids via the
 * service-role `user_emails` RPC. Returns an empty map on lookup failure so
 * callers degrade to missing emails rather than erroring. Degraded mode in the
 * directory: persons render with a null email, and leads (matched to persons by
 * email) are not deduped against them, so a person mid-funnel could transiently
 * appear twice — acceptable, since the RPC failing is rare and non-destructive.
 */
async function emailsByUserId(
  admin: MembershipClient,
  userIds: string[],
): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const { data, error } = await userEmails(admin, userIds);
  if (error || !data) return new Map();
  return new Map(data.map((e) => [e.user_id, e.email]));
}

/**
 * The same lookup, keeping the whole row rather than just the address.
 *
 * The people directory needs `email_confirmed_at` alongside the email to badge
 * verified state, and it is the only caller that does — everywhere else wants a
 * plain user-id -> address map, so that stays the simpler helper above.
 * Degrades to an empty list on failure, matching `emailsByUserId`.
 */
async function clubUserEmailRows(
  admin: MembershipClient,
  userIds: string[],
): Promise<ClubUserEmail[]> {
  if (!userIds.length) return [];
  const { data, error } = await userEmails(admin, userIds);
  if (error || !data) return [];
  return data.map((e) => ({
    user_id: e.user_id,
    email: e.email,
    email_confirmed_at: e.email_confirmed_at ?? null,
  }));
}

/** Load the service-role client. */
async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Stable content key so re-importing the same statement line is a no-op. */
function dedupeHash(row: {
  posted_at: string | null;
  amount_cents: number;
  description: string;
  reference: string | null;
}): string {
  return [row.posted_at ?? "", row.amount_cents, row.description, row.reference ?? ""].join("|");
}

/**
 * Bring someone's `member` role row in line with what they actually hold.
 *
 * The rule — an `active`, non-`trial`, `price_cents > 0` membership — already
 * existed in three places before this function did: inline in
 * `activateMembershipRow`, in `deriveLifecycleStatus`, and in the
 * `has_active_paid_membership` SQL helper that RLS uses to gate the members-only
 * calendar and blog comments. Only the SQL one is load-bearing for access; the
 * role row is a LABEL, read by the manager people directory and the agent API's
 * `list_users`. That is why a cancel used to leave someone reading as a member
 * long after their last membership closed: nothing ever took the label back.
 *
 * So this reconciles rather than only granting, and every caller that opens or
 * closes a membership goes through it.
 *
 * A failed read leaves the role exactly as it is. "The query fell over" and
 * "they hold nothing" must never be the same answer here: the second one
 * revokes, and revoking on a blip would strip the label off paid-up members en
 * masse. Same reason the write is logged rather than thrown — the membership
 * change it follows has already committed, and reporting it as failed invites a
 * retry that re-runs activation.
 */
export async function syncMemberRole(
  admin: MembershipClient,
  userId: string | null,
): Promise<void> {
  if (!userId) return;

  const { data: active, error } = await admin
    .from("memberships")
    .select("plan_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("price_cents", 0);
  if (error) {
    console.error(`[syncMemberRole] could not read memberships for ${userId}:`, error.message);
    return;
  }

  const planIds = [...new Set((active ?? []).map((m) => m.plan_id))];
  let shouldHold = false;
  if (planIds.length) {
    const { data: plans, error: planErr } = await admin
      .from("membership_plans")
      .select("id, kind")
      .in("id", planIds);
    if (planErr) {
      console.error(`[syncMemberRole] could not read plans for ${userId}:`, planErr.message);
      return;
    }
    shouldHold = (plans ?? []).some((p) => p.kind !== "trial");
  }

  // Only ever the `member` row: a manager who also stops paying keeps managing.
  const { error: writeErr } = shouldHold
    ? await admin
        .from("user_roles")
        .upsert({ user_id: userId, role: "member" }, { onConflict: "user_id,role" })
    : await admin.from("user_roles").delete().eq("user_id", userId).eq("role", "member");
  if (writeErr) {
    console.error(
      `[syncMemberRole] could not ${shouldHold ? "grant" : "revoke"} the member role for ${userId}:`,
      writeErr.message,
    );
  }
}

/**
 * Ceiling on the check-in rows read to count what each membership covered.
 * Well past club volumes; the warn below is what makes hitting it visible
 * rather than silently under-counting.
 */
const CHECKIN_COUNT_LIMIT = 5000;

/**
 * How many classes were checked in against each of these memberships.
 *
 * This is what decides whether the Delete button appears, so an under-count is
 * not cosmetic: it would offer a delete the server then refuses. Counting the
 * ids rather than issuing one exact count per membership keeps a 500-row invoice
 * list to a single query.
 *
 * Memberships with no check-ins are simply absent from the map, so read it with
 * `?? 0`.
 */
export async function checkinCountsByMembership(
  admin: MembershipClient,
  membershipIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!membershipIds.length) return counts;

  const { data, error } = await admin
    .from("session_checkins")
    .select("membership_id")
    .in("membership_id", membershipIds)
    .limit(CHECKIN_COUNT_LIMIT);
  // Throws rather than degrading to zero. "Nobody trained on this" is the answer
  // that offers an irreversible delete, and a failed read must not give it.
  if (error) throw new Error(error.message);
  if ((data ?? []).length >= CHECKIN_COUNT_LIMIT) {
    console.warn(
      `[checkinCountsByMembership] capped at ${CHECKIN_COUNT_LIMIT}; some counts truncated`,
    );
  }

  for (const row of data ?? []) {
    if (!row.membership_id) continue;
    counts.set(row.membership_id, (counts.get(row.membership_id) ?? 0) + 1);
  }
  return counts;
}

/** Human-readable validity/credit summary for a plan (used in emails/UI). */
function validityLabel(plan: MembershipPlanRow): string {
  if (plan.ends_on) return `${plan.name}, until ${formatDateOnly(plan.ends_on)}.`;
  if (plan.session_credits)
    return `${plan.session_credits} session${plan.session_credits === 1 ? "" : "s"} included.`;
  if (plan.kind === "insurance") return "Cover for a year from the payment date.";
  return "";
}

/** Client-safe projection of a membership joined with its plan. */
function projectMembership(m: MembershipRow, plan?: MembershipPlanRow) {
  return {
    id: m.id,
    plan_code: plan?.code ?? null,
    plan_name: plan?.name ?? null,
    kind: plan?.kind ?? null,
    status: m.status,
    is_student: m.is_student,
    price_cents: m.price_cents,
    payment_reference: m.payment_reference,
    payment_method: m.payment_method,
    paid_at: m.paid_at,
    starts_at: m.starts_at,
    ends_at: m.ends_at,
    sessions_remaining: m.sessions_remaining,
    session_date: m.session_date,
    created_at: m.created_at,
  };
}

/**
 * Authorise a membership: give it its dates and credits, mark it `active`, and
 * reconcile the member label. This is what lets somebody be checked in.
 *
 * **It says nothing about money.** Until recently this function also stamped
 * `paid_at` and the payment method, which made "this person may train" and "this
 * person has paid" the same act — so a manager letting somebody on the mat while
 * their transfer cleared was recording a payment that had not happened, and the
 * delete guard then refused to remove the row because "a payment is recorded
 * against it". Paying is now its own event: see `recordMembershipPayment`.
 *
 * No email either. Being authorised is not news on its own — the invoice that
 * goes out when the membership is raised already says they can start training —
 * and the one email left in the lifecycle belongs to the payment landing.
 */
/**
 * The columns that make a membership authorised, for a plan and a start instant.
 *
 * Shared by the two ways a membership gets there — written straight into the
 * INSERT when one is raised, and into the UPDATE when a closed one is reopened —
 * so a membership can never exist in the half-state those two used to allow: an
 * `active` row with no dates, which `isLive` reads as running forever.
 *
 * The plan resolves its own window: a dated plan runs exactly the range it was
 * set up with, a rolling plan (yearly insurance) runs from this instant, and
 * trial/casual plans end with their credits rather than on a date. No branch on
 * `plan.kind` here — `planMembershipWindow` reads `starts_on`/`ends_on`/
 * `duration_days` directly, so a new plan shape needs no new code path.
 */
function authorisedFields(plan: MembershipPlanRow, effectiveFrom?: string) {
  const { starts_at, ends_at } = planMembershipWindow(
    plan,
    effectiveFrom ?? new Date().toISOString(),
  );
  return {
    status: "active" as const,
    starts_at,
    ends_at,
    sessions_remaining: plan.session_credits ?? null,
  };
}

async function authoriseMembershipRow(
  admin: MembershipClient,
  membership: MembershipRow,
  plan: MembershipPlanRow,
  opts: {
    /**
     * The instant the membership should be treated as beginning from, when that
     * is not "right now". Only the auto-assigned trial passes one: it runs from
     * the day its waiver was SIGNED, not the day a manager got round to
     * approving it.
     */
    effectiveFrom?: string;
  } = {},
): Promise<void> {
  const { error } = await admin
    .from("memberships")
    .update(authorisedFields(plan, opts.effectiveFrom))
    .eq("id", membership.id);
  if (error) throw new Error(error.message);

  // The row we just wrote is now visible to the reconcile. Being authorised is
  // what makes somebody a member, paid or not, so this is where the label moves.
  await syncMemberRole(admin, membership.user_id);
}

/**
 * Record that a membership has been paid for.
 *
 * The only writer of `paid_at`, and therefore the only thing that can make a
 * membership undeletable. Reached two ways: bank reconciliation matching a
 * statement line, and a manager pressing "Mark as paid" for money that never
 * touched the club account (cash at the door).
 *
 * Idempotent on an already-paid row. It returns without writing rather than
 * refreshing the date, because the first record is the true one and a second
 * confirmation email to the member would be worse than useless. Reconciliation
 * can legitimately see the same invoice twice — a re-imported statement, a
 * manual match after an automatic one — so this is a normal path, not a guard
 * against misuse.
 */
export async function recordMembershipPayment(
  admin: MembershipClient,
  input: {
    membership: MembershipRow;
    plan?: MembershipPlanRow;
    method: MembershipRow["payment_method"];
    /** When the money actually moved, if that is not now (a bank posting date). */
    at?: string;
  },
): Promise<{ recorded: boolean }> {
  const { membership } = input;
  if (membership.paid_at) return { recorded: false };

  const paidAt = input.at ?? new Date().toISOString();
  // Compare-and-swap on `paid_at` still being null: two managers marking the
  // same invoice paid, or a manual match racing the reconciler, must record one
  // payment and send one email.
  const { data: claimed, error } = await admin
    .from("memberships")
    .update({ paid_at: paidAt, payment_method: input.method })
    .eq("id", membership.id)
    .is("paid_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  if ((claimed ?? []).length === 0) return { recorded: false };

  // Best-effort, and only after the write has committed: a send failure must not
  // report a recorded payment as a failure and invite a retry.
  if (membership.user_id) {
    try {
      const [{ data: profile }, emails] = await Promise.all([
        admin
          .from("profiles")
          .select("first_name, middle_name, last_name, preferred_name")
          .eq("user_id", membership.user_id)
          .maybeSingle(),
        emailsByUserId(admin, [membership.user_id]),
      ]);
      const email = emails.get(membership.user_id) ?? null;
      if (email) {
        const { sendMembershipPaidEmail } = await import("./membership-email.server");
        await sendMembershipPaidEmail({
          membershipId: membership.id,
          memberGreetingName: profile ? greetingName(profile) : "",
          memberEmail: email,
          planName: input.plan?.name ?? "your membership",
          validity: input.plan ? validityLabel(input.plan) : "",
          amount: formatCents(membership.price_cents),
        });
      }
    } catch (e) {
      console.error("[recordMembershipPayment] failed to send the payment email:", e);
    }
  }

  return { recorded: true };
}

/**
 * Guarantee a casual credit that a check-in just spent has an invoice or
 * receipt sitting in the member's inbox, independent of what happened when the
 * membership itself was raised.
 *
 * Reached from `applyCoverage` in checkin.functions.ts — the one place a
 * casual credit is actually consumed — rather than relying on `enrolMember`
 * alone, because the two moments can be far apart and the first email is not
 * guaranteed: a manager can raise the invoice with `send_email: false` (the
 * backfill case in `createMembershipForUser`), or the send can fail and be
 * swallowed, since every email in this lifecycle is best-effort. Someone who
 * actually trains on a casual credit must not be the one left with no record
 * of what they owe or paid for it.
 *
 * Both target emails are idempotent on the membership id
 * (`membership-payment-<id>` / `membership-paid-<id>`) — the same keys
 * `enrolMember` and `recordMembershipPayment` already send under — so calling
 * this a second time for a membership that was already emailed is a safe
 * provider-side no-op, not a duplicate landing in anyone's inbox.
 *
 * Which of the two goes out follows `paid_at`: unpaid still needs the "pay
 * this" invoice, paid needs the receipt, and either is the wrong email for the
 * other state.
 *
 * Awaited by its caller rather than fired-and-forgotten, matching every other
 * email in this lifecycle (`enrolMember`, `recordMembershipPayment`): the
 * production deploy target is Cloudflare, where work not awaited before the
 * response returns is not guaranteed to run at all, and a "guarantee" that can
 * silently not happen is worse than the door pausing for it. Best-effort only
 * in the sense that a failed or slow send is caught and logged, never thrown —
 * see the try/catch below.
 */
export async function ensureCasualInvoiceEmailed(
  admin: MembershipClient,
  membershipId: string,
): Promise<void> {
  try {
    const { data: membership, error } = await admin
      .from("memberships")
      .select("id, user_id, plan_id, price_cents, payment_reference, paid_at")
      .eq("id", membershipId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!membership || !membership.user_id) return;

    const [{ data: plan }, { data: profile }, emails] = await Promise.all([
      admin.from("membership_plans").select("*").eq("id", membership.plan_id).maybeSingle(),
      admin
        .from("profiles")
        .select("first_name, middle_name, last_name, preferred_name")
        .eq("user_id", membership.user_id)
        .maybeSingle(),
      emailsByUserId(admin, [membership.user_id]),
    ]);
    const email = emails.get(membership.user_id) ?? null;
    if (!email) return;

    if (membership.paid_at) {
      // Not folding in a bundled sibling here, on purpose: a receipt is
      // already never combined across a bundle anywhere in this app —
      // `recordMembershipPayment` sends one per row, because a bundle can be
      // reconciled or marked paid one invoice at a time. This matches that.
      const { sendMembershipPaidEmail } = await import("./membership-email.server");
      await sendMembershipPaidEmail({
        membershipId: membership.id,
        memberGreetingName: profile ? greetingName(profile) : "",
        memberEmail: email,
        planName: plan?.name ?? "your casual class",
        validity: plan ? validityLabel(plan) : "",
        amount: formatCents(membership.price_cents),
      });
      return;
    }

    if (!membership.payment_reference) return;

    // A mandatory insurance invoice can ride on this SAME reference
    // (`resolveInsuranceCover` + `enrolMember`'s bundling), combined into ONE
    // invoice email under this membership's id. If that combined send never
    // went out (the `send_email: false` backfill this guarantee exists for),
    // sending only this row's amount would under-bill the member for what they
    // actually owe — so an unpaid sibling on the same reference is folded in
    // exactly as `enrolMember` combines it.
    //
    // A CANCELLED sibling is excluded, the same rule `isUnpaid` and
    // `reconcileUnmatched` already use: a manager closed that invoice on
    // purpose, so it is owed nothing, and folding it back in here would bill
    // the member for a charge that was deliberately withdrawn.
    const { data: bundled } = await admin
      .from("memberships")
      .select("price_cents, plan_id")
      .eq("payment_reference", membership.payment_reference)
      .neq("id", membership.id)
      .neq("status", "cancelled")
      .is("paid_at", null);
    let totalCents = membership.price_cents;
    let planName = plan?.name ?? "your casual class";
    if (bundled?.length) {
      const { data: siblingPlans } = await admin
        .from("membership_plans")
        .select("id, name")
        .in(
          "id",
          bundled.map((b) => b.plan_id),
        );
      const nameById = new Map((siblingPlans ?? []).map((p) => [p.id, p.name]));
      for (const row of bundled) {
        totalCents += row.price_cents;
        const siblingName = nameById.get(row.plan_id);
        if (siblingName) planName = `${planName} + ${siblingName}`;
      }
    }
    // Nothing is owed, on this row or anything bundled with it.
    if (totalCents === 0) return;

    const { sendMembershipPaymentEmail } = await import("./membership-email.server");
    await sendMembershipPaymentEmail({
      membershipId: membership.id,
      memberName: profile ? profileFullName(profile) : "",
      memberGreetingName: profile ? greetingName(profile) : "",
      memberEmail: email,
      planName,
      amount: formatCents(totalCents),
      reference: membership.payment_reference,
      admin,
    });
  } catch (e) {
    console.error(`[ensureCasualInvoiceEmailed] failed for membership ${membershipId}:`, e);
  }
}

/**
 * Assign the club's free trial to a person, once ever: called when a manager
 * first approves their waiver (approved = visitor = trial assigned). Skips
 * silently if they ever had a trial membership or no trial plan exists. The
 * activation email is suppressed — the approval already sends their sign-in
 * link. Not a server function: a server-side helper for the approval flow.
 *
 * `signedAt` is the waiver's own signing time, and the trial runs from the start
 * of that day (`planMembershipWindow`) rather than from this instant. The rule
 * it encodes: a waiver must be signed BEFORE someone steps on the mat, but a
 * manager may not approve it until hours or days later — often it is signed at
 * the gym, at the door. Dating the trial from the approval would leave the class
 * they signed for uncovered, which is the wrong end of the process to measure.
 */
export async function assignTrialMembership(userId: string, signedAt: string): Promise<void> {
  const admin = await adminClient();

  // Every read throws rather than returning early: "the query failed" and "this
  // club has no trial plan" / "they already had one" are three different things,
  // and only the last two mean skip. The caller logs and retries on the next
  // approval, so a throw here costs a retry — a swallowed error would either
  // deny someone their trial or hand them a second one.
  const { data: trialPlans, error: tpErr } = await admin
    .from("membership_plans")
    .select("*")
    .eq("kind", "trial");
  if (tpErr) throw new Error(tpErr.message);
  const planIds = (trialPlans ?? []).map((p) => p.id);
  if (!planIds.length) return;

  // One free trial per person, ever (mirrors startMembership's rule).
  const { data: existing, error: exErr } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .in("plan_id", planIds)
    .limit(1)
    .maybeSingle();
  if (exErr) throw new Error(exErr.message);
  if (existing) return;

  const plan = (trialPlans ?? []).find((p) => p.is_active);
  if (!plan) return;

  const { data: who, error: whoErr } = await admin
    .from("profiles")
    .select("first_name, last_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (whoErr) throw new Error(whoErr.message);
  const surname = who?.last_name || who?.first_name || "";

  const { data: inserted, error } = await admin
    .from("memberships")
    .insert({
      user_id: userId,
      plan_id: plan.id,
      // Authorised on the spot, and never "paid": the trial is free, so there is
      // no payment to record and nothing to email. The approval that triggered
      // this already told them their account is live.
      ...authorisedFields(plan, signedAt),
      is_student: false,
      uts_student_number: null,
      price_cents: 0,
      payment_reference: buildPaymentReference(surname, userId),
      payment_method: "manual",
    })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(error?.message || "Could not create trial membership.");
  await syncMemberRole(admin, inserted.user_id);
}

// ---- Member: list active plans ----
//
// Behind `requireSupabaseAuth` (RLS as the caller, not the service role):
// `/membership` (inside the `_authenticated` group) is the only remaining
// reader. The public pricing page is deliberately NOT driven by this
// catalogue — with more than one dated plan on sale at once (e.g. this
// semester and next), a marketing page cannot show a single price, so
// `/pricing` is hand-written copy instead (see docs/memberships.md).
export const listMembershipPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("membership_plans")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description,
      kind: p.kind,
      public_price_cents: p.public_price_cents,
      student_price_cents: p.student_price_cents,
      session_credits: p.session_credits,
      starts_on: p.starts_on,
      ends_on: p.ends_on,
      duration_days: p.duration_days,
      // Always true — the query above already filters to active plans, but
      // `sellablePlans` (the same rule the purchase screen uses to drop a
      // dated plan once it ends) is typed against a shape that carries it.
      is_active: true as const,
    }));
  });

// ---- Member: my memberships + lifecycle ----
export const getMyMemberships = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const admin = await adminClient();
    const { deriveLifecycleStatus } = await import("@/lib/validation");

    const [
      { data: rows, error },
      { data: plans, error: plErr },
      { data: profile, error: prErr },
      { data: waiverRows, error: wErr },
      { count: sessionsAttended, error: cErr },
    ] = await Promise.all([
      admin
        .from("memberships")
        .select("*")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false }),
      admin.from("membership_plans").select("*"),
      // The student number lives on the profile; used to prefill the student
      // rate on the membership page.
      admin
        .from("profiles")
        .select("uts_student_number")
        .eq("user_id", context.userId)
        .maybeSingle(),
      // Waiver states feed the lifecycle: approved => visitor+, pending-only
      // => applicant.
      admin.from("waivers").select("approval_status").eq("user_id", context.userId).limit(100),
      // How many classes they have trained. Deliberately just the count: a
      // member has no business reading the club's coverage bookkeeping, and
      // "no cover" against a class they attended reads as an accusation.
      admin
        .from("session_checkins")
        .select("id", { count: "exact", head: true })
        .eq("user_id", context.userId),
    ]);
    // An errored waivers read would tell an approved member they are still a
    // lead on their own membership page; an errored plans read would price every
    // plan as if it had no kind. Neither may degrade to an empty list.
    if (error) throw new Error(error.message);
    if (plErr) throw new Error(plErr.message);
    if (wErr) throw new Error(wErr.message);
    // The profile is the exception: it supplies nothing but a prefill for the
    // student-number box, which the member can type themselves. Failing the
    // whole page over an empty prefill would cost them more than the prefill is
    // worth, so log it and render.
    if (prErr) console.error("[getMyMemberships] student-number prefill lookup failed:", prErr);
    // Same posture for the attendance count: it drives one sentence, and the
    // page hides that sentence at zero, so a failed count reads as "not shown"
    // rather than as a wrong number.
    if (cErr) console.error("[getMyMemberships] attendance count failed:", cErr);

    const hasApprovedWaiver = (waiverRows ?? []).some((w) => w.approval_status === "approved");
    const hasPendingWaiver = (waiverRows ?? []).length > 0 && !hasApprovedWaiver;
    const utsStudentNumber = profile?.uts_student_number ?? null;

    const planById = new Map((plans ?? []).map((p) => [p.id, p]));
    const memberships = (rows ?? []).map((r) => projectMembership(r, planById.get(r.plan_id)));
    const lifecycle = deriveLifecycleStatus({
      hasApprovedWaiver,
      hasPendingWaiver,
      // The generated Supabase types widen these enum columns to `string`; the
      // DB constrains them to the narrow unions deriveLifecycleStatus expects.
      memberships: (rows ?? []).map((r) => ({
        status: r.status as MembershipStatus,
        kind: (planById.get(r.plan_id)?.kind ?? "session") as MembershipPlanKind,
        price_cents: r.price_cents,
      })),
    });
    return {
      lifecycle,
      memberships,
      uts_student_number: utsStudentNumber,
      sessions_attended: sessionsAttended ?? 0,
    };
  });

/**
 * Has this person already had the trial plan they are asking for?
 *
 * Throws rather than degrading: a failed query and "they have not had a trial"
 * are different answers, and only the second one may hand out a free trial.
 * The refusal wording is the caller's, because the two callers speak to
 * different people — a member is told about their own trial, a manager about
 * somebody else's.
 */
async function hasUsedTrial(
  admin: MembershipClient,
  userId: string,
  planId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("plan_id", planId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * The club's insurance position for one person buying one plan: which plan sells
 * yearly cover, and how long their current cover still runs.
 *
 * Split out from the enrolment itself because the two callers make opposite
 * decisions with the same facts. A member buying for themselves may not train
 * uninsured, so `startMembership` refuses when cover is missing and the box is
 * unticked. A manager recording somebody's enrolment may be writing down history
 * that really did happen without cover, so they get the same default and are
 * allowed to override it.
 *
 * A trial or the insurance plan itself never bundles, and a club with no
 * insurance plan in the catalogue has nothing to enforce — both answer
 * "no plan, no cover to consider".
 */
export async function resolveInsuranceCover(
  admin: MembershipClient,
  userId: string,
  plan: MembershipPlanRow,
): Promise<{ insurancePlan: MembershipPlanRow | null; coverEndsAt: string | null }> {
  if (plan.kind === "trial" || plan.kind === "insurance")
    return { insurancePlan: null, coverEndsAt: null };

  const { data: insPlans, error: ipErr } = await admin
    .from("membership_plans")
    .select("*")
    .eq("kind", "insurance");
  if (ipErr) throw new Error(ipErr.message);
  const insurancePlanIds = new Set((insPlans ?? []).map((p) => p.id));
  const insurancePlan =
    (insPlans ?? []).filter((p) => p.is_active).sort((a, b) => a.sort_order - b.sort_order)[0] ??
    null;

  if (insurancePlanIds.size === 0) return { insurancePlan, coverEndsAt: null };

  // Cover they already hold: an ACTIVE insurance membership whose ends_at is
  // still ahead. A pending insurance invoice is a promise, not cover, and stays
  // out.
  const { data: coverRows, error: covErr } = await admin
    .from("memberships")
    .select("ends_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .in("plan_id", [...insurancePlanIds]);
  if (covErr) throw new Error(covErr.message);
  const nowIso = new Date().toISOString();
  const coverEndsAt =
    (coverRows ?? [])
      .map((r) => r.ends_at)
      .filter((e): e is string => e != null && e > nowIso)
      .sort()
      .pop() ?? null;

  return { insurancePlan, coverEndsAt };
}

/**
 * Raise somebody's invoice for a plan and, if asked, bundle yearly insurance
 * onto the same payment reference.
 *
 * Everything mechanical about enrolment lives here: pricing, the bank-safe
 * reference, reusing an unpaid invoice instead of raising a second one, and the
 * payment email. What it deliberately does NOT decide is whether this person is
 * allowed to buy this plan — that is policy, and it differs by who is asking.
 * The caller resolves the plan and settles the policy first, then hands the
 * answers in.
 *
 * `insurancePlan` non-null is the instruction to bundle: one transfer, one
 * reference, two invoices that reconcile together.
 */
export async function enrolMember(
  admin: MembershipClient,
  input: {
    userId: string;
    plan: MembershipPlanRow;
    utsStudentNumber: string | null;
    /** The casual class this is for; ignored by every other plan kind. */
    sessionDate?: string | null;
    insurancePlan: MembershipPlanRow | null;
    /** False records the invoice without telling them about it. */
    sendEmail?: boolean;
  },
): Promise<{ ok: true; authorised: true; reference: string | null }> {
  const { userId, plan, insurancePlan } = input;

  // Student status is derived server-side from the number's presence, so the
  // number is the single source of truth: a non-empty UTS student number gets
  // the student rate. The client's is_student flag is not trusted for pricing.
  const utsStudentNumber = input.utsStudentNumber?.trim() || null;
  const isStudent = isUtsStudent(utsStudentNumber);
  const price = computeMembershipPrice(plan, isStudent);

  // Resolve the name once: the surname drives the human-friendly reference, and
  // the full name is used in emails. Falls back gracefully when they have not
  // signed a waiver yet.
  // Throws rather than falling back to an empty surname: this reference is
  // written onto the invoice and is what the member quotes on their transfer and
  // the manager reads off the bank statement. A degraded read would mint a
  // permanently nameless reference on a real invoice, where retrying costs one
  // more click.
  const { data: who, error: whoErr } = await admin
    .from("profiles")
    .select("first_name, middle_name, last_name, preferred_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (whoErr) throw new Error(whoErr.message);
  const surname = who?.last_name || who?.first_name || "";

  // Per-session plans carry a session date (defaults to today) so each drop-in
  // payment reconciles to its own session; other plan kinds have no date.
  const sessionDate =
    plan.kind === "session" ? input.sessionDate || new Date().toISOString().slice(0, 10) : null;

  // Stable, bank-safe reference derived from the member (see buildPaymentReference).
  const reference = buildPaymentReference(
    surname,
    userId,
    sessionDate || undefined,
    plan.starts_on ?? undefined,
  );

  // Idempotency: reuse an existing enrollment for the same plan (and session,
  // for casual) rather than creating duplicate rows / re-notifying on a
  // repeated "Choose". A dated plan needs no extra filter here any more: a
  // different window IS a different plan_id now, so filtering on plan_id
  // alone already tells "Semester 2 2026" and "Semester 1 2027" apart. The
  // invoice email is keyed on the membership id, so resolving back to the same
  // row is also what stops a second copy going out.
  //
  // The rule is UNPAID and not cancelled, which is one rule for every plan kind.
  // It used to be `status = 'pending'`, back when raising a membership left it
  // waiting; now every membership is authorised the moment it exists, so status
  // says nothing about whether this is a repeat. What makes a row a duplicate is
  // that the club is still owed for the one already there.
  //
  // A PAID membership is deliberately not reusable: buying the same plan again
  // after paying for it is a real second purchase, not a double press. Nor is a
  // cancelled one, which a manager closed on purpose.
  const reuseBase = admin
    .from("memberships")
    .select("*")
    .eq("user_id", userId)
    .eq("plan_id", plan.id)
    .is("paid_at", null)
    // Only a LIVE enrolment is reusable. An expired unpaid row is a dead
    // invoice: reusing it would hand back its old reference and leave
    // `starts_at`/`ends_at` in the past, so somebody re-buying yearly insurance
    // a year later would pay for cover whose window had already closed. Nothing
    // re-runs `authorisedFields` on reuse, so the window has to still be good.
    .eq("status", "active");
  // A failed read here defeats exactly what the reuse is for: it would report
  // no existing enrollment, insert a duplicate invoice and re-send the payment
  // email for one the member already has.
  const { data: existingUnpaid, error: pendErr } = await (
    sessionDate ? reuseBase.eq("session_date", sessionDate) : reuseBase
  )
    .limit(1)
    .maybeSingle();
  if (pendErr) throw new Error(pendErr.message);

  let inserted: MembershipRow;
  if (existingUnpaid) {
    inserted = existingUnpaid;
  } else {
    const insert = {
      user_id: userId,
      plan_id: plan.id,
      // Authorised on the spot. Raising a membership IS the authorisation: the
      // invoice goes out and they can be checked in from that moment, with the
      // money outstanding until somebody records it.
      ...authorisedFields(plan),
      is_student: isStudent,
      uts_student_number: utsStudentNumber,
      price_cents: price,
      payment_reference: reference,
      payment_method: "bank_transfer",
      session_date: sessionDate,
    };
    const { data: row, error: insErr } = await admin
      .from("memberships")
      .insert(insert)
      .select("*")
      .single();
    if (insErr || !row) throw new Error(insErr?.message || "Could not create membership.");
    inserted = row;
  }

  // The bundled insurance invoice rides on the SAME payment reference as the
  // plan invoice, so a member with no cover pays one transfer for both and
  // reconciliation settles them together. An unpaid insurance invoice from an
  // earlier attempt is reused with its reference and price refreshed to this
  // purchase — an unpaid row holds no decisions to preserve. A PAID one is left
  // alone: rewriting the reference on a settled invoice would break the trail
  // back to the transfer that paid it.
  let insuranceInvoice: MembershipRow | null = null;
  if (insurancePlan) {
    const insurancePrice = computeMembershipPrice(insurancePlan, isStudent);
    const { data: existingIns, error: eiErr } = await admin
      .from("memberships")
      .select("*")
      .eq("user_id", userId)
      .eq("plan_id", insurancePlan.id)
      .is("paid_at", null)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (eiErr) throw new Error(eiErr.message);
    if (existingIns) {
      const { data: updated, error: uErr } = await admin
        .from("memberships")
        .update({
          payment_reference: inserted.payment_reference,
          price_cents: insurancePrice,
          is_student: isStudent,
          uts_student_number: utsStudentNumber,
        })
        .eq("id", existingIns.id)
        .select("*")
        .single();
      if (uErr || !updated) throw new Error(uErr?.message || "Could not create membership.");
      insuranceInvoice = updated;
    } else {
      const { data: row, error: insErr } = await admin
        .from("memberships")
        .insert({
          user_id: userId,
          plan_id: insurancePlan.id,
          ...authorisedFields(insurancePlan),
          is_student: isStudent,
          uts_student_number: utsStudentNumber,
          price_cents: insurancePrice,
          payment_reference: inserted.payment_reference,
          payment_method: "bank_transfer",
          session_date: null,
        })
        .select("*")
        .single();
      if (insErr || !row) throw new Error(insErr?.message || "Could not create membership.");
      insuranceInvoice = row;
    }
  }

  // Being authorised is what makes somebody a member, so the label follows the
  // rows just written rather than waiting for a payment.
  await syncMemberRole(admin, userId);

  // A free plan has no invoice, so there is nothing to send and nothing to owe.
  // It is already authorised by the insert above.
  if (price === 0 && !insuranceInvoice) {
    return { ok: true as const, authorised: true as const, reference: null as string | null };
  }

  // Email the member their bank-transfer instructions + notify managers. A
  // bundle gets ONE email with the combined amount and both plan names — the
  // member does not care that it lands as two invoices on our side.
  if (input.sendEmail !== false) {
    try {
      const emails = await emailsByUserId(admin, [userId]);
      const email = emails.get(userId) ?? null;
      if (email) {
        const totalCents = price + (insuranceInvoice?.price_cents ?? 0);
        const planName = insuranceInvoice ? `${plan.name} + ${insurancePlan!.name}` : plan.name;
        const { sendMembershipPaymentEmail } = await import("./membership-email.server");
        await sendMembershipPaymentEmail({
          membershipId: inserted.id,
          memberName: who ? profileFullName(who) : "",
          memberGreetingName: who ? greetingName(who) : "",
          memberEmail: email,
          planName,
          amount: formatCents(totalCents),
          reference: inserted.payment_reference,
          admin,
        });
      }
    } catch (e) {
      console.error("[enrolMember] failed to send payment email:", e);
    }
  }

  // `authorised` is always true now: raising a membership is what authorises it.
  // A non-null `reference` is what says money is still owed — that, and not the
  // status, is the question a caller actually has.
  return {
    ok: true as const,
    authorised: true as const,
    reference: inserted.payment_reference,
  };
}

// ---- Member: start a membership ----
export const startMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => startMembershipSchema.parse(d))
  .handler(async ({ data, context }) => {
    if (data.hp) return { ok: true as const, activated: false, reference: null as string | null };
    const admin = await adminClient();

    const { data: plan, error: planErr } = await admin
      .from("membership_plans")
      .select("*")
      .eq("code", data.plan_code)
      .maybeSingle();
    if (planErr) throw new Error(planErr.message);
    // Covers a deactivated plan and a dated plan whose `ends_on` has already
    // passed — the same rule the purchase screen uses to decide which cards to
    // show, so a stale page can't buy something no longer on sale.
    if (!plan || !sellablePlans([plan], new Date().toISOString()).length)
      throw new Error("That plan is not currently available. Refresh the page and try again.");

    // One free trial per member. This is the member-driven half of the pair with
    // `assignTrialMembership`, so it is the easier one to hit: the member can
    // keep pressing until a read fails.
    if (plan.kind === "trial" && (await hasUsedTrial(admin, context.userId, plan.id)))
      throw new Error("You've already started your free trial.");

    // ---- Yearly insurance: required cover bundled into the purchase ----
    //
    // Refusing is the insurance plan existing plus cover missing plus the
    // caller opting out: all three. A club with no insurance plan never blocks a
    // purchase here, and `include_insurance` from a covered member is their own
    // choice to renew early.
    const { insurancePlan, coverEndsAt } = await resolveInsuranceCover(admin, context.userId, plan);
    if (insurancePlan && !coverEndsAt && !data.include_insurance) {
      throw new Error(
        "Yearly insurance is required to train with us. Keep it selected and choose the plan again.",
      );
    }

    return enrolMember(admin, {
      userId: context.userId,
      plan,
      utsStudentNumber: data.uts_student_number ?? null,
      sessionDate: data.session_date,
      insurancePlan:
        insurancePlan && (data.include_insurance || !coverEndsAt) ? insurancePlan : null,
    });
  });

/**
 * Create or update a membership plan: insert when `input.id` is absent,
 * update that row in place when present. `code` is supplied by the caller —
 * unlike the old per-semester upsert, a plan's code is not derived from
 * anything else, so there is no key to re-derive and check for drift. Shared
 * by the manager server function below and the manager agent's
 * `save_membership_plan` action, so a manager and an agent go through the
 * exact same write.
 */
export async function saveMembershipPlanRow(
  admin: MembershipClient,
  input: SavePlanInput,
): Promise<{ ok: true; id: string }> {
  const values = {
    code: input.code,
    name: input.name,
    description: input.description || null,
    kind: input.kind,
    public_price_cents: input.public_price_cents,
    student_price_cents: input.student_price_cents,
    duration_days: input.duration_days,
    session_credits: input.session_credits,
    is_active: input.is_active,
    sort_order: input.sort_order,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
  };

  if (input.id) {
    const { error } = await admin.from("membership_plans").update(values).eq("id", input.id);
    if (error) throw new Error(error.message);
    return { ok: true, id: input.id };
  }
  const { data: created, error } = await admin
    .from("membership_plans")
    .insert(values)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, id: created.id };
}

// ---- Manager: create / update a plan ----
export const saveMembershipPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => savePlanSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();
    return saveMembershipPlanRow(admin, data);
  });

/**
 * All plans, incl. inactive ones, sorted for display. Exported (unlike most
 * helpers here) so the manager agent route can call it directly, the same
 * way it imports `filePaperWaiver` from `waiver.functions.ts` -- a plain
 * shared function, not a `createServerFn`.
 */
export async function listMembershipPlanRows(
  admin: MembershipClient,
): Promise<MembershipPlanRow[]> {
  const { data, error } = await admin
    .from("membership_plans")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// `managerAttentionItems` — the "needs attention" list behind /notifications —
// moved to `manager-notifications.functions.ts`. It draws on two subsystems now
// (membership windows and unanswered contact messages), so composing it here
// would make every future source a membership concern. This module still owns
// the membership half: `listMembershipPlanRows` above, and the rule that reads
// it (`sellableWindowNotifications`, in validation.ts).

// ---- Member: how to pay ----
/**
 * The club's bank account, for the member's own membership page: the same
 * details the invoice email renders, read through the same helper, so the page
 * and the email can never quote different bank details.
 *
 * Readable by any signed-in person, not only one with an invoice outstanding:
 * these are the club's own receiving details, they are already emailed to
 * whoever owes money, and a member who paid last week still has reason to check
 * where they sent it.
 *
 * Never throws. It reports a failed read (`ok: false`) separately from details
 * that were never published, because the page says different things about them.
 */
export const getPaymentInstructions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const admin = await adminClient();
    const { readClubPaymentDetails } = await import("@/lib/club-settings.server");
    return await readClubPaymentDetails(admin);
  });

// ---- Manager: club settings (the club's bank account) ----
/**
 * The form's current values, plus whatever free text is left in the old
 * `invoice_payment_instructions` row. That legacy string is shown read-only
 * beside an empty form so a manager can copy the account details across; nothing
 * member-facing renders it any more.
 */
export const getClubSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();
    const { readClubPaymentDetails, getInvoiceInstructions } =
      await import("@/lib/club-settings.server");
    const [{ ok, details }, legacyInstructions] = await Promise.all([
      readClubPaymentDetails(admin),
      getInvoiceInstructions(admin),
    ]);
    // A manager editing the club's account must not be shown an empty form when
    // the truth is "we could not read it": saving would then overwrite real
    // details with blanks.
    if (!ok) throw new Error("Could not read the club settings. Try again.");
    return { details, legacy_instructions: legacyInstructions };
  });

export const saveClubSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveClubSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();
    const { error } = await admin.from("club_settings").upsert(
      {
        key: "invoice_payment_details",
        value: JSON.stringify(data),
        updated_at: new Date().toISOString(),
        updated_by: context.userId,
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ---- Manager: list all plans (incl. inactive) ----
export const listAllMembershipPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();
    return listMembershipPlanRows(admin);
  });

// ---- Manager: list memberships (with member name/email) ----
export const listMemberships = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const [{ data: rows, error }, { data: plans, error: plErr }] = await Promise.all([
      admin.from("memberships").select("*").order("created_at", { ascending: false }).limit(500),
      admin.from("membership_plans").select("*"),
    ]);
    if (error) throw new Error(error.message);
    // An errored plans read would render every invoice with no plan name and no
    // kind, which reads as "these invoices are for nothing" rather than as a
    // failure. Same for the profiles read below and the member names.
    if (plErr) throw new Error(plErr.message);
    const planById = new Map((plans ?? []).map((p) => [p.id, p]));

    // Resolve each member's display name from their profile and their email
    // from the auth user (the one email store).
    const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
    const nameByUser = new Map<string, string>();
    let emailByUser = new Map<string, string>();
    if (userIds.length) {
      const [{ data: profiles, error: prErr }, emails] = await Promise.all([
        admin
          .from("profiles")
          .select("user_id, first_name, middle_name, last_name, preferred_name")
          .in("user_id", userIds),
        emailsByUserId(admin, userIds),
      ]);
      if (prErr) throw new Error(prErr.message);
      emailByUser = emails;
      for (const p of profiles ?? []) {
        nameByUser.set(p.user_id, nameWithPreferred(p));
      }
    }

    // What each invoice would take with it if deleted, so the screen can gate
    // the button without a round trip per row.
    const checkinCounts = await checkinCountsByMembership(
      admin,
      (rows ?? []).map((r) => r.id),
    );

    return (rows ?? []).map((r) => ({
      ...projectMembership(r, planById.get(r.plan_id)),
      user_id: r.user_id,
      uts_student_number: r.uts_student_number,
      checkin_count: checkinCounts.get(r.id) ?? 0,
      member_name: (r.user_id ? nameByUser.get(r.user_id) : null) || null,
      member_email: (r.user_id ? emailByUser.get(r.user_id) : null) ?? null,
    }));
  });

// ---- Manager: list every person known to the club (one row per user) ----
export const listClubUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();
    const { aggregateClubUsers, profileUserIds, LEADS_LIMIT, CHECKINS_LIMIT } =
      await import("@/lib/club-users");

    const [
      { data: profiles, error: pErr },
      { data: rows, error: mErr },
      { data: plans, error: plErr },
      { data: waivers, error: wErr },
      { data: checkins, error: cErr },
      { data: leadRows, error: lErr },
    ] = await Promise.all([
      admin
        .from("profiles")
        .select(
          "user_id, first_name, middle_name, last_name, preferred_name, phone, uts_student_number, gi_size, belt_size, created_at",
        )
        .limit(5000),
      admin.from("memberships").select("*").order("created_at", { ascending: false }).limit(2000),
      admin.from("membership_plans").select("*"),
      // ALL waivers: approved => visitor+, pending-only => applicant.
      admin.from("waivers").select("user_id, signed_at, approval_status").limit(5000),
      // Attendance, counted per person. Only the user id is read: this is
      // "classes trained", not "credits used".
      admin.from("session_checkins").select("user_id").limit(CHECKINS_LIMIT),
      // Interest registrations are the LEAD phase of the funnel; the
      // aggregation drops any whose email already belongs to a person.
      admin
        .from("interest_registrations")
        .select("email, name, phone, created_at")
        .order("created_at", { ascending: false })
        .limit(LEADS_LIMIT),
    ]);
    // Every read here fails the whole screen. A failed query must never reach
    // the aggregation as an empty list: an errored waivers read would drop every
    // applicant and visitor in the club to `lead` with "Waiver: none", and a
    // manager filtering for who needs approving would see no work waiting.
    if (pErr) throw new Error(pErr.message);
    if (mErr) throw new Error(mErr.message);
    if (plErr) throw new Error(plErr.message);
    if (wErr) throw new Error(wErr.message);
    if (cErr) throw new Error(cErr.message);
    if (lErr) throw new Error(lErr.message);

    const leads = (leadRows ?? []) as ClubUserLead[];

    // Surface the caps rather than silently truncating. A truncated check-in
    // read would under-report attendance, which reads as a real number.
    if ((checkins ?? []).length >= CHECKINS_LIMIT) {
      console.warn(
        `[listClubUsers] session_checkins capped at ${CHECKINS_LIMIT}; counts truncated`,
      );
    }
    if (leads.length >= LEADS_LIMIT) {
      console.warn(
        `[listClubUsers] interest_registrations capped at ${LEADS_LIMIT}; leads truncated`,
      );
    }

    const memberships = (rows ?? []) as MembershipRow[];
    const profileRows = (profiles ?? []) as ClubUserProfile[];
    const waiverRows = (waivers ?? []) as ClubUserWaiver[];

    // Roles + emails are scoped to the club's known people.
    const userIds = profileUserIds(profileRows);
    let rolesRows: { user_id: string; role: string }[] = [];
    let emails: ClubUserEmail[] = [];
    if (userIds.length) {
      // The email RPC is the one deliberate degradation (see clubUserEmailRows);
      // a failed roles read must not silently strip everyone's manager pill.
      const [{ data: roles, error: rErr }, resolved] = await Promise.all([
        admin.from("user_roles").select("user_id, role").in("user_id", userIds),
        clubUserEmailRows(admin, userIds),
      ]);
      if (rErr) throw new Error(rErr.message);
      rolesRows = (roles ?? []) as { user_id: string; role: string }[];
      emails = resolved;
    }

    // The one shared aggregation code path (also used by the manager agent API).
    return aggregateClubUsers({
      profiles: profileRows,
      emails,
      waivers: waiverRows,
      leads,
      memberships: memberships.map((m) => ({
        user_id: m.user_id,
        plan_id: m.plan_id,
        status: m.status,
        price_cents: m.price_cents,
        is_student: m.is_student,
        uts_student_number: m.uts_student_number,
        created_at: m.created_at,
      })),
      plans: (plans ?? []).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      roles: rolesRows,
      checkins: checkins ?? [],
    });
  });

// ---- Manager: activate / cancel a membership ----
export const setMembershipStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setMembershipStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const { data: membership, error } = await admin
      .from("memberships")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!membership) throw new Error("Membership not found.");

    if (data.status === "active") {
      // Already active — don't re-authorise, which would recompute the dates and
      // credits of a membership somebody may already have trained on.
      if (membership.status === "active") {
        return { ok: true as const, id: data.id, status: data.status };
      }
      // Reopening a cancelled or expired membership. It gives back the dates and
      // credits and nothing else: whether it was ever paid for is a separate
      // fact this must not touch, in either direction.
      //
      // Both outcomes stop it, but they are not the same problem: "Plan not
      // found." for a broken query sends a manager to the plan catalogue to look
      // for a plan that is sitting right there.
      const { data: plan, error: planErr } = await admin
        .from("membership_plans")
        .select("*")
        .eq("id", membership.plan_id)
        .maybeSingle();
      if (planErr) throw new Error(planErr.message);
      if (!plan) throw new Error("Plan not found.");
      await authoriseMembershipRow(admin, membership, plan);
    } else {
      const { error: uErr } = await admin
        .from("memberships")
        .update({ status: data.status })
        .eq("id", data.id);
      if (uErr) throw new Error(uErr.message);
      // Closing a membership can be the moment somebody stops being a member.
      // Access itself is gated live by `has_active_paid_membership`, so it has
      // already closed by now; this is the label catching up.
      await syncMemberRole(admin, membership.user_id);
    }
    return { ok: true as const, id: data.id, status: data.status };
  });

/**
 * Delete a membership outright, or refuse and say what would have to change.
 *
 * Shared by the manager screens and the agent's `delete_invoice`, so both
 * refuse for the same three reasons with the same words. Returns the blockers
 * alongside the message rather than only throwing, because the agent reports
 * them as structured `error.details` while a screen shows the sentence.
 *
 * The check-in count is what makes this more than a status check: a class
 * someone actually attended is a fact, and `session_checkins.membership_id` is
 * `ON DELETE SET NULL`, so deleting underneath it would silently turn a covered
 * class into an uncovered one rather than failing. `bank_transactions` points at
 * memberships the same way, but a matched transaction always implies `paid_at`,
 * so the paid blocker already covers it.
 */
export async function deleteMembershipRow(
  admin: MembershipClient,
  id: string,
): Promise<{ ok: true; id: string } | { ok: false; blockers: MembershipDeleteBlocker[] }> {
  const { data: membership, error } = await admin
    .from("memberships")
    .select("id, user_id, status, paid_at, price_cents")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!membership) throw new Error("Membership not found.");

  const { count, error: cErr } = await admin
    .from("session_checkins")
    .select("id", { count: "exact", head: true })
    .eq("membership_id", id);
  // Throws rather than assuming zero. "Nobody trained on this" is the answer
  // that permits an irreversible delete, and a failed count must never be able
  // to give it.
  if (cErr) throw new Error(cErr.message);

  const blockers = whyMembershipCannotBeDeleted({
    paid_at: membership.paid_at,
    checkin_count: count ?? 0,
  });
  if (blockers.length) return { ok: false as const, blockers };

  const { error: dErr } = await admin.from("memberships").delete().eq("id", id);
  if (dErr) throw new Error(dErr.message);
  await syncMemberRole(admin, membership.user_id);
  return { ok: true as const, id };
}

// ---- Manager: record a payment against a membership ----
export const markMembershipPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => markMembershipPaidSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const { data: membership, error } = await admin
      .from("memberships")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!membership) throw new Error("Membership not found.");
    if (membership.price_cents === 0)
      throw new Error("There is nothing to pay on a free membership.");

    // Not fatal: the plan only decorates the receipt, and refusing to record a
    // payment because a plan name could not be read would be the wrong trade.
    const { data: plan } = await admin
      .from("membership_plans")
      .select("*")
      .eq("id", membership.plan_id)
      .maybeSingle();

    const { recorded } = await recordMembershipPayment(admin, {
      membership,
      plan: plan ?? undefined,
      method: data.payment_method,
    });
    return { ok: true as const, id: data.id, recorded };
  });

// ---- Manager: delete a membership ----
export const deleteMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deleteMembershipSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const result = await deleteMembershipRow(await adminClient(), data.id);
    if (!result.ok) throw new Error(membershipDeleteMessage(result.blockers));
    return { ok: true as const, id: result.id };
  });

/**
 * Raise a membership for somebody else: the manager's counterpart to a member
 * pressing "Choose" on `/membership`.
 *
 * Shared by the manager screen and the agent's `create_membership`. Two things
 * differ from the member's own purchase, and both follow from who is asking:
 *
 *   - **Any plan, not just a sellable one.** A manager recording an enrolment is
 *     often writing down something that already happened, so last semester's
 *     plan has to be reachable. The member's own screen still refuses it.
 *   - **Insurance is their call.** A member may not train uninsured, so
 *     `startMembership` refuses. A manager backfilling a real enrolment that
 *     happened without cover is recording history, not selling anything.
 *
 * What does NOT differ: the invoice lands `pending`, exactly like one the member
 * raised. Activating is what grants the label and emails them, and it stays a
 * separate, deliberate press.
 */
export async function createMembershipForUser(
  admin: MembershipClient,
  input: CreateMembershipInput,
): Promise<{ ok: true; authorised: true; reference: string | null }> {
  const { data: plan, error: planErr } = await admin
    .from("membership_plans")
    .select("*")
    .eq("code", input.plan_code)
    .maybeSingle();
  if (planErr) throw new Error(planErr.message);
  if (!plan) throw new Error(`No plan with the code "${input.plan_code}".`);

  // One free trial per person, ever, however it is raised. A manager can give
  // somebody a second casual class; the free trial is the one thing that is
  // once, and going through a manager does not make it twice.
  if (plan.kind === "trial" && (await hasUsedTrial(admin, input.user_id, plan.id)))
    throw new Error("They have already had their free trial.");

  const { insurancePlan } = await resolveInsuranceCover(admin, input.user_id, plan);

  return enrolMember(admin, {
    userId: input.user_id,
    plan,
    utsStudentNumber: input.uts_student_number ?? null,
    sessionDate: input.session_date,
    insurancePlan: input.include_insurance ? insurancePlan : null,
    sendEmail: input.send_email,
  });
}

// ---- Manager: raise a membership for somebody ----
export const createMembership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createMembershipSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return createMembershipForUser(await adminClient(), data);
  });

// ---- Manager: import a bank statement + auto-reconcile ----
export const importBankStatement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => importBankStatementSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const importBatch = crypto.randomUUID();
    const inserts = data.rows.map((r) => {
      const normalized = {
        posted_at: r.posted_at || null,
        amount_cents: r.amount_cents,
        description: r.description || "",
        reference: r.reference || null,
      };
      return {
        import_batch: importBatch,
        ...normalized,
        raw: r,
        dedupe_hash: dedupeHash(normalized),
        status: "unmatched" as const,
      };
    });

    // Idempotent insert — re-importing the same lines is a no-op.
    const { error: insErr } = await admin
      .from("bank_transactions")
      .upsert(inserts, { onConflict: "dedupe_hash", ignoreDuplicates: true });
    if (insErr) throw new Error(insErr.message);

    // Reconcile every currently-unmatched transaction against pending memberships.
    const summary = await reconcileUnmatched(admin);
    return { ok: true as const, imported: data.rows.length, ...summary };
  });

// ---- Manager: list recent bank transactions ----
export const listBankTransactions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const admin = await adminClient();
    const { data, error } = await admin
      .from("bank_transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    // Project to a serializable shape (the raw JSONB is not needed client-side).
    return (data ?? []).map((t) => ({
      id: t.id,
      posted_at: t.posted_at,
      amount_cents: t.amount_cents,
      description: t.description,
      reference: t.reference,
      status: t.status,
      matched_membership_id: t.matched_membership_id,
      matched_at: t.matched_at,
      created_at: t.created_at,
    }));
  });

// ---- Manager: manually link a transaction to a membership ----
export const matchTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => matchTransactionSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();

    const { data: membership, error: mErr } = await admin
      .from("memberships")
      .select("*")
      .eq("id", data.membership_id)
      .maybeSingle();
    if (mErr) throw new Error(mErr.message);
    if (!membership) throw new Error("Membership not found.");

    // Same distinction as setMembershipStatus: a manager matching a payment by
    // hand needs to know the difference between a missing plan and a read that
    // fell over.
    const { data: plan, error: planErr } = await admin
      .from("membership_plans")
      .select("*")
      .eq("id", membership.plan_id)
      .maybeSingle();
    if (planErr) throw new Error(planErr.message);
    if (!plan) throw new Error("Plan not found.");

    // Matching a statement line to an invoice records a PAYMENT. It no longer
    // authorises anything: the membership has been authorised since it was
    // raised, and the money arriving is a separate fact about the same row.
    await recordMembershipPayment(admin, {
      membership,
      plan,
      method: "bank_transfer",
    });
    const { error: tErr } = await admin
      .from("bank_transactions")
      .update({
        matched_membership_id: membership.id,
        matched_at: new Date().toISOString(),
        matched_by: context.userId,
        status: "matched",
      })
      .eq("id", data.transaction_id);
    if (tErr) throw new Error(tErr.message);
    return { ok: true as const };
  });

/**
 * Match every unmatched bank transaction against pending memberships by unique
 * reference + amount, activating each match. Returns a small summary, where a
 * null `unmatched` means the trailing count could not be read (see below).
 *
 * Exported for its tests: it takes its client as a parameter, which the server
 * functions wrapping it do not, so this is the one part of the import path a
 * unit test can drive.
 */
export async function reconcileUnmatched(
  admin: MembershipClient,
): Promise<{ matched: number; unmatched: number | null }> {
  // Reconciliation reports a count back to the manager, so a failed read must
  // not read as "nothing to match": an errored unpaid-memberships query would
  // otherwise answer an import with "0 matched" while every payment sat there
  // waiting, and the manager would go chasing members who had already paid.
  const { data: txns, error: txErr } = await admin
    .from("bank_transactions")
    .select("*")
    .eq("status", "unmatched");
  if (txErr) throw new Error(txErr.message);
  // What a statement line can settle is an UNPAID invoice, whatever its status.
  // This used to look for `status = 'pending'`, which worked only while raising
  // a membership left it waiting for money; now every membership is authorised
  // from the moment it exists, so status says nothing about what is owed and
  // filtering on it would match nothing at all.
  //
  // Cancelled invoices stay out: a manager closed those deliberately, and a
  // stray transfer against one is something to look at by hand, not to settle
  // silently.
  const { data: pending, error: pdErr } = await admin
    .from("memberships")
    .select("*")
    .is("paid_at", null)
    .neq("status", "cancelled")
    // Priced only. A free membership is never owed for, so leaving trials in the
    // pool put every one the club has ever granted permanently up for matching —
    // and a trial's reference has no date component, so it is byte-identical to
    // the one minted for any undated purchase by the same person. It would join
    // that reference's bundle, add 0 to the total so the sum still matched, and
    // get stamped paid with a receipt for "Free".
    .gt("price_cents", 0);
  if (pdErr) throw new Error(pdErr.message);
  const pendingList = (pending ?? []) as MembershipRow[];
  const planIds = [...new Set(pendingList.map((m) => m.plan_id))];
  const planById = new Map<string, MembershipPlanRow>();
  if (planIds.length) {
    const { data: plans, error: plErr } = await admin
      .from("membership_plans")
      .select("*")
      .in("id", planIds);
    if (plErr) throw new Error(plErr.message);
    for (const p of (plans ?? []) as MembershipPlanRow[]) planById.set(p.id, p);
  }

  let matched = 0;
  const remaining = new Set(pendingList.map((m) => m.id));
  for (const txn of (txns ?? []) as BankTransactionRow[]) {
    // Some banks put the payer's reference in a dedicated field rather than the
    // narrative, so match against both. References are stable per member (not
    // globally unique), so a transaction can in principle match more than one of
    // a member's pending rows — when it does, leave it for manual matching
    // rather than guess.
    const haystack = `${txn.description} ${txn.reference ?? ""}`;
    const hits = pendingList.filter(
      (m) =>
        remaining.has(m.id) &&
        matchesMembershipReference(haystack, m.payment_reference, txn.amount_cents, m.price_cents),
    );
    if (hits.length !== 1) {
      if (hits.length > 1) {
        console.warn(
          `[reconcile] transaction ${txn.id} matched ${hits.length} pending memberships; leaving for manual match`,
        );
        continue;
      }
      // Bundle match: a purchase with bundled insurance lands as TWO invoices
      // sharing one payment reference, settled with ONE combined transfer. No
      // single invoice's price equals such an amount, but every invoice
      // carrying the reference belongs to the one transaction, so the group
      // is unambiguous by construction.
      const refGroups = new Map<string, MembershipRow[]>();
      for (const m of pendingList) {
        if (!remaining.has(m.id)) continue;
        if (!haystackContainsRef(haystack, m.payment_reference)) continue;
        const group = refGroups.get(m.payment_reference) ?? [];
        group.push(m);
        refGroups.set(m.payment_reference, group);
      }
      const bundles = [...refGroups.values()].filter(
        (group) =>
          group.length > 1 && group.reduce((sum, m) => sum + m.price_cents, 0) === txn.amount_cents,
      );
      if (bundles.length !== 1) {
        if (bundles.length > 1) {
          console.warn(
            `[reconcile] transaction ${txn.id} matched ${bundles.length} bundles; leaving for manual match`,
          );
        }
        continue;
      }
      const group = bundles[0];
      // Record the payment against every invoice in the bundle. One failure must
      // not abort the others (same per-row rule as the single match below), and
      // only a fully settled bundle marks the transaction matched: leaving a
      // half-paid bundle for the manager is better than silently losing one
      // invoice.
      let allRecorded = true;
      for (const hit of group) {
        const plan = planById.get(hit.plan_id);
        if (!plan) {
          allRecorded = false;
          continue;
        }
        try {
          await recordMembershipPayment(admin, { membership: hit, plan, method: "bank_transfer" });
          remaining.delete(hit.id);
        } catch (e) {
          allRecorded = false;
          console.error(
            `[reconcile] recording the payment failed for membership ${hit.id} (transaction ${txn.id}); left for a manager to resolve:`,
            e,
          );
        }
      }
      if (allRecorded) {
        await admin
          .from("bank_transactions")
          .update({
            matched_membership_id: group[0].id,
            matched_at: new Date().toISOString(),
            status: "matched",
          })
          .eq("id", txn.id);
        matched++;
      }
      continue;
    }

    const hit = hits[0];
    const plan = planById.get(hit.plan_id);
    if (!plan) continue;
    // One bad invoice must not abort every other transaction in this statement.
    // The bank_transactions row this txn came from was already committed by
    // importBankStatement before this function ever ran, so an uncaught throw
    // here would leave it permanently unmatched: every future import hits the
    // same pair and fails the same way, with nothing after it in the loop ever
    // getting a chance.
    try {
      await recordMembershipPayment(admin, { membership: hit, plan, method: "bank_transfer" });
    } catch (e) {
      console.error(
        `[reconcile] recording the payment failed for membership ${hit.id} (transaction ${txn.id}); left unmatched for a manager to resolve:`,
        e,
      );
      continue;
    }
    await admin
      .from("bank_transactions")
      .update({
        matched_membership_id: hit.id,
        matched_at: new Date().toISOString(),
        status: "matched",
      })
      .eq("id", txn.id);
    remaining.delete(hit.id);
    matched++;
  }

  // The one read here that does not throw. Every match above has already
  // committed, so failing now would report a reconciliation that worked as a
  // failed import, and would throw away the matched count with it. `null` says
  // "we could not count", which is neither the false all-clear of reporting 0
  // nor a lie about what happened. The manager's screen reloads the unmatched
  // list straight after either way, so the real answer arrives regardless.
  const { count, error: cErr } = await admin
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("status", "unmatched");
  if (cErr) {
    console.error("[reconcile] could not count unmatched transactions after reconciling:", cErr);
    return { matched, unmatched: null };
  }
  return { matched, unmatched: count ?? 0 };
}
