import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  composeFullName,
  decodeDataUrlPng,
  saveTemplateSchema,
  waiverApprovalSchema,
  waiverSubmitSchema,
} from "@/lib/validation";
import {
  missingRequiredAcks,
  parseTemplateAcks,
  resolveAcknowledgements,
} from "@/lib/waiver-acknowledgements";

const BUCKET = "waivers";
const CLUB_NAME = "UTS Jitsu";

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

// ---- Latest waiver for signed-in user (autofill) ----
export const getMyLatestWaiver = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("waivers")
      .select(
        "full_name, first_name, middle_name, last_name, date_of_birth, address, phone, email, emergency_contact_name, emergency_contact_phone, medical_notes",
      )
      .eq("user_id", context.userId)
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

// ---- Submit waiver + generate PDF ----
export const submitWaiverWithPdf = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => waiverSubmitSchema.parse(data))
  .handler(async ({ data }) => {
    if (data.hp) return { ok: true as const, pdf_url: null };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { renderWaiverPdf } = await import("./waiver-pdf");

    const full_name = composeFullName(data.first_name, data.middle_name || "", data.last_name);

    // Try to attach user_id if caller has a bearer token
    let userId: string | null = null;
    try {
      const { getRequestHeader } = await import("@tanstack/react-start/server");
      const auth = getRequestHeader("authorization");
      const token = auth?.replace(/^Bearer\s+/i, "");
      if (token) {
        const { data: userData } = await supabaseAdmin.auth.getUser(token);
        userId = userData.user?.id ?? null;
      }
    } catch {
      /* ignore */
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

    // Insert waiver row
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("waivers")
      .insert({
        full_name,
        first_name: data.first_name,
        middle_name: data.middle_name || null,
        last_name: data.last_name,
        date_of_birth: data.date_of_birth,
        address: data.address,
        phone: data.phone,
        email: data.email,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_phone: data.emergency_contact_phone,
        medical_notes: data.medical_notes || null,
        acknowledgements: answers,
        signature_name: data.signature_name || full_name,
        signed_at,
        user_id: userId,
        template_version: tpl.version,
        is_minor: data.is_minor ?? false,
        guardian_name: data.guardian_name || null,
        guardian_relationship: data.guardian_relationship || null,
        guardian_signature: data.guardian_signature || null,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);

    // Upload signature images (if any) so managers can view raw marks
    let sigPath: string | null = null;
    let gSigPath: string | null = null;
    if (sigPng) {
      sigPath = `${inserted.id}-signature.png`;
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(sigPath, sigPng, { contentType: "image/png", upsert: true });
      if (error) throw new Error(error.message);
    }
    if (gSigPng) {
      gSigPath = `${inserted.id}-guardian-signature.png`;
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(gSigPath, gSigPng, { contentType: "image/png", upsert: true });
      if (error) throw new Error(error.message);
    }

    // Generate PDF
    const pdf = await renderWaiverPdf({
      full_name,
      date_of_birth: data.date_of_birth,
      address: data.address,
      phone: data.phone,
      email: data.email,
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

    const path = `${inserted.id}.pdf`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) throw new Error(upErr.message);

    await supabaseAdmin
      .from("waivers")
      .update({
        pdf_path: path,
        signature_image_path: sigPath,
        guardian_signature_image_path: gSigPath,
      })
      .eq("id", inserted.id);

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
          memberEmail: data.email,
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
    // select("*") so the approval columns (absent from the stale generated
    // types) come back; we then project to the list shape managers need.
    const { data, error } = await context.supabase
      .from("waivers")
      .select("*")
      .order("signed_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []).map((w) => {
      const row = w as typeof w & {
        approval_status?: string | null;
        approved_at?: string | null;
      };
      return {
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        signed_at: row.signed_at,
        template_version: row.template_version,
        pdf_path: row.pdf_path,
        approval_status: (row.approval_status ?? "pending") as "pending" | "approved",
        approved_at: row.approved_at ?? null,
      };
    });
  });

// ---- Manager: approve / unapprove a signed waiver ----
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

    const approved = data.status === "approved";
    const approvedAt = approved ? new Date().toISOString() : null;
    // Built as a variable so the approval keys (absent from the stale generated
    // Update type) don't trip the excess-property check.
    const patch = {
      approval_status: data.status,
      approved_at: approvedAt,
      approved_by: approved ? context.userId : null,
    };
    const { error } = await supabaseAdmin.from("waivers").update(patch).eq("id", data.id);
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
