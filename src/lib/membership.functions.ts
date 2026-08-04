import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildPaymentReference,
  computeMembershipPrice,
  DEFAULT_INVOICE_INSTRUCTIONS,
  formatCents,
  importBankStatementSchema,
  INSURANCE_YEAR_DAYS,
  isUtsStudent,
  haystackContainsRef,
  matchesMembershipReference,
  matchTransactionSchema,
  membershipWindowNotifications,
  normalizeRef,
  greetingName,
  nameWithPreferred,
  profileFullName,
  saveClubSettingsSchema,
  saveSemesterSchema,
  savePlanSchema,
  sellableSemesters,
  semesterMembershipWindow,
  setMembershipStatusSchema,
  startMembershipSchema,
} from "@/lib/validation";
import type { MembershipPlanKind, MembershipStatus, SaveSemesterInput } from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";
import type {
  BankTransactionRow,
  ClubSemesterRow,
  MembershipClient,
  MembershipDatabase,
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

// Public/anon reads. Mirrors the pattern in waiver.functions.ts but typed with
// the memberships-aware Database so `.from("membership_plans")` type-checks.
function serverSupabase(): MembershipClient {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<MembershipDatabase>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
          h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/** Load the service-role client. */
async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Throw unless the caller holds the `manager` role (checked via the RLS RPC). */
async function requireManager(context: { supabase: MembershipClient; userId: string }) {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
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

/** Human-readable validity/credit summary for a plan (used in emails/UI). */
function validityLabel(plan: MembershipPlanRow, semester?: ClubSemesterRow | null): string {
  if (plan.kind === "period" && semester)
    return `${semester.name}, until ${formatDateOnly(semester.ends_on)}.`;
  if (plan.session_credits)
    return `${plan.session_credits} session${plan.session_credits === 1 ? "" : "s"} included.`;
  if (plan.kind === "insurance") return "Cover for a year from the payment date.";
  return "";
}

/** Client-safe projection of a membership joined with its plan (and semester, if any). */
function projectMembership(m: MembershipRow, plan?: MembershipPlanRow, semester?: ClubSemesterRow) {
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
    semester_code: semester?.code ?? null,
    semester_name: semester?.name ?? null,
    created_at: m.created_at,
  };
}

/**
 * Activate a membership: set the active dates/credits, grant the `member` role
 * for paid plans, and email the member a confirmation. This is the single
 * activation code path shared by bank reconciliation and manual manager action
 * (and where a future Stripe webhook would also land).
 */
async function activateMembershipRow(
  admin: MembershipClient,
  membership: MembershipRow,
  plan: MembershipPlanRow,
  opts: { paymentMethod: MembershipRow["payment_method"]; sendEmail?: boolean },
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();

  // Each kind computes its dates its own way, with no manager-editable
  // duration knob: a `period` (membership) plan runs exactly the window the
  // member picked at purchase, an `insurance` plan runs a fixed year from
  // payment, and `trial`/`session` plans end with their credits, not a date.
  //
  // `startMembership` requires and validates `semester_id` before a `period`
  // plan's row is even inserted, so a missing one here means the row was
  // created some other way; fail loudly rather than silently falling back to
  // a rolling window nobody asked for.
  let semester: ClubSemesterRow | null = null;
  let startsAt = nowIso;
  let endsAt: string | null = null;
  if (plan.kind === "period") {
    if (!membership.semester_id)
      throw new Error("This membership has no membership window selected.");
    const { data: sem, error: semErr } = await admin
      .from("club_semesters")
      .select("*")
      .eq("id", membership.semester_id)
      .maybeSingle();
    if (semErr) throw new Error(semErr.message);
    if (!sem) throw new Error("The selected membership window no longer exists.");
    semester = sem;
    const window = semesterMembershipWindow(sem);
    startsAt = window.starts_at;
    endsAt = window.ends_at;
  } else if (plan.kind === "insurance") {
    endsAt = new Date(now.getTime() + INSURANCE_YEAR_DAYS * 86_400_000).toISOString();
  }

  const patch: Partial<MembershipRow> = {
    status: "active",
    paid_at: nowIso,
    starts_at: startsAt,
    ends_at: endsAt,
    sessions_remaining: plan.session_credits ?? null,
    payment_method: opts.paymentMethod,
  };
  const { error } = await admin.from("memberships").update(patch).eq("id", membership.id);
  if (error) throw new Error(error.message);

  const isPaid = plan.kind !== "trial" && membership.price_cents > 0;

  // Auto-grant the `member` role on a paid activation (idempotent — the table
  // has UNIQUE(user_id, role)).
  // Logged rather than thrown: the membership is already active by this point,
  // so failing here would report a paid-up activation as an error and invite a
  // retry that resets the dates and re-sends the confirmation email. A missing
  // role is recoverable by hand; the log is what makes it findable.
  if (membership.user_id && isPaid) {
    const { error: roleErr } = await admin
      .from("user_roles")
      .upsert(
        { user_id: membership.user_id, role: "member" },
        { onConflict: "user_id,role", ignoreDuplicates: true },
      );
    if (roleErr) {
      console.error(
        `[activateMembershipRow] could not grant the member role to ${membership.user_id}:`,
        roleErr,
      );
    }
  }

  // Confirmation email (best-effort — never fail activation on a send error).
  // The email lives on the auth user (the one email store); the name on the
  // profile. Suppressed via opts.sendEmail for the auto-assigned trial, whose
  // approval already emails a sign-in link.
  if (membership.user_id && opts.sendEmail !== false) {
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
        const memberGreetingName = profile ? greetingName(profile) : "";
        const { sendMembershipActivatedEmail } = await import("./membership-email.server");
        await sendMembershipActivatedEmail({
          membershipId: membership.id,
          memberGreetingName,
          memberEmail: email,
          planName: plan.name,
          validity: validityLabel(plan, semester),
        });
      }
    } catch (e) {
      console.error("[activateMembershipRow] failed to send activation email:", e);
    }
  }
}

