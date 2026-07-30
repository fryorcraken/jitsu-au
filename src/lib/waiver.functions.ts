import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  PAPER_WAIVER_SOURCE,
  buildSignerMeta,
  composeFullName,
  decodeDataUrlPng,
  deriveWaiverListStatuses,
  greetingName,
  isFutureSigningDate,
  isMinorOn,
  isPaperWaiver,
  nameWithPreferred,
  normalizeEmail,
  paperWaiverUploadSchema,
  saveTemplateSchema,
  setCurrentTemplateSchema,
  waiverApprovalSchema,
  waiverSubmitSchema,
  waiverToProfileFields,
} from "@/lib/validation";
import type { PaperWaiverUploadInput, SignerMeta } from "@/lib/validation";
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
 * Fail unless the caller holds the manager role.
 *
 * Fail-closed either way, but "Forbidden" for a failed role check tells a
 * manager they lost their access when the RPC is what broke, so the two are
 * kept apart.
 */
async function requireManager(context: {
  supabase: SupabaseClient<Database>;
  userId: string;
}): Promise<void> {
  const { data: isMgr, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "manager",
  });
  if (error) throw new Error(error.message);
  if (!isMgr) throw new Error("Forbidden");
}

/** The person fields a brand-new applicant's profile is seeded with. */
type PersonSeed = {
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  phone: string | null;
};

/**
 * The person (auth user) an incoming waiver belongs to, creating them if this
 * email is new to the club.
 *
 * Every submission belongs to a person, and a person is an auth user (the email
 * lives on auth.users — the one email store). An EXISTING email, in any funnel
 * phase, is fine and expected: resubmission is always allowed and never
 * modifies the existing person. A new email gets a LOCKED auth user (long ban,
 * no credentials — an applicant, not a login yet: they cannot sign in until a
 * manager approves a waiver and lifts the ban), whose profile row the
 * ensure_profile trigger creates and this seeds.
 *
 * Shared by the public signing page and the manager's paper-scan upload, so a
 * waiver that arrives on paper produces exactly the same person record as one
 * signed on the site.
 */
async function resolvePersonId(
  admin: SupabaseClient<Database>,
  opts: { email: string; emailProven: boolean; seed: PersonSeed },
): Promise<string> {
  const { data: existingId, error: lookupErr } = await userIdByEmail(admin, opts.email);
  if (lookupErr) throw new Error(lookupErr.message);
  if (existingId) return existingId;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: opts.email,
    email_confirm: opts.emailProven,
    ban_duration: "876000h", // ~100 years: an applicant, not a login yet
  });
  if (createErr || !created.user) {
    // A concurrent submission may have just created the user; re-resolve before
    // treating it as a failure.
    const { data: racedId } = await userIdByEmail(admin, opts.email);
    if (racedId) return racedId;
    console.error("[resolvePersonId] could not register email:", createErr);
    throw new Error("We couldn't register that email address. Check it for typos and try again.");
  }

  // Seed the fresh applicant profile (created by the ensure_profile trigger)
  // with the basics. Best-effort field seed, keyed insert-safe.
  await admin.from("profiles").upsert(
    { user_id: created.user.id, ...opts.seed },
    {
      onConflict: "user_id",
    },
  );
  return created.user.id;
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

    // Refuse to file a signature against text the signer never read.
    //
    // The form holds its template for the life of the tab, so a manager
    // promoting a new version mid-fill would otherwise have this submission
    // recorded against the NEW version: `template_version` would name it and the
    // PDF would embed its body. In the direction where the new template asks for
    // fewer acknowledgements, that succeeds silently and produces a signed legal
    // document whose terms the signer was never shown.
    if (data.template_version !== undefined && data.template_version !== tpl.version) {
      throw new Error(
        "The waiver was updated while you were filling this in. Please reload the page and read the current version before signing.",
      );
    }

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

    // The person this submission belongs to (see resolvePersonId).
    //
    // If they arrived from the link in their interest confirmation email, that
    // click already proved the mailbox. `emailProven` carries the proof into
    // the moment the person is created, so they are born verified rather than
    // being asked to confirm an address they have demonstrably just read.
    const emailProven = await proveSubmittedEmail(admin, data.vt, email);

    const userId = callerId
      ? callerId
      : await resolvePersonId(admin, {
          email,
          emailProven,
          seed: {
            first_name: data.first_name,
            middle_name: data.middle_name || null,
            last_name: data.last_name,
            preferred_name: data.preferred_name || null,
            phone: data.phone || null,
          },
        });

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

