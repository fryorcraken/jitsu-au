// Manager: everything known about ONE person, for the user detail screen.
//
// The list screen (`listClubUsers`) answers "who does the club know"; this
// answers "who is this person": their profile, their memberships, and every
// waiver they ever submitted with the full frozen submission so a manager can
// read what was signed without leaving the page.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  deriveWaiverListStatuses,
  managerEmailChangeSchema,
  nameWithPreferred,
  normalizeEmail,
} from "@/lib/validation";
import type { MembershipClient } from "@/lib/membership-types";
import type { ClubUserEmail } from "@/lib/club-users";

/** Max waiver / membership rows one person's page pulls. */
const WAIVERS_LIMIT = 100;
const MEMBERSHIPS_LIMIT = 100;

/** Throw unless the caller holds the `manager` role (checked via the RLS RPC). */
async function requireManager(context: { supabase: MembershipClient; userId: string }) {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

export const getClubUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const { aggregateClubUsers } = await import("@/lib/club-users");

    const [
      { data: profile, error: pErr },
      { data: waivers, error: wErr },
      { data: memberships, error: mErr },
      { data: plans, error: plErr },
      { data: roles, error: rErr },
      { data: emailRows, error: emailErr },
    ] = await Promise.all([
      admin.from("profiles").select("*").eq("user_id", data.userId).maybeSingle(),
      admin
        .from("waivers")
        .select("*")
        .eq("user_id", data.userId)
        .order("signed_at", { ascending: false })
        .limit(WAIVERS_LIMIT),
      admin
        .from("memberships")
        .select("*")
        .eq("user_id", data.userId)
        .order("created_at", { ascending: false })
        .limit(MEMBERSHIPS_LIMIT),
      admin.from("membership_plans").select("id, name, kind"),
      admin.from("user_roles").select("user_id, role").eq("user_id", data.userId),
      admin.rpc("user_emails", { _user_ids: [data.userId] }),
    ]);
    // Every read except the email RPC fails the whole page. This is the screen a
    // manager decides an approval from, so "the query failed" must never render
    // as "there is nothing there": an errored memberships read would otherwise
    // feed an empty list to the aggregation below and show a paid-up member as a
    // visitor with no memberships. `listClubUsers` holds the same line for the
    // directory it lists this person in.
    if (pErr) throw new Error(pErr.message);
    if (wErr) throw new Error(wErr.message);
    if (mErr) throw new Error(mErr.message);
    if (plErr) throw new Error(plErr.message);
    if (rErr) throw new Error(rErr.message);
    if (!profile) throw new Error("User not found.");

    const waiverRows = waivers ?? [];
    const membershipRows = memberships ?? [];
    const planRows = plans ?? [];
    const planById = new Map(planRows.map((p) => [p.id, p]));

    // Surface the caps rather than silently showing a partial history. Both
    // read newest first, so what falls off is ancient; note the waiver cap can
    // in principle drop an old submission that was approved most recently
    // (status is derived by approved_at, the query truncates by signed_at).
    if (waiverRows.length >= WAIVERS_LIMIT) {
      console.warn(`[getClubUser] waivers capped at ${WAIVERS_LIMIT}; older submissions truncated`);
    }
    if (membershipRows.length >= MEMBERSHIPS_LIMIT) {
      console.warn(
        `[getClubUser] memberships capped at ${MEMBERSHIPS_LIMIT}; older ones truncated`,
      );
    }

    // The RPC is service-role only and can fail; degrade to a missing email
    // rather than failing the whole page (same posture as the list screen). A
    // person always HAS an email — it lives on their login record — so log it:
    // the screen can only say the lookup failed, and nothing else would.
    if (emailErr) console.error("[getClubUser] email lookup failed:", emailErr);
    const emails = ((emailRows ?? []) as ClubUserEmail[]).map((e) => ({
      user_id: e.user_id,
      email: e.email,
      email_confirmed_at: e.email_confirmed_at ?? null,
    }));

    // One aggregation path for the funnel phase and the headline fields: reuse
    // the shared aggregator on a single-person input rather than re-deriving.
    const [summary] = aggregateClubUsers({
      profiles: [profile],
      emails,
      waivers: waiverRows.map((w) => ({
        user_id: w.user_id,
        signed_at: w.signed_at,
        approval_status: w.approval_status,
      })),
      leads: [],
      memberships: membershipRows.map((m) => ({
        user_id: m.user_id,
        plan_id: m.plan_id,
        status: m.status,
        price_cents: m.price_cents,
        is_student: m.is_student,
        uts_student_number: m.uts_student_number,
        created_at: m.created_at,
      })),
      plans: planRows,
      roles: roles ?? [],
    });

    const statuses = deriveWaiverListStatuses(waiverRows);

    return {
      // Only the derived headline fields, not the whole aggregate. Its
      // `uts_student_number` in particular falls back to a number captured on a
      // membership, which is exactly what the Profile card must not show — so
      // don't ship it under a name that invites someone to render it.
      user: {
        name: summary.name,
        email: summary.email,
        email_confirmed_at: summary.email_confirmed_at,
        phone: summary.phone,
        roles: summary.roles,
        lifecycle_status: summary.lifecycle_status,
        first_seen_at: summary.first_seen_at,
      },
      // Straight off the `profiles` row, so the screen can show the club's live
      // record as it actually is. Deliberately NOT taken from the aggregated
      // summary above, which fills gaps from other tables (its student number
      // falls back to one captured on a membership) — that would show the
      // record as complete while the column driving student pricing is null.
      profile: {
        preferred_name: profile.preferred_name,
        phone: profile.phone,
        date_of_birth: profile.date_of_birth,
        address: profile.address,
        uts_student_number: profile.uts_student_number,
        emergency_contact_name: profile.emergency_contact_name,
        emergency_contact_relationship: profile.emergency_contact_relationship,
        emergency_contact_phone: profile.emergency_contact_phone,
        medical_notes: profile.medical_notes,
        is_minor: profile.is_minor,
        guardian_name: profile.guardian_name,
        guardian_relationship: profile.guardian_relationship,
        sms_whatsapp_consent: profile.sms_whatsapp_consent,
        updated_at: profile.updated_at,
      },
      memberships: membershipRows.map((m) => ({
        id: m.id,
        plan_name: planById.get(m.plan_id)?.name ?? null,
        status: m.status,
        price_cents: m.price_cents,
        payment_reference: m.payment_reference,
        starts_at: m.starts_at,
        ends_at: m.ends_at,
        sessions_remaining: m.sessions_remaining,
      })),
      // The frozen submission, in full: what a manager reads to decide whether
      // to approve. The PDF is fetched separately, as a short-lived signed URL.
      waivers: waiverRows.map((w) => ({
        id: w.id,
        full_name: nameWithPreferred(w),
        email: w.email,
        phone: w.phone,
        date_of_birth: w.date_of_birth,
        address: w.address,
        uts_student_number: w.uts_student_number,
        sms_whatsapp_consent: w.sms_whatsapp_consent,
        emergency_contact_name: w.emergency_contact_name,
        emergency_contact_relationship: w.emergency_contact_relationship,
        emergency_contact_phone: w.emergency_contact_phone,
        medical_notes: w.medical_notes,
        is_minor: w.is_minor,
        guardian_name: w.guardian_name,
        guardian_relationship: w.guardian_relationship,
        signed_at: w.signed_at,
        template_version: w.template_version,
        has_pdf: Boolean(w.pdf_path),
        approved_at: w.approved_at ?? null,
        signer_ip: w.signer_ip,
        signer_meta: w.signer_meta,
        status: statuses.get(w.id) ?? ("pending" as const),
      })),
    };
  });

