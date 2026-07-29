import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSignerMeta,
  composeFullName,
  decodeDataUrlPng,
  deriveWaiverListStatuses,
  greetingName,
  nameWithPreferred,
  normalizeEmail,
  saveTemplateSchema,
  waiverApprovalSchema,
  waiverSubmitSchema,
  waiverToProfileFields,
} from "@/lib/validation";
import type { SignerMeta } from "@/lib/validation";
import {
  missingRequiredAcks,
  parseTemplateAcks,
  resolveAcknowledgements,
} from "@/lib/waiver-acknowledgements";
import { userIdByEmail } from "@/lib/supabase-rpc";

const BUCKET = "waivers";
const CLUB_NAME = "UTS Jitsu";

/** How long a returned download link stays usable. */
const PDF_URL_TTL_SECONDS = 60 * 60;

/** Postgres unique-violation, raised by the partial index on the submission id. */
const UNIQUE_VIOLATION = "23505";

/**
 * What a signer's browser gets back from a submission.
 *
 * `ok` and `pdf_ready` are deliberately separate. The waiver row is durable well
 * before the PDF exists, and the two used to be conflated: a pdf-lib or storage
 * failure threw, so a waiver that WAS recorded was reported to the person who
 * signed it as an outright failure. They would then sign again. Reporting the
 * durable part honestly, and the copy as a separate fact, is the fix.
 */
export type WaiverSubmitResult = {
  ok: true;
  waiver_id: string;
  pdf_url: string | null;
  pdf_ready: boolean;
};

/**
 * Mint a fresh download link for an already-stored waiver PDF.
 *
 * Returns null when the row has no PDF yet, which is a real state: a first
 * attempt that is still mid-flight has inserted its row but not finished
 * rendering. Never throws, because every caller is on a path where the waiver is
 * already saved and a missing link must not turn that into an error.
 *
 * Exported for its tests: it is a plain function taking its client as a
 * parameter, unlike the `createServerFn` handlers around it, which die on
 * "No Start context found in AsyncLocalStorage" when called from the runner.
 */