// ---- Manager: list every template version ----
//
// The editor used to see only `is_current`, so a version that arrived by any
// other route (a migration seeding a draft, an older version someone wants to
// read back) was invisible in the UI even though the table had always held the
// full history. Managers can read every row by RLS; this goes through the
// service role like the rest of the manager reads.
export const listWaiverTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("waiver_templates")
      .select("id, version, title, body_md, acknowledgements, is_current, created_at")
      .order("version", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((t) => ({
      id: t.id,
      version: t.version,
      title: t.title,
      body_md: t.body_md,
      acknowledgements: parseTemplateAcks(t.acknowledgements),
      is_current: t.is_current,
      created_at: t.created_at,
    }));
  });

// ---- Manager: promote an existing version to the live one ----

/**
 * Make one template row the live one, and report honestly when it cannot.
 *
 * Exported and taking its client as a parameter so the failure paths are
 * unit-testable, following `applyCoverage` / `undoCheckInRow` in
 * `checkin.functions.ts` — a `createServerFn` handler cannot run in the test
 * runner, and the sequence below is the part worth pinning.
 *
 * The partial unique index allows exactly one `is_current = true`, so this is
 * necessarily two writes with a gap: clear, then set. Nothing can close that gap
 * from here — PostgREST gives each statement its own transaction — so the job is
 * to make the gap as short as possible, never widen it needlessly, and be loud
 * when the club is left in it. An unnoticed gap means `/waiver` throws
 * "No active waiver template" for every prospective member who submits.
 */
export async function promoteWaiverTemplate(
  admin: SupabaseClient<Database>,
  id: string,
): Promise<{ version: number }> {
  const { data: target, error: tErr } = await admin
    .from("waiver_templates")
    .select("id, version, is_current")
    .eq("id", id)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  // Both checks happen BEFORE anything is cleared: a bad id or an already-live
  // target must never cost the club its live waiver.
  if (!target) throw new Error("That waiver version no longer exists.");
  if (target.is_current) return { version: target.version };

  const { data: previous, error: pErr } = await admin
    .from("waiver_templates")
    .select("id")
    .eq("is_current", true)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);

  const { error: clearErr } = await admin
    .from("waiver_templates")
    .update({ is_current: false })
    .eq("is_current", true);
  if (clearErr) throw new Error(clearErr.message);

  const { error: setErr } = await admin
    .from("waiver_templates")
    .update({ is_current: true })
    .eq("id", target.id);
  if (!setErr) return { version: target.version };

  // From here the club has no live waiver until something sets one.
  //
  // The likeliest cause is another manager promoting concurrently: they cleared
  // and set while we were between our own two writes, so our set hit the unique
  // index. That is not a broken database, it is a race with a winner — say so
  // in words a manager can act on rather than surfacing a constraint name.
  const { data: nowCurrent } = await admin
    .from("waiver_templates")
    .select("id")
    .eq("is_current", true)
    .maybeSingle();
  if (nowCurrent) {
    throw new Error(
      "Someone else changed the live waiver a moment ago, so this change was not applied. Reload the page to see the current version.",
    );
  }

  if (previous) {
    const { error: restoreErr } = await admin
      .from("waiver_templates")
      .update({ is_current: true })
      .eq("id", previous.id);
    if (restoreErr) {
      // Both writes failed and nothing is live. This is the outage case, so it
      // gets a server-side log AND a message that tells the manager the signing
      // page is down rather than a generic failure they would shrug at.
      console.error("[promoteWaiverTemplate] could not restore the live template:", restoreErr);
      throw new Error(
        "The waiver version could not be changed, and the club is now left with no live waiver, so nobody can sign. Try again now to fix it.",
      );
    }
  }
  throw new Error(setErr.message);
}

export const setCurrentWaiverTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setCurrentTemplateSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { version } = await promoteWaiverTemplate(supabaseAdmin, data.id);
    return { ok: true as const, version };
  });

// ---- Manager: save new template version ----
export const saveWaiverTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveTemplateSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);

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

    // Write the new version as a draft, THEN promote it.
    //
    // The obvious order (clear `is_current`, then insert the row with
    // `is_current = true`) leaves the club with no live waiver if the insert
    // fails, and there is nothing to roll back to by then. This way a failed
    // insert changes nothing at all, and a failed promotion leaves the previous
    // version live with an unused draft behind it — a manager can retry, and
    // nobody's signing page went down in the meantime.
    const { data: created, error } = await supabaseAdmin
      .from("waiver_templates")
      .insert({
        version: nextVersion,
        title: data.title,
        body_md: data.body_md,
        acknowledgements: data.acknowledgements,
        is_current: false,
        created_by: context.userId,
      })
      .select("id, version")
      .single();
    if (error) throw new Error(error.message);

    await promoteWaiverTemplate(supabaseAdmin, created.id);
    return { ok: true as const, version: created.version };
  });