/**
 * Assign the club's free trial to a person, once ever: called when a manager
 * first approves their waiver (approved = visitor = trial assigned). Skips
 * silently if they ever had a trial membership or no trial plan exists. The
 * activation email is suppressed — the approval already sends their sign-in
 * link. Not a server function: a server-side helper for the approval flow.
 */
export async function assignTrialMembership(userId: string): Promise<void> {
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
      status: "pending",
      is_student: false,
      uts_student_number: null,
      price_cents: 0,
      payment_reference: buildPaymentReference(surname, userId),
      payment_method: "manual",
    })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(error?.message || "Could not create trial membership.");
  await activateMembershipRow(admin, inserted, plan, { paymentMethod: "manual", sendEmail: false });
}

// ---- Public: list active plans ----
export const listMembershipPlans = createServerFn({ method: "GET" }).handler(async () => {
  const supabase = serverSupabase();
  const { data, error } = await supabase
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
  }));
});

/**
 * All semesters, soonest-starting first, optionally restricted to active
 * ones. Exported (unlike most helpers here) so the manager agent route can
 * call it directly, the same way it imports `filePaperWaiver` from
 * `waiver.functions.ts` -- a plain shared function, not a `createServerFn`.
 */
export async function listSemesterRows(
  client: MembershipClient,
  opts: { activeOnly?: boolean } = {},
): Promise<ClubSemesterRow[]> {
  let query = client.from("club_semesters").select("*").order("starts_on", { ascending: true });
  if (opts.activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ---- Public: list active semesters (for the pricing page + purchase flow) ----
export const listSemesters = createServerFn({ method: "GET" }).handler(async () => {
  const supabase = serverSupabase();
  const rows = await listSemesterRows(supabase, { activeOnly: true });
  return rows.map((s) => ({
    code: s.code,
    name: s.name,
    year: s.year,
    half: s.half,
    starts_on: s.starts_on,
    ends_on: s.ends_on,
    is_active: s.is_active,
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
      { data: semesters, error: semErr },
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
      admin.from("club_semesters").select("*"),
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
    // The semester read is the exception, same posture as the profile prefill
    // below: it only decorates which semester an invoice names, and the raw
    // starts_at/ends_at already on the row are the source of truth either way.
    if (semErr) console.error("[getMyMemberships] semester lookup failed:", semErr);
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
    const semesterById = new Map((semesters ?? []).map((s) => [s.id, s]));
    const memberships = (rows ?? []).map((r) =>
      projectMembership(
        r,
        planById.get(r.plan_id),
        r.semester_id ? semesterById.get(r.semester_id) : undefined,
      ),
    );
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
      .eq("is_active", true)
      .maybeSingle();
    if (planErr) throw new Error(planErr.message);
    if (!plan) throw new Error("That plan is not available.");

    // One free trial per member.
    //
    // The read throws rather than degrading, for the same reason the guard in
    // assignTrialMembership does: a failed query and "they have not had a trial"
    // are different answers, and only the second one may hand out a trial. This
    // is the member-driven half of that pair, so a swallowed error here is the
    // easier one to hit — the member can keep pressing until a read fails.
    if (plan.kind === "trial") {
      const { data: existing, error: exErr } = await admin
        .from("memberships")
        .select("id")
        .eq("user_id", context.userId)
        .eq("plan_id", plan.id)
        .limit(1)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (existing) throw new Error("You've already started your free trial.");
    }

    // A window-anchored (`period`) plan requires the member to pick which
    // membership window — restricted to the same short list the purchase UI
    // offers (the one running now, plus the next one), so a stale or made-up
    // code can't buy a window that isn't actually for sale. Resolved
    // server-side rather than trusted from the client, same posture as
    // `is_student` below.
    let semester: ClubSemesterRow | null = null;
    if (plan.kind === "period") {
      const chosenCode = data.semester_code?.trim();
      if (!chosenCode) throw new Error("Choose which membership window you're joining for.");
      const allSemesters = await listSemesterRows(admin, { activeOnly: true });
      const offered = sellableSemesters(allSemesters, new Date().toISOString());
      semester = offered.find((s) => s.code === chosenCode) ?? null;
      if (!semester) {
        throw new Error(
          "That membership window isn't currently available to join. Refresh the page and try again.",
        );
      }
    }

    // Student status is derived server-side from the number's presence, so the
    // number is the single source of truth: a non-empty UTS student number gets
    // the student rate. The client's is_student flag is not trusted for pricing.
    const utsStudentNumber = data.uts_student_number?.trim() || null;
    const isStudent = isUtsStudent(utsStudentNumber);
    const price = computeMembershipPrice(plan, isStudent);

    // ---- Yearly insurance: required cover bundled into the purchase ----
    //
    // Every paid training product (session or period) needs current insurance
    // cover. A member whose cover is ongoing may buy without adding it; a
    // member with none gets it bundled as a second invoice on the same
    // payment reference, so one transfer pays for both. The trial (free) and
    // insurance itself never bundle. If the club has no insurance plan in the
    // catalogue there is nothing to enforce, so the check drops away.
    let insurancePlan: MembershipPlanRow | null = null;
    let addInsurance = false;
    if (plan.kind !== "trial" && plan.kind !== "insurance") {
      const { data: insPlans, error: ipErr } = await admin
        .from("membership_plans")
        .select("*")
        .eq("kind", "insurance");
      if (ipErr) throw new Error(ipErr.message);
      const insurancePlanIds = new Set((insPlans ?? []).map((p) => p.id));
      insurancePlan =
        (insPlans ?? [])
          .filter((p) => p.is_active)
          .sort((a, b) => a.sort_order - b.sort_order)[0] ?? null;

      let coverEndsAt: string | null = null;
      if (insurancePlanIds.size > 0) {
        // Cover the member already holds: an ACTIVE insurance membership whose
        // ends_at is still ahead. A pending insurance invoice is a promise,
        // not cover, and stays out.
        const { data: coverRows, error: covErr } = await admin
          .from("memberships")
          .select("ends_at")
          .eq("user_id", context.userId)
          .eq("status", "active")
          .in("plan_id", [...insurancePlanIds]);
        if (covErr) throw new Error(covErr.message);
        const nowIso = new Date().toISOString();
        coverEndsAt =
          (coverRows ?? [])
            .map((r) => r.ends_at)
            .filter((e): e is string => e != null && e > nowIso)
            .sort()
            .pop() ?? null;
      }

      // Refusing is the insurance plan existing plus cover missing plus the
      // caller opting out: all three. A club with no insurance plan never
      // blocks a purchase here, and `include_insurance` from a covered member
      // is their own choice to renew early.
      if (insurancePlan && !coverEndsAt && !data.include_insurance) {
        throw new Error(
          "Yearly insurance is required to train with us. Keep it selected and choose the plan again.",
        );
      }
      addInsurance = Boolean(insurancePlan && (data.include_insurance || !coverEndsAt));
    }

    // Resolve the member's name once: the surname drives the human-friendly
    // reference, and the full name is used in emails. Falls back gracefully when
    // the member has not signed a waiver yet.
    // Throws rather than falling back to an empty surname: this reference is
    // written onto the invoice and is what the member quotes on their transfer
    // and the manager reads off the bank statement. A degraded read would mint a
    // permanently nameless reference on a real invoice, where retrying costs the
    // member one more click.
    const { data: who, error: whoErr } = await admin
      .from("profiles")
      .select("first_name, middle_name, last_name, preferred_name")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (whoErr) throw new Error(whoErr.message);
    const surname = who?.last_name || who?.first_name || "";

    // Per-session plans carry a session date (defaults to today) so each drop-in
    // payment reconciles to its own session; other plan kinds have no date.
    const sessionDate =
      plan.kind === "session" ? data.session_date || new Date().toISOString().slice(0, 10) : null;

    // Stable, bank-safe reference derived from the member (see buildPaymentReference).
    const reference = buildPaymentReference(
      surname,
      context.userId,
      sessionDate || undefined,
      semester?.code,
    );

    // Idempotency: reuse an existing pending enrollment for the same plan (and
    // session, for casual, or semester, for a semester plan) rather than
    // creating duplicate rows / re-notifying on a repeated "Choose". Without the
    // semester filter, buying semester 2 while a semester 1 invoice was still
    // pending would silently reuse the semester 1 row and charge for the wrong
    // one. The email send below is also idempotency-keyed.
    const pendingBase = admin
      .from("memberships")
      .select("*")
      .eq("user_id", context.userId)
      .eq("plan_id", plan.id)
      .eq("status", "pending");
    // A failed read here defeats exactly what the reuse is for: it would report
    // no pending enrollment, insert a duplicate invoice and re-send the payment
    // email for one the member already has.
    const { data: existingPending, error: pendErr } = await (
      sessionDate
        ? pendingBase.eq("session_date", sessionDate)
        : semester
          ? pendingBase.eq("semester_id", semester.id)
          : pendingBase
    )
      .limit(1)
      .maybeSingle();
    if (pendErr) throw new Error(pendErr.message);

    let inserted: MembershipRow;
    if (existingPending) {
      inserted = existingPending;
    } else {
      const insert = {
        user_id: context.userId,
        plan_id: plan.id,
        status: "pending",
        is_student: isStudent,
        uts_student_number: utsStudentNumber,
        price_cents: price,
        payment_reference: reference,
        payment_method: "bank_transfer",
        session_date: sessionDate,
        semester_id: semester?.id ?? null,
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
    // reconciliation activates them together. A pending insurance invoice from
    // an earlier attempt is reused with its reference and price refreshed to
    // this purchase — an unpaid row holds no decisions to preserve.
    let insuranceInvoice: MembershipRow | null = null;
    if (addInsurance && insurancePlan) {
      const insurancePrice = computeMembershipPrice(insurancePlan, isStudent);
      const { data: existingIns, error: eiErr } = await admin
        .from("memberships")
        .select("*")
        .eq("user_id", context.userId)
        .eq("plan_id", insurancePlan.id)
        .eq("status", "pending")
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
            user_id: context.userId,
            plan_id: insurancePlan.id,
            status: "pending",
            is_student: isStudent,
            uts_student_number: utsStudentNumber,
            price_cents: insurancePrice,
            payment_reference: inserted.payment_reference,
            payment_method: "bank_transfer",
            session_date: null,
            semester_id: null,
          })
          .select("*")
          .single();
        if (insErr || !row) throw new Error(insErr?.message || "Could not create membership.");
        insuranceInvoice = row;
      }
    }

    // Free plans (the trial) activate immediately; paid plans await a transfer.
    if (price === 0) {
      await activateMembershipRow(admin, inserted, plan, { paymentMethod: "manual" });
      if (!insuranceInvoice) {
        return { ok: true as const, activated: true, reference: null as string | null };
      }
    }

    // Email the member their bank-transfer instructions + notify managers. A
    // bundle gets ONE email with the combined amount and both plan names — the
    // member does not care that it lands as two invoices on our side.
    try {
      const emails = await emailsByUserId(admin, [context.userId]);
      const email = emails.get(context.userId) ?? null;
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
      console.error("[startMembership] failed to send payment email:", e);
    }

    return {
      ok: true as const,
      activated: price === 0,
      reference: inserted.payment_reference,
    };
  });

// ---- Manager: create / update a plan ----
export const saveMembershipPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => savePlanSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();

    const values = {
      code: data.code,
      name: data.name,
      description: data.description || null,
      kind: data.kind,
      public_price_cents: data.public_price_cents,
      student_price_cents: data.student_price_cents,
      session_credits: data.session_credits,
      is_active: data.is_active,
      sort_order: data.sort_order,
    };

    if (data.id) {
      const { error } = await admin.from("membership_plans").update(values).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { ok: true as const, id: data.id };
    }
    const { data: created, error } = await admin
      .from("membership_plans")
      .insert(values)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, id: created.id };
  });

/**
 * Create or update a club semester (membership window). Upserts by (year, half)
 * -- the code is always derived here, never taken from the caller, so it can
 * never disagree with the DB's own CHECK tying `code` to `year`/`half`. Shared
 * by the manager server function below and the manager agent's
 * `save_membership_window` action, so a manager and an agent go through the
 * exact same write.
 */
export async function saveSemester(
  admin: MembershipClient,
  input: SaveSemesterInput,
): Promise<{ code: string; created: boolean }> {
  const code = `${input.year}-s${input.half}`;
  const { data: existing, error: findErr } = await admin
    .from("club_semesters")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  if (!existing) {
    const { error } = await admin.from("club_semesters").insert({
      code,
      name: input.name,
      year: input.year,
      half: input.half,
      starts_on: input.starts_on,
      ends_on: input.ends_on,
      is_active: input.is_active ?? true,
    });
    if (error) throw new Error(error.message);
    return { code, created: true };
  }

  const patch: Partial<ClubSemesterRow> = {
    name: input.name,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
  };
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  const { error } = await admin.from("club_semesters").update(patch).eq("code", code);
  if (error) throw new Error(error.message);
  return { code, created: false };
}

// ---- Manager: list all semesters (incl. inactive) ----
export const listAllSemesters = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    return listSemesterRows(admin);
  });

