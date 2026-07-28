import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSignerMeta,
  composeFullName,
  decodeDataUrlPng,
  deriveWaiverListStatuses,
  normalizeEmail,
  saveTemplateSchema,
  waiverApprovalSchema,
  waiverSubmitSchema,
  waiverToProfileFields,
} from "@/lib/validation";
import {
  missingRequiredAcks,
  parseTemplateAcks,
  resolveAcknowledgements,
} from "@/lib/waiver-acknowledgements";
import type { AppClient } from "@/lib/profile-types";

const BUCKET = "waivers";
const CLUB_NAME = "UTS Jitsu";

/**
 * Best-effort real client IP from the proxy headers, kept on the waiver as a
 * forensic/legal record. Falls back through the common forwarding headers.
 */
function clientIp(getHeader: (name: string) => string | undefined): string | null {
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return getHeader("cf-connecting-ip") || getHeader("x-real-ip") || null;
}

function serverSupabase() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, {
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

// ---- Current template (public) ----
export const getCurrentWaiverTemplate = createServerFn({ method: "GET" }).handler(async () => {
  const supabase = serverSupabase();
  // select("*") so the (generated-types-unaware) `acknowledgements` column comes back.
  const { data, error } = await supabase
    .from("waiver_templates")
    .select("*")
    .eq("is_current", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id,
    version: data.version,
    title: data.title,
    body_md: data.body_md,
    acknowledgements: parseTemplateAcks((data as { acknowledgements?: unknown }).acknowledgements),
  };
});

// ---- The signed-in person's profile (autofill) ----
export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Identity now lives on the person's profile (one row per email), not on each
    // waiver. Prefill the waiver form from it. Read via the service role scoped to
    // the caller's own user id.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AppClient;
    const { data, error } = await admin
      .from("profiles")
      .select("*")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  });

// ---- The signed-in person's waiver history (active one marked) ----
export const listMyWaivers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AppClient;
    const { data, error } = await admin
      .from("waivers")
      .select("id, user_id, signed_at, template_version, pdf_path, approval_status, approved_at")
      .eq("user_id", context.userId)
      .order("signed_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const statuses = deriveWaiverListStatuses(rows);
    return rows.map((row) => ({
      id: row.id,
      signed_at: row.signed_at,
      template_version: row.template_version,
      has_pdf: Boolean(row.pdf_path),
      status: statuses.get(row.id) ?? "pending",
    }));
  });