// ---- Manager: list waivers ----
export const listWaivers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin;
    // Each row shows the SUBMITTED name/email (the frozen submission), plus a
    // derived status: the person's latest approved waiver is their active one,
    // older approved ones are superseded, the rest are pending.
    const { data, error } = await admin
      .from("waivers")
      .select(
        "id, user_id, first_name, middle_name, last_name, preferred_name, email, signed_at, template_version, pdf_path, approval_status, approved_at, signer_meta",
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
      // A scanned paper form filed by a manager. Shown on the list because the
      // row otherwise looks identical to one signed online, and the difference
      // matters: there is no signing IP or browser record behind it.
      is_paper: isPaperWaiver(row.signer_meta),
    }));
  });

// ---- Manager: file a scanned paper waiver ----
//
// The paper equivalent of the public signing page. Someone fills the form at
// the door, a manager scans it, and it lands here as an ordinary submission so
// the club has one place where every waiver lives.
//
// What it deliberately does NOT do:
//   - approve anything. Approval promotes the details onto the profile, unlocks
//     the login, emails a sign-in link and assigns the trial (docs/waivers.md
//     rule 6). Those are the same consequences whatever the waiver arrived on,
//     so a manager takes that step by hand, from the same button as always.
//   - email anybody. Nobody just pressed submit: the signer is not sitting at a
//     screen waiting for their copy, and the managers are the ones filing it.
//     The confirmation emails would be answering a question no one asked.
//
// The actual work is `filePaperWaiver`, a plain function rather than part of
// this createServerFn: the manager agent HTTP API (src/routes/api/manager/agent.ts,
// action `file_waiver`) authenticates by API token, not a Supabase session, so
// it cannot go through requireSupabaseAuth. Both entry points call the same
// function after their own auth check, so a scripted migration and a manager's
// own upload produce identical waivers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function filePaperWaiver(
  admin: SupabaseClient<Database>,
  data: PaperWaiverUploadInput,
  uploadedByUserId: string,
): Promise<{ id: string; user_id: string }> {
  if (isFutureSigningDate(data.signed_on, new Date().toISOString())) {
    throw new Error("The signing date is in the future. Check the date on the form.");
  }

  const { buildScanPdf, decodeBase64 } = await import("./waiver-scan");

  const email = normalizeEmail(data.email);

  // Build the PDF BEFORE creating anything: an unreadable scan is the likely
  // failure here, and it must not leave behind a waiver row with no document
  // or a person record for an email nobody has actually filed a form for.
  let pdf: Uint8Array;
  try {
    pdf = await buildScanPdf(
      data.scan.map((file, i) => {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(file.data);
        } catch {
          // atob()'s own error message is a raw runtime string ("atob() called
          // with invalid base64-encoded data...") — not something to show a
          // manager. Name the offending file instead.
          throw new Error(`scan[${i}] is not valid base64.`);
        }
        return { name: file.name, type: file.type, bytes };
      }),
    );
  } catch (e) {
    console.error("[filePaperWaiver] could not build the scan PDF:", e);
    throw new Error(
      e instanceof Error
        ? e.message
        : "We couldn't read that scan. Try a PDF, or photograph each page again.",
    );
  }

  // Same person resolution as an online submission: an existing email attaches
  // to that person untouched, a new one becomes a locked applicant. Never
  // verified by this route — a manager holding a piece of paper is not proof
  // that anyone can read the mailbox written on it.
  const userId = await resolvePersonId(admin, {
    email,
    emailProven: false,
    seed: {
      first_name: data.first_name,
      middle_name: data.middle_name || null,
      last_name: data.last_name,
      preferred_name: data.preferred_name || null,
      phone: data.phone || null,
    },
  });

  const isMinor = isMinorOn(data.date_of_birth, data.signed_on);
  // The date written on the form, not the moment it was filed: this is what
  // the club's records show as the signing date, and what the lists order by.
  // Midnight UTC keeps the club's own timezone (UTC+10/+11) reading back the
  // same calendar date.
  const signed_at = `${data.signed_on}T00:00:00.000Z`;

  // Who filed it, when, and from what. This is the paper equivalent of the IP
  // and browser context an online submission carries: the provenance of the
  // record, which for a scan is the manager who vouched for it.
  const signer_meta: SignerMeta = {
    source: PAPER_WAIVER_SOURCE,
    uploaded_at: new Date().toISOString(),
    uploaded_by: uploadedByUserId,
    scan_files: data.scan.map((f) => f.name),
  };
  // Not every caller resolves to a real auth user: the manager agent API's
  // break-glass env-key fallback (docs: AGENTS.md) has no owner to look up, so
  // skip the lookup rather than log a spurious not-found error every call.
  if (UUID_RE.test(uploadedByUserId)) {
    try {
      const { data: manager } = await admin.auth.admin.getUserById(uploadedByUserId);
      if (manager.user?.email) signer_meta.uploaded_by_email = manager.user.email;
    } catch (e) {
      console.error("[filePaperWaiver] could not resolve the uploading manager:", e);
    }
  }

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
      emergency_contact_relationship: data.emergency_contact_relationship || null,
      emergency_contact_phone: data.emergency_contact_phone,
      medical_notes: data.medical_notes || null,
      is_minor: isMinor,
      // As on the online form, a minor's emergency contact IS the guardian
      // who signed, so the guardian columns come from that one block.
      guardian_name: isMinor ? data.emergency_contact_name : null,
      guardian_relationship: isMinor ? data.emergency_contact_relationship || null : null,
      signed_at,
      template_version: data.template_version ?? null,
      // No IP: nobody connected from anywhere to sign this.
      signer_ip: null,
      signer_meta,
    })
    .select("id")
    .single();
  if (insErr || !inserted) throw new Error(insErr?.message || "Could not save the waiver.");

  const path = `${inserted.id}.pdf`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (upErr) {
    // A paper waiver whose scan did not store is worth nothing: there is no
    // generated PDF to fall back on, and no screen anywhere to attach one to
    // afterwards. Take the empty row back out so the manager can simply file
    // it again, rather than leaving a waiver that looks real and has no
    // document behind it. If even the cleanup fails, say so plainly instead
    // of pointing at a repair path that does not exist.
    console.error("[filePaperWaiver] scan upload failed:", upErr);
    const rowRemoved = await removeAbandonedWaiverRow(admin, inserted.id);
    throw new Error(
      rowRemoved
        ? "The scan could not be stored. Nothing was filed, so please try again."
        : "The scan could not be stored, and the half-filed waiver could not be cleaned up. Check this person's waivers before filing it again.",
    );
  }

  const { error: pathErr } = await admin
    .from("waivers")
    .update({ pdf_path: path })
    .eq("id", inserted.id);
  if (pathErr) {
    // The scan IS durably stored at this point, but nothing points at it: an
    // approval here would promote a waiver with no retrievable document, found
    // out only later when a manager tries to open it (getWaiverPdfUrl throws
    // "Waiver PDF not found"). Unwind the row exactly as the upload failure
    // above does, and also remove the now-orphaned scan, so a retry starts
    // clean instead of leaving either behind.
    console.error("[filePaperWaiver] could not point the waiver at its scan:", pathErr);
    const rowRemoved = await removeAbandonedWaiverRow(admin, inserted.id);
    const { error: scanCleanupErr } = await admin.storage.from(BUCKET).remove([path]);
    if (scanCleanupErr) {
      console.error("[filePaperWaiver] could not remove the orphaned scan:", scanCleanupErr);
    }
    throw new Error(
      rowRemoved
        ? "Could not finish filing the waiver. Nothing was filed, so please try again."
        : "Could not finish filing the waiver, and the half-filed waiver could not be cleaned up. Check this person's waivers before filing it again.",
    );
  }

  return { id: inserted.id, user_id: userId };
}

/**
 * Remove a waiver row that failed partway through filing, so a manager can
 * simply file it again rather than a half-filed row sitting in their list.
 * Returns whether the removal succeeded, so the caller can tell the manager
 * plainly when it did not: a row that genuinely could not be removed needs a
 * different message ("go check for it") than one that was cleaned up ("try
 * again"). Logs its own failure and never throws — a cleanup failure must
 * never mask the original error the caller is already surfacing.
 */
async function removeAbandonedWaiverRow(
  admin: SupabaseClient<Database>,
  waiverId: string,
): Promise<boolean> {
  const { error } = await admin.from("waivers").delete().eq("id", waiverId);
  if (error) {
    console.error("[filePaperWaiver] could not remove the half-filed waiver row:", error);
    return false;
  }
  return true;
}

// ---- Manager: upload a scanned paper waiver, from the web form ----
export const uploadPaperWaiver = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => paperWaiverUploadSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { id, user_id } = await filePaperWaiver(supabaseAdmin, data, context.userId);
    return { ok: true as const, id, user_id };
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
    await requireManager(context);

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