export async function signStoredPdf(
  admin: SupabaseClient<Database>,
  pdfPath: string | null,
): Promise<string | null> {
  if (!pdfPath) return null;
  try {
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(pdfPath, PDF_URL_TTL_SECONDS);
    if (error) {
      console.error("[waiver] could not sign stored PDF:", error);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (e) {
    console.error("[waiver] could not sign stored PDF:", e);
    return null;
  }
}

/**
 * Whether the email being submitted was already proven by a click.
 *
 * `vt` is the token from the interest confirmation email, carried across on the
 * prefill link. It is treated as a hint and never as an instruction: the token
 * must be live, and the address it was mailed to must be the address actually
 * being submitted. Someone who edits the email field on a prefilled form gets
 * no verification from the old token, which is the point.
 *
 * Never throws. A missing, expired, or mismatched token just means "not proven",
 * which is the ordinary state for a walk-in signer.
 */
async function proveSubmittedEmail(
  admin: SupabaseClient<Database>,
  vt: string | undefined,
  submittedEmail: string,
): Promise<boolean> {
  const raw = (vt || "").trim();
  if (!raw) return false;
  try {
    const { lookupVerificationToken } = await import("@/lib/email-verification.server");
    const { tokenProvesEmail } = await import("@/lib/email-verification");
    const token = await lookupVerificationToken(admin, raw);
    return Boolean(token && tokenProvesEmail(token.email, submittedEmail));
  } catch (e) {
    console.error("[submitWaiverWithPdf] verification token lookup failed:", e);
    return false;
  }
}

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
  const { data, error } = await supabase
    .from("waiver_templates")
    .select("id, version, title, body_md, acknowledgements")
    .eq("is_current", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id,
    version: data.version,
    title: data.title,
    body_md: data.body_md,
    acknowledgements: parseTemplateAcks(data.acknowledgements),
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
    const admin = supabaseAdmin;
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
    const admin = supabaseAdmin;
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
  .handler(async ({ data }): Promise<WaiverSubmitResult> => {
    if (data.hp) return { ok: true, waiver_id: "", pdf_url: null, pdf_ready: false };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin;
    const { renderWaiverPdf } = await import("./waiver-pdf");

    // ---- Has this exact submission already been signed? ----
    //
    // The client resends the same id on every retry, and it retries hard: a lost
    // reply says nothing about whether the work happened. Checking first, before
    // any auth-user creation or PDF work, is what makes that safe. Without it a
    // retry after a timeout would mint a SECOND signed waiver and email the
    // member and every manager all over again.
    const submissionId = data.client_submission_id || null;
    if (submissionId) {
      const { data: already, error: dupErr } = await admin
        .from("waivers")
        .select("id, pdf_path")
        .eq("client_submission_id", submissionId)
        .maybeSingle();
      // A failed lookup must not block a signature. Falling through risks a
      // duplicate; refusing guarantees a lost waiver, and that is the worse one.
      if (dupErr) console.error("[submitWaiverWithPdf] submission lookup failed:", dupErr);
      if (already) {
        const url = await signStoredPdf(admin, already.pdf_path);
        return { ok: true, waiver_id: already.id, pdf_url: url, pdf_ready: Boolean(url) };
      }
    }

    const full_name = composeFullName(data.first_name, data.middle_name || "", data.last_name);
    // Email is the person's identity key (always provided); normalize it so
    // case/whitespace variants map to the one profile.
    const email = normalizeEmail(data.email);

    // Signing-context evidence for the forensic/legal record: the signer's real
    // IP plus request headers (user agent, language, client hints) merged with
    // the browser's self-reported context (timezone, screen, platform). Also
    // capture the caller's bearer token to know who is submitting.
    let signer_ip: string | null = null;
    let signer_meta: SignerMeta = {};
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

    // Load current template. Explicit columns, matching getCurrentWaiverTemplate:
    // with `select("*")` a missing `acknowledgements` column would come back
    // undefined and silently enforce ZERO required acknowledgements on a signed
    // legal document. Naming it means PostgREST rejects the read instead.
    const { data: tpl, error: tplErr } = await supabaseAdmin
      .from("waiver_templates")
      .select("id, version, title, body_md, acknowledgements")
      .eq("is_current", true)
      .maybeSingle();
    if (tplErr) throw new Error(tplErr.message);
    if (!tpl) throw new Error("No active waiver template.");

    // Acknowledgements are defined on the template; enforce the required ones.
    const ackDefs = parseTemplateAcks(tpl.acknowledgements);
    const answers = data.acknowledgements ?? {};
    const missing = missingRequiredAcks(ackDefs, answers);
    if (missing.length > 0) {
      throw new Error(`Please accept: ${missing.map((a) => a.label).join(" ")}`);
    }

    const signed_at = new Date().toISOString();
    const isMinor = data.is_minor ?? false;

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
    //
    // If they arrived from the link in their interest confirmation email, that
    // click already proved the mailbox. `emailProven` carries the proof into
    // the moment the person is created, so they are born verified rather than
    // being asked to confirm an address they have demonstrably just read.
    const emailProven = await proveSubmittedEmail(admin, data.vt, email);

    let userId: string;
    if (callerId) {
      userId = callerId;
    } else {
      const { data: existingId, error: lookupErr } = await userIdByEmail(admin, email);
      if (lookupErr) throw new Error(lookupErr.message);
      if (existingId) {
        userId = existingId;
      } else {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          email_confirm: emailProven,
          ban_duration: "876000h", // ~100 years: an applicant, not a login yet
        });
        if (createErr || !created.user) {
          // A concurrent submission may have just created the user; re-resolve
          // before treating it as a failure.
          const { data: racedId } = await userIdByEmail(admin, email);
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

    // A person who ALREADY existed and clicked their emailed link: apply the
    // proof to them too. Idempotent, so it is a harmless no-op for someone just
    // created with `email_confirm` above, which keeps this to one code path.
    // Best-effort — a hiccup here must not fail a signed waiver.
    if (emailProven) {
      const { error: confirmErr } = await admin.auth.admin.updateUserById(userId, {
        email_confirm: true,
      });
      if (confirmErr) {
        console.error("[submitWaiverWithPdf] could not record email verification:", confirmErr);
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
        client_submission_id: submissionId,
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
        emergency_contact_relationship: data.emergency_contact_relationship,
        emergency_contact_phone: data.emergency_contact_phone,
        medical_notes: data.medical_notes || null,
        is_minor: isMinor,
        // For a minor the emergency contact IS the guardian who signs, so the
        // guardian columns are filled from that one block rather than from a
        // second set of inputs that could disagree with it.
        guardian_name: isMinor ? data.emergency_contact_name : null,
        guardian_relationship: isMinor ? data.emergency_contact_relationship : null,
        signed_at,
        template_version: tpl.version,
        signer_ip,
        signer_meta,
      })
      .select("id")
      .single();
    if (insErr?.code === UNIQUE_VIOLATION && submissionId) {
      // Two attempts of the same submission were genuinely in flight at once
      // (the lookup above ran before the first one committed). The index did its
      // job; adopt the row that won rather than failing a signed waiver.
      const { data: raced } = await admin
        .from("waivers")
        .select("id, pdf_path")
        .eq("client_submission_id", submissionId)
        .maybeSingle();
      if (raced) {
        const url = await signStoredPdf(admin, raced.pdf_path);
        return { ok: true, waiver_id: raced.id, pdf_url: url, pdf_ready: Boolean(url) };
      }
    }
    // The last point at which throwing is right: nothing is saved yet, so
    // "it failed" is the truth and the signer should try again.
    if (insErr || !inserted) throw new Error(insErr?.message || "Could not save waiver.");

    // ---- Past here the waiver IS saved. Nothing below may throw. ----
    //
    // Everything that follows produces the *copy* of a document that already
    // legally exists. Throwing would tell the person who just signed that it
    // failed, and the reliable thing they do next is sign again. So a failure
    // here comes back as `pdf_ready: false` and the page says so plainly.

    /**
     * Tell the member and the managers, with or without a copy.
     *
     * Best-effort, and it runs on the failure paths too. A waiver whose PDF
     * never materialised is the one case where silence is worst: the signer is
     * told on screen that it counted, so if no email follows and no manager is
     * notified, a signed waiver with no document sits in the table with nobody
     * aware of it. The emails degrade to "no download link, we will sort it
     * out" rather than not being sent at all.
     */
    const notify = async (pdfUrl: string | null) => {
      try {
        const { sendWaiverEmails } = await import("./waiver-email.server");
        await sendWaiverEmails({
          waiverId: inserted.id,
          memberName: full_name,
          memberGreetingName: greetingName({
            preferred_name: data.preferred_name,
            first_name: data.first_name,
            middle_name: data.middle_name,
            last_name: data.last_name,
          }),
          memberEmail: email,
          pdfUrl,
          admin: supabaseAdmin,
          // Lets the confirmation email add a "confirm your email address"
          // button, but only for someone whose address is still unproven.
          userId,
        });
      } catch (e) {
        console.error("[submitWaiverWithPdf] failed to send waiver emails:", e);
      }
    };

    // Generate PDF (signature images are embedded into it, not stored separately).
    // PDF rendering pulls in pdf-lib and can fail for reasons the signer can't
    // act on (a malformed template, a corrupt signature image, a bundling/interop
    // fault). Log the real error server-side for diagnosis; the member is told
    // their waiver is signed and that the copy will follow.
    let pdf: Uint8Array;
    try {
      pdf = await renderWaiverPdf({
        full_name,
        first_name: data.first_name,
        preferred_name: data.preferred_name || "",
        date_of_birth: data.date_of_birth,
        address: data.address,
        phone: data.phone,
        email,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_relationship: data.emergency_contact_relationship,
        emergency_contact_phone: data.emergency_contact_phone,
        medical_notes: data.medical_notes || "",
        health_answers: data.health_answers,
        acknowledgements: resolveAcknowledgements(ackDefs, answers),
        signature_name: data.signature_name || "",
        signed_at,
        template_title: tpl.title,
        template_body: tpl.body_md,
        template_version: tpl.version,
        club_name: CLUB_NAME,
        is_minor: isMinor,
        guardian_name: isMinor ? data.emergency_contact_name : "",
        guardian_relationship: isMinor ? data.emergency_contact_relationship : "",
        guardian_signature: data.guardian_signature || "",
        signature_image_png: sigPng,
        guardian_signature_image_png: gSigPng,
      });
    } catch (e) {
      console.error("[submitWaiverWithPdf] PDF generation failed:", e);
      await notify(null);
      return { ok: true, waiver_id: inserted.id, pdf_url: null, pdf_ready: false };
    }

    const path = `${inserted.id}.pdf`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) {
      console.error("[submitWaiverWithPdf] PDF upload failed:", upErr);
      await notify(null);
      return { ok: true, waiver_id: inserted.id, pdf_url: null, pdf_ready: false };
    }

    await admin.from("waivers").update({ pdf_path: path }).eq("id", inserted.id);

    const signedUrl = await signStoredPdf(admin, path);

    // A longer-lived link for the email (Lovable's email API can't carry binary
    // attachments, so we send a secure, expiring download link).
    let emailUrl: string | null = null;
    try {
      const { data: emailSigned } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 7);
      emailUrl = emailSigned?.signedUrl ?? null;
    } catch (e) {
      console.error("[submitWaiverWithPdf] could not mint the email PDF link:", e);
    }
    await notify(emailUrl);

    return {
      ok: true,
      waiver_id: inserted.id,
      pdf_url: signedUrl,
      pdf_ready: Boolean(signedUrl),
    };
  });

// ---- "Did my waiver land?" ----
//
// The whole point of this endpoint is that a lost reply is not an answer.
// Aborting a request client-side does not stop the server, so a timeout leaves
// the browser unable to tell "never arrived" from "arrived, reply dropped".
// Before this existed the page guessed, and it guessed "failed" — so a signer
// whose waiver the club already had was told to try again.
//
// Keyed on the client's own submission id and nothing else, so it answers only
// about a submission the caller made, and returns no personal data: whether it
// landed, and a link to the copy. Safe to call repeatedly, and safe to call when
// nothing landed at all.
export const checkWaiverSubmission = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ client_submission_id: z.string().uuid() }).parse(data),
  )
  .handler(
    async ({
      data,
    }): Promise<{ found: boolean; waiver_id: string | null; pdf_url: string | null }> => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: row, error } = await supabaseAdmin
        .from("waivers")
        .select("id, pdf_path")
        .eq("client_submission_id", data.client_submission_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) return { found: false, waiver_id: null, pdf_url: null };
      return {
        found: true,
        waiver_id: row.id,
        pdf_url: await signStoredPdf(supabaseAdmin, row.pdf_path),
      };
    },
  );

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

    // A failed read here would number the new template 1 and collide with the
    // existing version 1, so the manager's save would fail on a duplicate-key
    // message that says nothing about what actually went wrong.
    const { data: maxRow, error: maxErr } = await supabaseAdmin
      .from("waiver_templates")
      .select("version")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw new Error(maxErr.message);
    const nextVersion = (maxRow?.version ?? 0) + 1;

    // Clear current flag on all rows
    const { error: clearErr } = await supabaseAdmin
      .from("waiver_templates")
      .update({ is_current: false })
      .eq("is_current", true);
    if (clearErr) throw new Error(clearErr.message);

    const { data: created, error } = await supabaseAdmin
      .from("waiver_templates")
      .insert({
        version: nextVersion,
        title: data.title,
        body_md: data.body_md,
        acknowledgements: data.acknowledgements,
        is_current: true,
        created_by: context.userId,
      })
      .select("id, version")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true as const, version: created.version };
  });

// ---- Manager: list waivers ----
export const listWaivers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Fail-closed either way, but "Forbidden" for a failed role check tells a
    // manager they lost their access when the RPC is what broke.
    const { data: isMgr, error: rErr } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "manager",
    });
    if (rErr) throw new Error(rErr.message);
    if (!isMgr) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin;
    // Each row shows the SUBMITTED name/email (the frozen submission), plus a
    // derived status: the person's latest approved waiver is their active one,
    // older approved ones are superseded, the rest are pending.
    const { data, error } = await admin
      .from("waivers")
      .select(
        "id, user_id, first_name, middle_name, last_name, preferred_name, email, signed_at, template_version, pdf_path, approval_status, approved_at",
      )
      .order("signed_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const statuses = deriveWaiverListStatuses(rows);
    return rows.map((row) => ({
      id: row.id,
      // The legal name as submitted, with the preferred name quoted in when
      // they gave one: managers see who signed AND what to call them.
      full_name: nameWithPreferred(row),
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
    const admin = supabaseAdmin;

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

    const { error } = await admin
      .from("waivers")
      .update({
        approval_status: data.status,
        approved_at: approvedAt,
        approved_by: approved ? context.userId : null,
      })
      .eq("id", data.id);
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