// ---- Submit waiver + generate PDF ----
export const submitWaiverWithPdf = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => waiverSubmitSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, pdf_url: null };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AppClient;
    const { renderWaiverPdf } = await import("./waiver-pdf");

    const full_name = composeFullName(data.first_name, data.middle_name || "", data.last_name);
    // Email is the person's identity key (always provided); normalize it so
    // case/whitespace variants map to the one profile.
    const email = normalizeEmail(data.email);

    // Signing-context evidence for the forensic/legal record: the signer's real
    // IP plus request headers (user agent, language, client hints) merged with
    // the browser's self-reported context (timezone, screen, platform). Also
    // capture the caller's bearer token to know who is submitting.
    let signer_ip: string | null = null;
    let signer_meta: Record<string, unknown> = {};
    let bearer: string | null = null;
    try {
      const { getRequestHeader } = await import("@tanstack/react-start/server");
      const getHeader = (name: string) => getRequestHeader(name);
      signer_ip = clientIp(getHeader);
      signer_meta = buildSignerMeta(getHeader, data.client_meta);
      bearer = getHeader("authorization")?.replace(/^Bearer\s+/i, "") || null;
    } catch {
      /* header access unavailable */
      signer_meta = buildSignerMeta(() => undefined, data.client_meta);
    }

    // A signed-in caller signs for their own account: require the submitted
    // email to match their login email (the form locks the field; this is the
    // server-side backstop). Without this, a typo or someone else's address
    // would attach the waiver to the wrong person or mint a duplicate one.
    let callerId: string | null = null;
    if (bearer) {
      try {
        const { data: callerData } = await supabaseAdmin.auth.getUser(bearer);
        if (callerData.user) {
          const callerEmail = callerData.user.email ?? "";
          if (!callerEmail || normalizeEmail(callerEmail) !== email) {
            throw new Error(
              `You're signed in as ${callerEmail || "another account"}, so the waiver must use that email. To sign for someone else, log out first.`,
            );
          }
          callerId = callerData.user.id;
        }
      } catch (e) {
        // An invalid/expired token means an anonymous submission; a real
        // mismatch error must surface.
        if (e instanceof Error && e.message.includes("signed in as")) throw e;
      }
    }

    // Load current template
    const { data: tpl, error: tplErr } = await supabaseAdmin
      .from("waiver_templates")
      .select("*")
      .eq("is_current", true)
      .maybeSingle();
    if (tplErr) throw new Error(tplErr.message);
    if (!tpl) throw new Error("No active waiver template.");

    // Acknowledgements are defined on the template; enforce the required ones.
    const ackDefs = parseTemplateAcks((tpl as { acknowledgements?: unknown }).acknowledgements);
    const answers = data.acknowledgements ?? {};
    const missing = missingRequiredAcks(ackDefs, answers);
    if (missing.length > 0) {
      throw new Error(`Please accept: ${missing.map((a) => a.label).join(" ")}`);
    }

    const signed_at = new Date().toISOString();

    const sigPng = decodeDataUrlPng(data.signature_image || "");
    const gSigPng = decodeDataUrlPng(data.guardian_signature_image || "");

    // Every submission belongs to a person, and a person is an auth user (the
    // email lives on auth.users — the one email store). Resolve the auth user
    // by email — an EXISTING email (any funnel phase) is fine and expected:
    // resubmission is always allowed and never modifies the existing person.
    // If the email is new to the club, create a LOCKED auth user (long ban, no
    // credentials — an applicant, not a login yet: they cannot sign in until a
    // manager approves a waiver and lifts the ban). The ensure_profile trigger
    // creates the profile row; seed a new person's name/phone onto it.
    let userId: string;
    if (callerId) {
      userId = callerId;
    } else {
      const { data: existingId, error: lookupErr } = await admin.rpc("user_id_by_email", {
        _email: email,
      });
      if (lookupErr) throw new Error(lookupErr.message);
      if (existingId) {
        userId = existingId;
      } else {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          ban_duration: "876000h", // ~100 years: an applicant, not a login yet
        });
        if (createErr || !created.user) {
          // A concurrent submission may have just created the user; re-resolve
          // before treating it as a failure.
          const { data: racedId } = await admin.rpc("user_id_by_email", { _email: email });
          if (!racedId) {
            console.error("[submitWaiverWithPdf] could not register email:", createErr);
            throw new Error(
              "We couldn't register that email address. Check it for typos and try again.",
            );
          }
          userId = racedId;
        } else {
          userId = created.user.id;
          // Seed the fresh applicant profile (created by the ensure_profile
          // trigger) with the basics. Best-effort field seed, keyed insert-safe.
          await admin.from("profiles").upsert(
            {
              user_id: userId,
              first_name: data.first_name,
              middle_name: data.middle_name || null,
              last_name: data.last_name,
              preferred_name: data.preferred_name || null,
              phone: data.phone || null,
            },
            { onConflict: "user_id" },
          );
        }
      }
    }

    // The waiver row is the frozen submission: exactly what was typed
    // (including the email as submitted), plus provenance (template version,
    // signer IP, signing context) and timestamps. Signatures and
    // acknowledgements live inside the PDF only. Resubmission is always
    // allowed; managers pick which submission to approve.
    const { data: inserted, error: insErr } = await admin
      .from("waivers")
      .insert({
        user_id: userId,
        first_name: data.first_name,
        middle_name: data.middle_name || null,
        last_name: data.last_name,
        preferred_name: data.preferred_name || null,
        date_of_birth: data.date_of_birth,
        address: data.address,
        phone: data.phone,
        email,
        uts_student_number: data.uts_student_number?.trim() || null,
        sms_whatsapp_consent: data.sms_whatsapp_consent ?? false,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_phone: data.emergency_contact_phone,
        medical_notes: data.medical_notes || null,
        is_minor: data.is_minor ?? false,
        guardian_name: data.guardian_name || null,
        guardian_relationship: data.guardian_relationship || null,
        signed_at,
        template_version: tpl.version,
        signer_ip,
        signer_meta,
      })
      .select("id")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message || "Could not save waiver.");

    // Generate PDF (signature images are embedded into it, not stored separately).
    // PDF rendering pulls in pdf-lib and can fail for reasons the signer can't
    // act on (a malformed template, a corrupt signature image, a bundling/interop
    // fault). The waiver row is already durably saved at this point, so log the
    // real error server-side for diagnosis and surface a plain, non-technical
    // message instead of leaking internal library errors to the member.
    let pdf: Uint8Array;
    try {
      pdf = await renderWaiverPdf({
        full_name,
        preferred_name: data.preferred_name || "",
        date_of_birth: data.date_of_birth,
        address: data.address,
        phone: data.phone,
        email,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_phone: data.emergency_contact_phone,
        medical_notes: data.medical_notes || "",
        acknowledgements: resolveAcknowledgements(ackDefs, answers),
        signature_name: data.signature_name || "",
        signed_at,
        template_title: tpl.title,
        template_body: tpl.body_md,
        template_version: tpl.version,
        club_name: CLUB_NAME,
        is_minor: data.is_minor ?? false,
        guardian_name: data.guardian_name || "",
        guardian_relationship: data.guardian_relationship || "",
        guardian_signature: data.guardian_signature || "",
        signature_image_png: sigPng,
        guardian_signature_image_png: gSigPng,
      });
    } catch (e) {
      console.error("[submitWaiverWithPdf] PDF generation failed:", e);
      throw new Error(
        "Your waiver was saved, but we couldn't generate the PDF copy. Please contact the club so we can send it to you.",
      );
    }

    const path = `${inserted.id}.pdf`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) {
      console.error("[submitWaiverWithPdf] PDF upload failed:", upErr);
      throw new Error(
        "Your waiver was saved, but we couldn't store the PDF copy. Please contact the club so we can send it to you.",
      );
    }

    await admin.from("waivers").update({ pdf_path: path }).eq("id", inserted.id);

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 60);
    if (signErr) throw new Error(signErr.message);

    // Notify the member and every manager, with a longer-lived link to the PDF
    // (Lovable's email API can't carry binary attachments, so we send a secure,
    // expiring download link). Best-effort — a send failure must not fail the
    // waiver submission, which is already durably saved.
    try {
      const { data: emailSigned } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 7);
      if (emailSigned?.signedUrl) {
        const { sendWaiverEmails } = await import("./waiver-email.server");
        await sendWaiverEmails({
          waiverId: inserted.id,
          memberName: full_name,
          memberEmail: email,
          pdfUrl: emailSigned.signedUrl,
          admin: supabaseAdmin,
        });
      }
    } catch (e) {
      console.error("[submitWaiverWithPdf] failed to send waiver emails:", e);
    }

    return { ok: true as const, pdf_url: signed.signedUrl, waiver_id: inserted.id };
  });