// ---- Manager: create / update a semester ----
export const saveMembershipSemester = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveSemesterSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    return saveSemester(admin, data);
  });

// ---- Manager: dashboard notifications ----
//
// The dashboard's "needs attention" list. The rules live in pure functions
// (validation.ts, unit-tested); this handler is only auth + data fetch.
export const managerNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    const windows = await listSemesterRows(admin);
    return membershipWindowNotifications(windows, new Date().toISOString());
  });

// ---- Manager: club settings (invoice payment instructions) ----
export const getClubSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    const { data, error } = await admin
      .from("club_settings")
      .select("value")
      .eq("key", "invoice_payment_instructions")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      invoice_payment_instructions: data?.value?.trim() ? data.value : DEFAULT_INVOICE_INSTRUCTIONS,
    };
  });

export const saveClubSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveClubSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    const { error } = await admin.from("club_settings").upsert(
      {
        key: "invoice_payment_instructions",
        value: data.invoice_payment_instructions,
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
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();
    const { data, error } = await admin
      .from("membership_plans")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// ---- Manager: list memberships (with member name/email) ----
export const listMemberships = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();

    const [
      { data: rows, error },
      { data: plans, error: plErr },
      { data: semesters, error: semErr },
    ] = await Promise.all([
      admin.from("memberships").select("*").order("created_at", { ascending: false }).limit(500),
      admin.from("membership_plans").select("*"),
      admin.from("club_semesters").select("*"),
    ]);
    if (error) throw new Error(error.message);
    // An errored plans read would render every invoice with no plan name and no
    // kind, which reads as "these invoices are for nothing" rather than as a
    // failure. Same for the profiles read below and the member names.
    if (plErr) throw new Error(plErr.message);
    // The semester read is decoration only (which semester an invoice names);
    // the raw starts_at/ends_at on the row are the source of truth either way.
    if (semErr) console.error("[listMemberships] semester lookup failed:", semErr);
    const planById = new Map((plans ?? []).map((p) => [p.id, p]));
    const semesterById = new Map((semesters ?? []).map((s) => [s.id, s]));

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

    return (rows ?? []).map((r) => ({
      ...projectMembership(
        r,
        planById.get(r.plan_id),
        r.semester_id ? semesterById.get(r.semester_id) : undefined,
      ),
      user_id: r.user_id,
      uts_student_number: r.uts_student_number,
      member_name: (r.user_id ? nameByUser.get(r.user_id) : null) || null,
      member_email: (r.user_id ? emailByUser.get(r.user_id) : null) ?? null,
    }));
  });

