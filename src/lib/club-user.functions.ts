// Manager: everything known about ONE person, for the user detail screen.
//
// The list screen (`listClubUsers`) answers "who does the club know"; this
// answers "who is this person": their profile, their memberships, and every
// waiver they ever submitted with the full frozen submission so a manager can
// read what was signed without leaving the page.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { deriveWaiverListStatuses, nameWithPreferred } from "@/lib/validation";
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
    // visitor with no memberships. Stricter than listClubUsers, which throws on
    // its memberships read but still swallows the other four.
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