// ---- Manager: save new template version ----
export const saveWaiverTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveTemplateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: isMgr, error: rErr } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "manager",
    });
    if (rErr) throw new Error(rErr.message);
    if (!isMgr) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: maxRow } = await supabaseAdmin
      .from("waiver_templates")
      .select("version")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (maxRow?.version ?? 0) + 1;

    // Clear current flag on all rows
    await supabaseAdmin
      .from("waiver_templates")
      .update({ is_current: false })
      .eq("is_current", true);

    // Built as a variable so the `acknowledgements` key (absent from the stale
    // generated Insert type) doesn't trip the excess-property check.
    const templateRow = {
      version: nextVersion,
      title: data.title,
      body_md: data.body_md,
      acknowledgements: data.acknowledgements,
      is_current: true,
      created_by: context.userId,
    };
    const { data: created, error } = await supabaseAdmin
      .from("waiver_templates")
      .insert(templateRow as never)
      .select("id, version")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, version: created.version };
  });

// ---- Manager: list waivers ----
export const listWaivers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isMgr } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "manager",
    });
    if (!isMgr) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AppClient;
    // Each row shows the SUBMITTED name/email (the frozen submission), plus a
    // derived status: the person's latest approved waiver is their active one,
    // older approved ones are superseded, the rest are pending.
    const { data, error } = await admin
      .from("waivers")
      .select(
        "id, user_id, first_name, middle_name, last_name, email, signed_at, template_version, pdf_path, approval_status, approved_at",
      )
      .order("signed_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const statuses = deriveWaiverListStatuses(rows);
    return rows.map((row) => ({
      id: row.id,
      full_name: composeFullName(row.first_name, row.middle_name || "", row.last_name),
      email: row.email,
      signed_at: row.signed_at,
      template_version: row.template_version,
      pdf_path: row.pdf_path,
      status: statuses.get(row.id) ?? "pending",
      approved_at: row.approved_at ?? null,
    }));
  });