// ---- Manager: list every person known to the club (one row per user) ----
export const listClubUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
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
          "user_id, first_name, middle_name, last_name, preferred_name, phone, uts_student_number, created_at",
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
    await requireManager(context as { supabase: MembershipClient; userId: string });
    const admin = await adminClient();

    const { data: membership, error } = await admin
      .from("memberships")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!membership) throw new Error("Membership not found.");

    if (data.status === "active") {
      // Already active — don't re-run activation (it would reset the dates and
      // re-send the confirmation email).
      if (membership.status === "active") {
        return { ok: true as const, id: data.id, status: data.status };
      }
      // Both outcomes stop the activation, but they are not the same problem:
      // "Plan not found." for a broken query sends a manager to the plan
      // catalogue to look for a plan that is sitting right there.
      const { data: plan, error: planErr } = await admin
        .from("membership_plans")
        .select("*")
        .eq("id", membership.plan_id)
        .maybeSingle();
      if (planErr) throw new Error(planErr.message);
      if (!plan) throw new Error("Plan not found.");
      await activateMembershipRow(admin, membership, plan, {
        paymentMethod: membership.payment_method || "manual",
      });
    } else {
      const { error: uErr } = await admin
        .from("memberships")
        .update({ status: data.status })
        .eq("id", data.id);
      if (uErr) throw new Error(uErr.message);
    }
    return { ok: true as const, id: data.id, status: data.status };
  });