// ---- Manager: correct a person's email address ----
//
// The only email-editing path in the product. The address is the identity, so
// moving it moves the login itself, and everything the club sends afterwards.
//
// The rule this enforces: a changed address is ALWAYS unverified. Whatever was
// proven about the old address says nothing about the new one, and the whole
// point of the badge is that it cannot be set by someone's say-so.
export const setClubUserEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => managerEmailChangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const email = normalizeEmail(data.email);

    const { data: got, error: getErr } = await admin.auth.admin.getUserById(data.userId);
    if (getErr) throw new Error(getErr.message);
    if (!got.user) throw new Error("User not found.");

    const current = got.user.email ? normalizeEmail(got.user.email) : "";
    // Re-saving the same address must not cost someone their verified badge.
    if (current === email) {
      return {
        ok: true as const,
        email,
        changed: false,
        verified: Boolean(got.user.email_confirmed_at),
      };
    }

    // One person per email is the model's core invariant: profiles, waivers and
    // memberships all hang off a single auth user resolved by address. Merging
    // two people is a different problem, so refuse rather than half-do it.
    const { data: clash, error: clashErr } = await admin.rpc("user_id_by_email", { _email: email });
    if (clashErr) throw new Error(clashErr.message);
    if (clash && clash !== data.userId) {
      throw new Error("That email already belongs to another person.");
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(data.userId, {
      email,
      email_confirm: false,
    });
    if (updErr) throw new Error(updErr.message);

    // Assert the address actually MOVED, rather than trusting that it did.
    // Some GoTrue configurations answer an email update by parking the new
    // address in a pending `email_change` and leaving `email` alone. That would
    // return success here while the person still holds the wrong address — the
    // exact failure this feature exists to make visible. Re-read and check.
    const { data: after, error: afterErr } = await admin.auth.admin.getUserById(data.userId);
    if (afterErr) throw new Error(afterErr.message);
    const moved = after.user?.email ? normalizeEmail(after.user.email) === email : false;
    if (!moved) {
      throw new Error(
        "The login record did not accept that email. Nothing was changed. Check the address and try again.",
      );
    }

    // The guarantee. The admin API declines to SET a confirmation when asked
    // not to, but does not reliably CLEAR an existing one, so drop it outright
    // rather than trusting GoTrue to have done it.
    const { error: clearErr } = await admin.rpc("clear_email_confirmation", {
      _user_id: data.userId,
    });
    if (clearErr) throw new Error(clearErr.message);

    // Links already sitting in the old inbox go inert now rather than waiting
    // out their expiry: whoever reads that mailbox is not the person we hold.
    // Its own try/catch: a failed revoke must not skip the send below, or the
    // manager would be told a link went out when none did. A stale token cannot
    // verify the new address anyway (redemption re-checks the match), so this
    // is tidiness rather than the security boundary.
    if (current) {
      try {
        const { revokeVerificationTokensForEmail } =
          await import("@/lib/email-verification.server");
        await revokeVerificationTokensForEmail(admin, current);
      } catch (e) {
        console.error("[setClubUserEmail] could not revoke old-address tokens:", e);
      }
    }

    // Report what actually happened. The screen tells the manager a link was
    // sent, so that claim has to be true: a mail provider outage must show as
    // "address changed, no email sent", not as a confident lie they will only
    // discover when the member says nothing arrived.
    let verificationSent = false;
    try {
      const { sendVerificationEmail } = await import("@/lib/email-verification.server");
      ({ sent: verificationSent } = await sendVerificationEmail({
        admin,
        to: email,
        purpose: "email_change",
        userId: data.userId,
        next: "/account",
      }));
    } catch (e) {
      console.error("[setClubUserEmail] verification email failed:", e);
    }

    // NB: waiver rows keep the address as SUBMITTED. They are frozen evidence of
    // what was signed, so a corrected account email legitimately diverges from
    // them, and the detail screen says so rather than looking broken.
    return { ok: true as const, email, changed: true, verified: false, verificationSent };
  });

/** Manager: send the person a fresh "confirm your email address" link. */
export const resendClubUserVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context as { supabase: MembershipClient; userId: string });

    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const { data: got, error } = await admin.auth.admin.getUserById(data.userId);
    if (error) throw new Error(error.message);
    if (!got.user?.email) throw new Error("That person has no email on file.");
    if (got.user.email_confirmed_at) {
      return { ok: true as const, alreadyVerified: true, email: got.user.email };
    }

    const { sendVerificationEmail } = await import("@/lib/email-verification.server");
    const { sent } = await sendVerificationEmail({
      admin,
      to: got.user.email,
      purpose: "manager_resend",
      userId: data.userId,
      next: "/account",
    });
    if (!sent) throw new Error("We couldn't send that email just now. Try again shortly.");
    return { ok: true as const, alreadyVerified: false, email: got.user.email };
  });