// ---- Manager: approve / unapprove a waiver submission ----
//
// Approval is the promotion step: the approved submission's details are copied
// onto the person's profile (the club's current record), and if they are still
// a locked applicant (banned auth user, no credentials) the ban is lifted and
// they're emailed a sign-in link to set up access (applicant -> visitor).
// Unapprove only reverts the waiver's status; the profile and login are left
// as they are.
export const setWaiverApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => waiverApprovalSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: isMgr, error: rErr } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "manager",
    });
    if (rErr) throw new Error(rErr.message);
    if (!isMgr) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AppClient;

    const approved = data.status === "approved";
    const approvedAt = approved ? new Date().toISOString() : null;

    if (approved) {
      const { data: waiver, error: wErr } = await admin
        .from("waivers")
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      if (wErr) throw new Error(wErr.message);
      if (!waiver) throw new Error("Waiver not found.");

      // Promote: the approved submission becomes the person's record.
      const { error: pErr } = await admin
        .from("profiles")
        .update({ ...waiverToProfileFields(waiver), updated_at: approvedAt! })
        .eq("user_id", waiver.user_id);
      if (pErr) throw new Error(pErr.message);

      // Provision access on FIRST approval: an applicant's auth user is banned
      // (no login). Lift the ban and email a sign-in link. Skipped for people
      // who can already log in, so re-approvals don't spam sign-in emails.
      // Best-effort — a hiccup must not undo the approval; re-approving
      // retries it (the user is still banned).
      try {
        const { data: got, error: getErr } = await admin.auth.admin.getUserById(waiver.user_id);
        if (getErr) throw getErr;
        const bannedUntil = (got.user as { banned_until?: string | null } | null)?.banned_until;
        const isLocked = Boolean(bannedUntil && new Date(bannedUntil) > new Date());
        if (isLocked) {
          const { error: unbanErr } = await admin.auth.admin.updateUserById(waiver.user_id, {
            ban_duration: "none",
          });
          if (unbanErr) throw unbanErr;
          // The canonical email lives on the auth user.
          const authEmail = got.user?.email;
          if (authEmail) {
            const { getRequestHeader } = await import("@tanstack/react-start/server");
            const origin = getRequestHeader("origin") || "https://jitsu.au";
            // Magic-link sign-in email (rendered by the Lovable auth-email
            // webhook). The user always exists here, so never auto-create.
            const { error: otpErr } = await serverSupabase().auth.signInWithOtp({
              email: authEmail,
              options: { emailRedirectTo: `${origin}/account`, shouldCreateUser: false },
            });
            if (otpErr) throw otpErr;
          }
        }
      } catch (e) {
        console.error("[setWaiverApproval] access provisioning failed:", e);
      }

      // Approved = visitor = trial assigned: give them the free trial on
      // first approval (one per person, ever; skipped for later approvals).
      // Best-effort like provisioning — re-approving retries it.
      try {
        const { assignTrialMembership } = await import("./membership.functions");
        await assignTrialMembership(waiver.user_id);
      } catch (e) {
        console.error("[setWaiverApproval] trial assignment failed:", e);
      }
    }

    // Built as a variable so the approval keys (absent from the stale generated
    // Update type) don't trip the excess-property check.
    const patch = {
      approval_status: data.status,
      approved_at: approvedAt,
      approved_by: approved ? context.userId : null,
    };
    const { error } = await admin.from("waivers").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);

    // Return the authoritative timestamp so the client doesn't have to guess it
    // from its own clock.
    return { ok: true as const, id: data.id, status: data.status, approved_at: approvedAt };
  });

// ---- Signed URL for a waiver PDF (manager or owner) ----
export const getWaiverPdfUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: waiver, error } = await context.supabase
      .from("waivers")
      .select("pdf_path")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!waiver?.pdf_path) throw new Error("Waiver PDF not found.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error: sErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(waiver.pdf_path, 60 * 60);
    if (sErr) throw new Error(sErr.message);
    return { url: signed.signedUrl };
  });