// ---- Manager: import a bank statement + auto-reconcile ----
export const importBankStatement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => importBankStatementSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });
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
    await requireManager(context as { supabase: MembershipClient; userId: string });
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
    await requireManager(context as { supabase: MembershipClient; userId: string });
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

    if (membership.status !== "active") {
      await activateMembershipRow(admin, membership, plan, { paymentMethod: "bank_transfer" });
    }
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
  // not read as "nothing to match": an errored pending-memberships query would
  // otherwise answer an import with "0 matched" while every payment sat there
  // waiting, and the manager would go chasing members who had already paid.
  const { data: txns, error: txErr } = await admin
    .from("bank_transactions")
    .select("*")
    .eq("status", "unmatched");
  if (txErr) throw new Error(txErr.message);
  const { data: pending, error: pdErr } = await admin
    .from("memberships")
    .select("*")
    .eq("status", "pending");
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
      // Activate every invoice in the bundle. One failure must not abort the
      // others (same per-row rule as the single match below), and only a fully
      // activated bundle marks the transaction matched: leaving a half-paid
      // bundle for the manager is better than silently losing one invoice.
      let allActivated = true;
      for (const hit of group) {
        const plan = planById.get(hit.plan_id);
        if (!plan) {
          allActivated = false;
          continue;
        }
        try {
          await activateMembershipRow(admin, hit, plan, { paymentMethod: "bank_transfer" });
          remaining.delete(hit.id);
        } catch (e) {
          allActivated = false;
          console.error(
            `[reconcile] bundle activation failed for membership ${hit.id} (transaction ${txn.id}); left for a manager to resolve:`,
            e,
          );
        }
      }
      if (allActivated) {
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
    // One bad invoice (e.g. a period row with no window selected, which
    // activateMembershipRow refuses rather than silently defaulting) must not
    // abort every other transaction in this statement. The bank_transactions
    // row this txn came from was already committed by importBankStatement
    // before this function ever ran, so an uncaught throw here would leave it
    // permanently unmatched: every future import hits the same pair and fails
    // the same way, with nothing after it in the loop ever getting a chance.
    try {
      await activateMembershipRow(admin, hit, plan, { paymentMethod: "bank_transfer" });
    } catch (e) {
      console.error(
        `[reconcile] activation failed for membership ${hit.id} (transaction ${txn.id}); left unmatched for a manager to resolve:`,
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
