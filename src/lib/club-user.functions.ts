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
      { data: memberships },
      { data: plans },
      { data: roles },
      { data: emailRows },
    ] = await Promise.all([
      admin.from("profiles").select("*").eq("user_id", data.userId).maybeSingle(),
      admin
        .from("waivers")
        .select("*")
        .eq("user_id", data.userId)
        .order("signed_at", { ascending: false })
        .limit(100),
      admin
        .from("memberships")
        .select("*")
        .eq("user_id", data.userId)
        .order("created_at", { ascending: false })
        .limit(100),
      admin.from("membership_plans").select("id, name, kind"),
      admin.from("user_roles").select("user_id, role").eq("user_id", data.userId),
      admin.rpc("user_emails", { _user_ids: [data.userId] }),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (wErr) throw new Error(wErr.message);
    if (!profile) throw new Error("User not found.");

    const waiverRows = waivers ?? [];
    const membershipRows = memberships ?? [];
    const planRows = plans ?? [];
    const planById = new Map(planRows.map((p) => [p.id, p]));
    // The RPC is service-role only and can fail; degrade to a missing email
    // rather than failing the whole page (same posture as the list screen).
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
      user: summary,
      profile: {
        first_name: profile.first_name,
        middle_name: profile.middle_name,
        last_name: profile.last_name,
        preferred_name: profile.preferred_name,
        date_of_birth: profile.date_of_birth,
        address: profile.address,
        emergency_contact_name: profile.emergency_contact_name,
        emergency_contact_phone: profile.emergency_contact_phone,
        medical_notes: profile.medical_notes,
        is_minor: profile.is_minor,
        guardian_name: profile.guardian_name,
        guardian_relationship: profile.guardian_relationship,
        sms_whatsapp_consent: profile.sms_whatsapp_consent,
        created_at: profile.created_at,
        updated_at: profile.updated_at,
      },
      memberships: membershipRows.map((m) => ({
        id: m.id,
        plan_name: planById.get(m.plan_id)?.name ?? null,
        kind: planById.get(m.plan_id)?.kind ?? null,
        status: m.status,
        price_cents: m.price_cents,
        payment_reference: m.payment_reference,
        starts_at: m.starts_at,
        ends_at: m.ends_at,
        sessions_remaining: m.sessions_remaining,
        created_at: m.created_at,
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
