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
  nextUtcDay,
  normalizeEmail,
  paperWaiverUploadSchema,
  saveTemplateSchema,
  setCurrentTemplateSchema,
  waiverApprovalSchema,
  waiverSubmitSchema,
  waiverToProfileFields,
} from "@/lib/validation";
import type {
  AcknowledgementDef,
  PaperWaiverUploadInput,
  SaveTemplateInput,
  SignerMeta,
} from "@/lib/validation";
import { beltSizeForGiSize, type GiSize } from "@/lib/kit-sizes";
import {
  mediaConsentFromAnswers,
  missingRequiredAcks,
  parseTemplateAcks,
  resolveAcknowledgements,
} from "@/lib/waiver-acknowledgements";
import {
  DuplicateCheckFailedError,
  DuplicateWaiverError,
  SubmissionIdConflictError,
  WaiverFilingIncompleteError,
  toDuplicateRefs,
} from "@/lib/waiver-duplicates";
import { supersedesMediaConsent } from "@/lib/waiver-approval";
import { hasMediaAcknowledgement, WaiverTemplateError } from "@/lib/waiver-template-editor";
import type { DuplicateWaiverRef } from "@/lib/waiver-duplicates";
import { userIdByEmail } from "@/lib/supabase-rpc";
import { resolveWaiverContacts } from "@/lib/waiver-contacts";
import { actorUserId } from "@/lib/manager-agent";

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
  /**
   * Root-relative link to sign the code of conduct, carrying a token so a
   * still-locked applicant can get there without logging in. Null whenever the
   * token could not be minted, or on a fast-path return that predates minting
   * one (the honeypot drop, or an idempotent retry of an already-signed
   * submission) — the confirmation email carries the same link independently,
   * so this is never the only way back to it.
   */
  code_of_conduct_url: string | null;
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
    const { tokenProvesEmail, mailboxProvingPurposes } = await import("@/lib/email-verification");
    // Only a token that reached an inbox can answer this. Notably that excludes
    // the code-of-conduct token, which this very handler returns to the caller
    // in its response — without this scope, one submission's response token was
    // the next submission's proof of the same address.
    const token = await lookupVerificationToken(admin, raw, {
      purposes: mailboxProvingPurposes,
    });
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
  /** Optional kit sizing. Only ever seeds a person being created right now. */
  gi_size?: string | null;
  belt_size?: string | null;
  /** Optional previous martial arts experience. Same "new person only" rule. */
  martial_arts_experience?: string | null;
};

/**
 * Write the optional gi size a waiver submission carried onto the signer's
 * profile.
 *
 * Sizing is equipment, not part of the waiver: no `waivers` column holds it and
 * it never reaches the PDF. It lives only on the profile, so it is written here.
 *
 * ⚠️ `identityProven` is the security boundary, and it is not optional.
 * `/waiver` is public and unauthenticated, and `resolvePersonId` resolves ANY
 * email the club already knows to that existing person — its contract is that
 * "resubmission is always allowed and never modifies the existing person".
 * Without this gate anyone could POST a submission carrying a member's address
 * and rewrite that member's record, with no login and no manager step. So an
 * existing person's size moves only when the submitter is demonstrably them:
 * signed in as them (already checked against the submitted address), or holding
 * a link we emailed to that address. A brand-new person is handled by
 * `PersonSeed` in `resolvePersonId` instead, where there is nothing to
 * overwrite.
 *
 * Two further rules, both about not destroying something deliberate:
 *
 * - A BLANK size writes nothing at all. Leaving an optional field empty means
 *   "nothing to say", so re-signing never clears a size already on file.
 * - The belt is filled in from the gi size ONLY when the record carries no
 *   sizing whatsoever. Once either size is set, a null belt is a belt somebody
 *   cleared on purpose, and a later waiver must not quietly put it back.
 *
 * Takes `admin` as a parameter rather than lazy-importing it, for the same
 * reason `signStoredPdf` and `filePaperWaiver` do: the createServerFn handler
 * around it cannot run under the test runner, and this can.
 */
export async function applyWaiverGiSize(
  admin: SupabaseClient<Database>,
  opts: { userId: string; giSize: string | null | undefined; identityProven: boolean },
): Promise<"written" | "skipped"> {
  if (!opts.giSize) return "skipped";
  if (!opts.identityProven) return "skipped";

  // This read decides whether the belt gets filled in, so a FAILED read must
  // not read as "no sizing on file" — that would let a transient error put back
  // a belt somebody cleared. Throw rather than guess; the caller swallows it.
  const { data: current, error: readErr } = await admin
    .from("profiles")
    .select("gi_size, belt_size")
    .eq("user_id", opts.userId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!current) throw new Error("No profile to write that size to.");

  const neverSized = current.gi_size == null && current.belt_size == null;
  const { data: updated, error: writeErr } = await admin
    .from("profiles")
    .update({
      gi_size: opts.giSize,
      ...(neverSized ? { belt_size: beltSizeForGiSize(opts.giSize as GiSize) } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", opts.userId)
    .select("user_id");
  if (writeErr) throw new Error(writeErr.message);
  // PostgREST reports no error when the filter matched nothing, so "no rows"
  // would otherwise be indistinguishable from a successful write.
  if (!updated || updated.length === 0) throw new Error("No profile to write that size to.");
  return "written";
}

/**
 * Write the optional previous martial arts experience a waiver submission
 * carried onto the signer's profile.
 *
 * Moved here from the "Start your free trial" lead form: it's useful context
 * for an instructor meeting someone for the first time, not anything the
 * person is declaring or agreeing to. Same treatment as `applyWaiverGiSize`:
 * no `waivers` column holds it, it never reaches the PDF, and it lives only on
 * the profile — see that function's doc comment for why `identityProven`
 * gates every write, and why a blank value writes nothing at all.
 */
export async function applyWaiverMartialArtsExperience(
  admin: SupabaseClient<Database>,
  opts: { userId: string; experience: string | null | undefined; identityProven: boolean },
): Promise<"written" | "skipped"> {
  const trimmed = (opts.experience ?? "").trim();
  if (!trimmed) return "skipped";
  if (!opts.identityProven) return "skipped";

  const { data: updated, error: writeErr } = await admin
    .from("profiles")
    .update({ martial_arts_experience: trimmed, updated_at: new Date().toISOString() })
    .eq("user_id", opts.userId)
    .select("user_id");
  if (writeErr) throw new Error(writeErr.message);
  if (!updated || updated.length === 0) throw new Error("No profile to write that experience to.");
  return "written";
}

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
    if (data.hp)
      return {
        ok: true,
        waiver_id: "",
        pdf_url: null,
        pdf_ready: false,
        code_of_conduct_url: null,
      };

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
        return {
          ok: true,
          waiver_id: already.id,
          pdf_url: url,
          pdf_ready: Boolean(url),
          // This retry didn't mint a token itself; the original attempt's
          // confirmation email already carries the working link.
          code_of_conduct_url: null,
          // Nor does it re-apply the gi size. This return sits above the point
          // where the email is normalized and identity is established, so
          // `applyWaiverGiSize` has neither the person nor the proof it needs,
          // and hoisting that work above the duplicate check would be a lot of
          // machinery for a best-effort field. If the original attempt's size
          // write failed, the size is simply not set, and the member or a
          // manager sets it on /account. Deliberate, not an oversight.
        };
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

    // The two people beside the participant, worked out once from the raw
    // fields: a minor's guardian may be someone other than the emergency
    // contact, and each of the guardian's contact details is optional on the
    // form because blank means "the same as the participant's". Everything
    // below -- the frozen row and the PDF -- uses these resolved values, so the
    // document and the record can never disagree about who signed.
    const contacts = resolveWaiverContacts({
      isMinor,
      address: data.address,
      phone: data.phone,
      email,
      guardianName: data.guardian_name || "",
      guardianRelationship: data.guardian_relationship || "",
      guardianAddress: data.guardian_address || "",
      guardianPhone: data.guardian_phone || "",
      guardianEmail: data.guardian_email || "",
      emergencyContactIsGuardian: data.emergency_contact_is_guardian ?? false,
      emergencyContactName: data.emergency_contact_name || "",
      emergencyContactRelationship: data.emergency_contact_relationship || "",
      emergencyContactPhone: data.emergency_contact_phone || "",
    });

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
            // Only reached when this email is NEW to the club, so there is no
            // existing record for these to overwrite. An existing person's
            // sizes are handled further down, and only with proof of identity.
            ...(data.gi_size
              ? { gi_size: data.gi_size, belt_size: beltSizeForGiSize(data.gi_size) }
              : {}),
            ...(data.martial_arts_experience?.trim()
              ? { martial_arts_experience: data.martial_arts_experience.trim() }
              : {}),
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

    // The code of conduct is the next thing we ask for, and the only moment
    // most people will do it willingly is right now, while they are already
    // filling forms in. They cannot log in yet (an applicant's login stays
    // banned until a manager approves them), so the link has to carry its own
    // proof of who they are: a token, exactly like the interest email's.
    //
    // Minted here, before the waiver insert even runs, so it is available to
    // every `notify()` call below — including the PDF-failure paths, which
    // must not lose it just because the copy didn't render.
    //
    // Best-effort, and deliberately so. Signing the code of conduct is optional
    // and never blocks training, so a token that could not be minted costs the
    // signer a button, not their waiver.
    let codeOfConductToken: string | null = null;
    try {
      const { mintVerificationToken } = await import("./email-verification.server");
      codeOfConductToken = await mintVerificationToken(admin, {
        email,
        purpose: "code_of_conduct",
        userId,
      });
    } catch (e) {
      console.error("[submitWaiverWithPdf] could not mint a code-of-conduct link:", e);
    }
    const { buildCodeOfConductUrl } = await import("./code-of-conduct");
    const codeOfConductUrl = codeOfConductToken
      ? buildCodeOfConductUrl({ token: codeOfConductToken })
      : null;

    // The waiver row is the frozen submission: exactly what was typed
    // (including the email as submitted), plus provenance (template version,
    // signer IP, signing context) and timestamps. Signatures and
    // acknowledgements live inside the PDF only, with one exception below:
    // media consent is also copied to a column, because the club has to act on
    // it. Resubmission is always allowed; managers pick which submission to
    // approve.
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
        // Read off the acknowledgement the signer actually ticked on the
        // document, never off a separate client field: the column and the PDF
        // must agree, and only the PDF is evidence. Null while the live
        // template has no media item, which is the state until a manager
        // promotes the draft version that adds one.
        media_consent: mediaConsentFromAnswers(ackDefs, answers),
        emergency_contact_name: contacts.emergencyContactName,
        emergency_contact_relationship: contacts.emergencyContactRelationship,
        emergency_contact_phone: contacts.emergencyContactPhone,
        medical_notes: data.medical_notes || null,
        is_minor: isMinor,
        // Resolved above, never the raw fields: an optional guardian detail is
        // stored as the value it stands for, so nobody reading this row later
        // has to work out what a blank meant.
        guardian_name: contacts.guardianName || null,
        guardian_relationship: contacts.guardianRelationship || null,
        guardian_address: contacts.guardianAddress || null,
        guardian_phone: contacts.guardianPhone || null,
        guardian_email: contacts.guardianEmail || null,
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
        // The other attempt in this race is the one that will mint the token
        // and send the emails; this one just adopts its row.
        return {
          ok: true,
          waiver_id: raced.id,
          pdf_url: url,
          pdf_ready: Boolean(url),
          code_of_conduct_url: null,
        };
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

    // The optional gi size the form collected, onto the signer's profile.
    // Extracted so it is reachable from a unit test (see applyWaiverGiSize);
    // best-effort here because a size must never cost somebody a signature.
    try {
      await applyWaiverGiSize(admin, {
        userId,
        giSize: data.gi_size,
        identityProven: Boolean(callerId || emailProven),
      });
    } catch (e) {
      console.error("waiver: could not save gi size", e);
    }

    // The optional previous martial arts experience the form collected, onto
    // the signer's profile. Same best-effort treatment as gi size above.
    try {
      await applyWaiverMartialArtsExperience(admin, {
        userId,
        experience: data.martial_arts_experience,
        identityProven: Boolean(callerId || emailProven),
      });
    } catch (e) {
      console.error("waiver: could not save martial arts experience", e);
    }

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
          // So the email can offer the code of conduct too: the signer may well
          // close this tab without doing it now, and this is the only way back
          // in until a manager approves them.
          codeOfConductToken,
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
        emergency_contact_name: contacts.emergencyContactName,
        emergency_contact_relationship: contacts.emergencyContactRelationship,
        emergency_contact_phone: contacts.emergencyContactPhone,
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
        guardian_name: contacts.guardianName,
        guardian_relationship: contacts.guardianRelationship,
        guardian_address: contacts.guardianAddress,
        guardian_phone: contacts.guardianPhone,
        guardian_email: contacts.guardianEmail,
        guardian_signature: data.guardian_signature || "",
        signature_image_png: sigPng,
        guardian_signature_image_png: gSigPng,
      });
    } catch (e) {
      console.error("[submitWaiverWithPdf] PDF generation failed:", e);
      await notify(null);
      return {
        ok: true,
        waiver_id: inserted.id,
        pdf_url: null,
        pdf_ready: false,
        code_of_conduct_url: codeOfConductUrl,
      };
    }

    const path = `${inserted.id}.pdf`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) {
      console.error("[submitWaiverWithPdf] PDF upload failed:", upErr);
      await notify(null);
      return {
        ok: true,
        waiver_id: inserted.id,
        pdf_url: null,
        pdf_ready: false,
        code_of_conduct_url: codeOfConductUrl,
      };
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
      code_of_conduct_url: codeOfConductUrl,
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
//
// ⚠️ THIS ENDPOINT IS UNAUTHENTICATED, and the id is the only thing guarding a
// signed link to the waiver PDF — health declaration included (see
// newSubmissionId in submit-resilience.ts). That is sound for an id a signer's
// own browser minted from a CSPRNG and never wrote down.
//
// It is NOT sound for a PAPER waiver. `file_waiver` on the manager agent API
// lets its caller choose the id, so those values live in import scripts and
// agent transcripts, and the obvious way to make a retry resend "the same" id
// is to derive it from the record (uuidv5 of the email, say) — which would make
// somebody else's scanned waiver readable by anyone who guesses the scheme.
// Paper filings are therefore excluded here. Nothing is waiting on one: a
// manager filed it, there is no browser mid-submit to reassure, so answering
// costs nobody anything and not answering closes the hole.
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
        .select("id, pdf_path, signer_meta")
        .eq("client_submission_id", data.client_submission_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      // Indistinguishable from "no such submission" on purpose: a caller probing
      // ids must not learn that one exists but is off limits.
      if (!row || isPaperWaiver(row.signer_meta)) {
        return { found: false, waiver_id: null, pdf_url: null };
      }
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
/**
 * One stored version of the waiver, as every manager surface reads it.
 *
 * The editor screen and the manager agent API project the same row through the
 * same functions below, so a version an agent reads back is the version a
 * manager sees on screen — including the acknowledgements, which live in a JSONB
 * column and are only trustworthy once `parseTemplateAcks` has been over them.
 */
export type WaiverTemplateVersion = {
  id: string;
  version: number;
  title: string;
  body_md: string;
  acknowledgements: AcknowledgementDef[];
  is_current: boolean;
  created_at: string;
};

type WaiverTemplateRow = {
  id: string;
  version: number;
  title: string;
  body_md: string;
  acknowledgements: unknown;
  is_current: boolean;
  created_at: string;
};

function projectWaiverTemplate(row: WaiverTemplateRow): WaiverTemplateVersion {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    body_md: row.body_md,
    acknowledgements: parseTemplateAcks(row.acknowledgements),
    is_current: row.is_current,
    created_at: row.created_at,
  };
}

/**
 * Every stored version, newest first.
 *
 * Exported and taking its client as a parameter for the same reason
 * `promoteWaiverTemplate` is: a `createServerFn` handler only runs inside a Start
 * request context, and the manager agent API has to reach the same list the
 * editor screen shows rather than growing a second query of its own.
 */
export async function listWaiverTemplateRows(
  admin: SupabaseClient<Database>,
): Promise<WaiverTemplateVersion[]> {
  const { data, error } = await admin
    .from("waiver_templates")
    .select("id, version, title, body_md, acknowledgements, is_current, created_at")
    .order("version", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(projectWaiverTemplate);
}

/**
 * One stored version, or the live one when no version is named.
 *
 * "The live one" is the row flagged `is_current`, never the highest-numbered
 * one. Those differ the moment a manager rolls back to earlier wording, and
 * answering with the newest would have a caller read version 9, edit it, and
 * publish it over the version 4 the club deliberately went back to.
 */
export async function loadWaiverTemplateVersion(
  admin: SupabaseClient<Database>,
  version?: number,
): Promise<WaiverTemplateVersion | null> {
  const query = admin
    .from("waiver_templates")
    .select("id, version, title, body_md, acknowledgements, is_current, created_at");
  const { data, error } = await (
    version === undefined ? query.eq("is_current", true) : query.eq("version", version)
  ).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? projectWaiverTemplate(data) : null;
}

export const listWaiverTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return listWaiverTemplateRows(supabaseAdmin);
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
    .select("id, version, is_current, acknowledgements")
    .eq("id", id)
    .maybeSingle();
  if (tErr) throw new WaiverTemplateError(tErr.message, "not_published");
  // Both checks happen BEFORE anything is cleared: a bad id or an already-live
  // target must never cost the club its live waiver.
  if (!target) throw new WaiverTemplateError("That waiver version no longer exists.", "not_found");
  if (target.is_current) return { version: target.version };
  // A template can only go live carrying the media-consent acknowledgement.
  // This is the one place every promotion passes through -- `saveWaiverTemplate`
  // ends by calling this on the version it just inserted -- so it also catches
  // a manager loading and re-saving a version from before the feature existed,
  // not just a direct promote of an old stored one. See
  // `hasMediaAcknowledgement` for what counts as still carrying it.
  if (!hasMediaAcknowledgement(parseTemplateAcks(target.acknowledgements))) {
    throw new WaiverTemplateError(
      "This version has no media consent acknowledgement (or its wording is blank), so making it live would stop the club recording who agreed to photos. Add it back before making this version live.",
      "invalid",
      target.version,
    );
  }

  const { data: previous, error: pErr } = await admin
    .from("waiver_templates")
    .select("id")
    .eq("is_current", true)
    .maybeSingle();
  if (pErr) throw new WaiverTemplateError(pErr.message, "not_published", target.version);

  const { error: clearErr } = await admin
    .from("waiver_templates")
    .update({ is_current: false })
    .eq("is_current", true);
  if (clearErr) throw new WaiverTemplateError(clearErr.message, "not_published", target.version);

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
    throw new WaiverTemplateError(
      "Someone else changed the live waiver a moment ago, so this change was not applied. Reload the page to see the current version.",
      "not_published",
      target.version,
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
      throw new WaiverTemplateError(
        "The waiver version could not be changed, and the club is now left with no live waiver, so nobody can sign. Try again now to fix it.",
        "not_published",
        target.version,
      );
    }
  }
  throw new WaiverTemplateError(setErr.message, "not_published", target.version);
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

/**
 * Write a new version of the waiver and make it the one people sign.
 *
 * That is the whole of "save" as the editor screen means it: there is no draft
 * state, saving publishes, and waivers already signed keep the version they were
 * signed against. Exported and client-parameterised like `promoteWaiverTemplate`
 * so the manager agent API saves through exactly this path instead of a second
 * one that could drift from it.
 *
 * `createdBy` is null for a caller that resolves to no auth user (the agent
 * API's break-glass env key), because the column is a real FK to `auth.users`.
 *
 * The media-consent check runs BEFORE the insert. `promoteWaiverTemplate` would
 * refuse the publish anyway, but only after the row existed, leaving a draft
 * version nobody asked for sitting in the editor's version list. Refusing first
 * means a rejected save changes nothing at all.
 */
export async function saveWaiverTemplateVersion(
  admin: SupabaseClient<Database>,
  input: SaveTemplateInput,
  createdBy: string | null,
): Promise<{ id: string; version: number }> {
  if (!hasMediaAcknowledgement(input.acknowledgements)) {
    throw new WaiverTemplateError(
      "This version has no media consent acknowledgement (or its wording is blank), so saving it would stop the club recording who agreed to photos. Add it back before saving.",
      "invalid",
    );
  }

  // A failed read here would number the new template 1 and collide with the
  // existing version 1, so the manager's save would fail on a duplicate-key
  // message that says nothing about what actually went wrong.
  const { data: maxRow, error: maxErr } = await admin
    .from("waiver_templates")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxErr) throw new WaiverTemplateError(maxErr.message, "not_published");
  const nextVersion = (maxRow?.version ?? 0) + 1;

  // Write the new version as a draft, THEN promote it.
  //
  // The obvious order (clear `is_current`, then insert the row with
  // `is_current = true`) leaves the club with no live waiver if the insert
  // fails, and there is nothing to roll back to by then. This way a failed
  // insert changes nothing at all, and a failed promotion leaves the previous
  // version live with an unused draft behind it — a manager can retry, and
  // nobody's signing page went down in the meantime.
  const { data: created, error } = await admin
    .from("waiver_templates")
    .insert({
      version: nextVersion,
      title: input.title,
      body_md: input.body_md,
      acknowledgements: input.acknowledgements,
      is_current: false,
      created_by: createdBy,
    })
    .select("id, version")
    .single();
  if (error) throw new WaiverTemplateError(error.message, "not_published");

  // The version now exists. Whatever the promotion does from here, the caller
  // has to hear about THAT rather than about a save it should repeat: saving
  // again would file a second numbered draft, where publishing this one
  // finishes what this call started.
  await promoteWaiverTemplate(admin, created.id);
  return { id: created.id, version: created.version };
}

export const saveWaiverTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveTemplateSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { version } = await saveWaiverTemplateVersion(supabaseAdmin, data, context.userId);
    return { ok: true as const, version };
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

/**
 * How many signed waivers are waiting for a manager, and who signed the newest
 * one. Feeds the "needs attention" list behind /notifications.
 *
 * `approval_status` is the stored fact, and it is the right one to count here.
 * The list screen's third state, `superseded`, is derived from a person's OTHER
 * approved waivers and only ever applies to one that is already approved, so it
 * can never hide work from this count.
 *
 * A plain exported function taking its client, like `countUnreadContactMessages`:
 * the attention list is composed in one place and this is a source for it.
 */
export async function countWaiversAwaitingApproval(admin: SupabaseClient<Database>): Promise<{
  pending: number;
  latestName: string | null;
  latestAt: string | null;
}> {
  const { count, error } = await admin
    .from("waivers")
    .select("id", { count: "exact", head: true })
    .eq("approval_status", "pending");
  // Degrade rather than throw: this runs inside the attention list's
  // Promise.all, and a failed count must not take down the other items with it.
  if (error) {
    console.error("[waivers] could not count waivers awaiting approval:", error);
    return { pending: 0, latestName: null, latestAt: null };
  }
  const pending = count ?? 0;
  if (pending === 0) return { pending: 0, latestName: null, latestAt: null };

  const { data: latest, error: latestError } = await admin
    .from("waivers")
    .select("first_name, middle_name, last_name, preferred_name, signed_at")
    .eq("approval_status", "pending")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // The count is the part the notification cannot do without; a missing name
  // only makes the copy vaguer.
  if (latestError) {
    console.error("[waivers] could not read the newest waiting waiver:", latestError);
    return { pending, latestName: null, latestAt: null };
  }
  return {
    pending,
    latestName: latest ? nameWithPreferred(latest) : null,
    latestAt: latest?.signed_at ?? null,
  };
}

// ---- Manager: file a scanned paper waiver ----
//
// The paper equivalent of the public signing page. Someone fills the form at
// the door, a manager scans it, and it lands here as an ordinary submission so
// the club has one place where every waiver lives.
//
// What it deliberately does NOT do:
//   - approve anything. Approval promotes the details onto the profile, unlocks
//     the login, emails the account-activated notice and assigns the trial (docs/waivers.md
//     rule 6). Those are the same consequences whatever the waiver arrived on,
//     so a manager takes that step by hand, from the same button as always.
//   - email anybody. Nobody just pressed submit: the signer is not sitting at a
//     screen waiting for their copy, and the managers are the ones filing it.
//     The confirmation emails would be answering a question no one asked.
//
// What it DOES push back on: filing a waiver this person already has for the
// same signing date. Signing repeatedly is allowed, but the same paper landing
// twice is a bulk-import accident, and every extra pending copy is another
// chance to approve the wrong one (the active waiver is the last APPROVED, not
// the last signed). It throws DuplicateWaiverError; `confirm_duplicate` files
// it anyway, for the corrected re-scan that is a genuine second document.
//
// The actual work is `filePaperWaiver`, a plain function rather than part of
// this createServerFn: the manager agent HTTP API (src/routes/api/manager/agent.ts,
// action `file_waiver`) authenticates by API token, not a Supabase session, so
// it cannot go through requireSupabaseAuth. Both entry points call the same
// function after their own auth check, so a scripted migration and a manager's
// own upload produce identical waivers.
export async function filePaperWaiver(
  admin: SupabaseClient<Database>,
  data: PaperWaiverUploadInput,
  uploadedByUserId: string,
): Promise<{ id: string; user_id: string; created: boolean }> {
  if (isFutureSigningDate(data.signed_on, new Date().toISOString())) {
    throw new Error("The signing date is in the future. Check the date on the form.");
  }

  const email = normalizeEmail(data.email);
  const signed_at = `${data.signed_on}T00:00:00.000Z`;

  // Has this exact filing attempt already landed? Checked before any of the
  // expensive work: a retry of a call whose reply was lost should not decode
  // and re-render megabytes of scan just to find out. Same key, same row.
  const submissionId = data.client_submission_id || null;
  // Set when a previous attempt inserted the row but died before its scan was
  // stored. The retry finishes that row rather than filing a second one.
  let resumeWaiverId: string | null = null;
  if (submissionId) {
    const { data: already, error: lookupErr } = await admin
      .from("waivers")
      .select("id, email, signed_at, signer_meta")
      .eq("client_submission_id", submissionId)
      .maybeSingle();
    // Not fatal: falling through re-does the work, and the unique index still
    // stops a duplicate. Logged because the fallthrough is slower and can end in
    // a confusing duplicate_waiver, so it should be findable.
    if (lookupErr) console.error("[filePaperWaiver] submission lookup failed:", lookupErr);
    // The key namespace is shared with the PUBLIC online signing path — one
    // partial unique index over the whole table — so an id could land on a
    // waiver a signer's own browser minted. Ignore anything that is not a paper
    // filing: this endpoint may only ever resolve its own records, whatever the
    // caller's id scheme happens to collide with.
    if (already && !isPaperWaiver(already.signer_meta)) {
      throw new SubmissionIdConflictError();
    }
    if (already) {
      // One id, one record. A loop that mints the key per BATCH rather than per
      // record would otherwise hand back the first waiver's id for every record
      // after it, each with a 200, and file none of them.
      // Compare the DATE, not the timestamp string. `signed_at` is TIMESTAMPTZ,
      // and PostgREST renders it as `2020-01-15T00:00:00+00:00` — offset
      // notation, no fractional part when it is zero — where this function
      // WRITES `2020-01-15T00:00:00.000Z`. Comparing those two directly is
      // always unequal, which made every keyed retry fail this check and be
      // told its id belonged to a different waiver: the idempotency path was
      // dead, and an importer following that advice would mint a fresh id and
      // file the duplicate this whole feature exists to prevent.
      if (already.email !== email || already.signed_at.slice(0, 10) !== data.signed_on) {
        throw new SubmissionIdConflictError();
      }
      // Resume this row rather than filing a new one — whether its scan is
      // still missing, or the row is already fully filed and this is a replay.
      // Deliberately NOT an early return for the complete case: a keyed retry
      // is not always a byte-identical bulk-import replay. A manager retrying
      // from the same page can have corrected a field since the first attempt,
      // and treating a complete match as a no-op would report success without
      // ever saving that correction. The write step below always overwrites
      // the row with THIS call's data, so a matched row — complete or not —
      // ends up holding whatever was just submitted.
      resumeWaiverId = already.id;
    }
  }

  const { buildScanPdf, decodeBase64 } = await import("./waiver-scan");

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

  const isMinor = isMinorOn(data.date_of_birth, data.signed_on);

  // The signer and the emergency contact, resolved the same way the online
  // form resolves them (see resolveWaiverContacts). Paper filings never set
  // the "emergency contact is the guardian" flag: they carry whatever the
  // manager read off the page, and an old form's single contact block falls
  // through to the guardian by name.
  const paperContacts = resolveWaiverContacts({
    isMinor,
    address: data.address,
    phone: data.phone,
    email,
    guardianName: data.guardian_name || "",
    guardianRelationship: data.guardian_relationship || "",
    guardianAddress: data.guardian_address || "",
    guardianPhone: data.guardian_phone || "",
    guardianEmail: data.guardian_email || "",
    emergencyContactIsGuardian: false,
    emergencyContactName: data.emergency_contact_name,
    emergencyContactRelationship: data.emergency_contact_relationship || "",
    emergencyContactPhone: data.emergency_contact_phone,
  });

  // Who this waiver belongs to, if the club already knows the address. Looked up
  // BEFORE the duplicate probe and deliberately without creating anyone: a
  // filing that gets refused below must leave nothing behind, and creating the
  // person first would strand a locked auth user and a profile for someone who
  // has no waiver — indistinguishable afterwards from a real lead, and holding
  // that email address permanently. A brand-new address has no waivers to
  // collide with anyway, so the probe has nothing to do for it.
  const { data: existingPersonId, error: personLookupErr } = await userIdByEmail(admin, email);
  if (personLookupErr) throw new Error(personLookupErr.message);

  // Same person, same signing date: almost certainly the same piece of paper
  // arriving twice. Warn and let the caller confirm rather than blocking, since
  // a corrected re-scan of one signing date is legitimate. Checked here, not in
  // the agent API, so the manager's own upload form gets the same speed bump.
  // Skipped when resuming: that row IS this filing, not a duplicate of it.
  if (!data.confirm_duplicate && existingPersonId && !resumeWaiverId) {
    // One over the cap, so a full page is recognisable as "there are more" and
    // the message can say so instead of reporting the cap as the total.
    const DUPLICATE_PROBE_CAP = 20;
    // A RANGE over the day, not equality on midnight. Only a paper filing writes
    // midnight UTC; an online submission stores the actual moment it was signed,
    // so exact equality would have quietly compared paper against paper only —
    // while the manifest, this docstring and the error message all promise "a
    // waiver signed on this date". An online waiver and a paper form for the
    // same day are exactly as approvable-in-the-wrong-order as two paper ones,
    // and the migration case (filing paper for somebody who has since signed
    // online) is a realistic way to reach it.
    //
    // "Same day" means same UTC day, matching how this function writes signed_at
    // and how the waiver lists read it. The club is UTC+10/+11, so a signature
    // given in the Sydney morning lands on the previous UTC day and will not
    // collide with paper dated that morning. Known and accepted: widening to the
    // club's own day would instead collide across two dates, which is worse.
    const { data: sameDate, error: dupErr } = await admin
      .from("waivers")
      .select("id, approval_status, signed_at")
      .eq("user_id", existingPersonId)
      .gte("signed_at", signed_at)
      .lt("signed_at", `${nextUtcDay(data.signed_on)}T00:00:00.000Z`)
      .order("created_at", { ascending: true })
      .limit(DUPLICATE_PROBE_CAP + 1);
    // Fail closed: a duplicate slipping through silently is the thing being
    // fixed here, so an unanswerable question is not treated as a "no".
    //
    // ⚠️ The API maps this to a 503 documented as "nothing was filed, safe to
    // retry unchanged", and an unattended retry policy acts on that. It is true
    // only because this probe runs BEFORE resolvePersonId: moving person
    // creation above it would strand a locked auth user and a profile on every
    // retry, and no test asserting on the status code would notice.
    if (dupErr) {
      console.error("[filePaperWaiver] duplicate check failed:", dupErr);
      throw new DuplicateCheckFailedError();
    }
    if (sameDate?.length) {
      const truncated = sameDate.length > DUPLICATE_PROBE_CAP;
      throw new DuplicateWaiverError(
        toDuplicateRefs(sameDate.slice(0, DUPLICATE_PROBE_CAP)),
        truncated,
      );
    }
  }

  // Nothing can refuse this filing from here on, so it is now safe to create the
  // person if the club has never seen this address. An existing address resolves
  // to that person untouched; a new one becomes a locked applicant. Never
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
  // break-glass env-key fallback (docs/manager-agent-api.md) has no owner to look up, so
  // skip the lookup rather than log a spurious not-found error every call.
  if (actorUserId(uploadedByUserId)) {
    try {
      const { data: manager } = await admin.auth.admin.getUserById(uploadedByUserId);
      if (manager.user?.email) signer_meta.uploaded_by_email = manager.user.email;
    } catch (e) {
      console.error("[filePaperWaiver] could not resolve the uploading manager:", e);
    }
  }

  // Every field just submitted, written onto the row whether this is a fresh
  // filing or a resend of an id that matched one above. Using the SAME object
  // for an insert and a resume-update means a resumed row always ends up
  // holding THIS call's data, never a possibly-stale copy from an earlier
  // attempt.
  const waiverRow = {
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
    // Taken from the filing manager, not derived: there are no acknowledgement
    // ticks to read on a paper form, only a box on a page they are looking at.
    // Null when the paper predates the question.
    media_consent: data.media_consent ?? null,
    // Both contacts come off the same resolved object, so the two halves cannot
    // drift apart if paper filing ever grows its own "the contact IS the
    // guardian" flag. Identical to the raw fields today (that flag is false
    // here, and Zod has already trimmed them), which is the point: nothing
    // reads `data.emergency_contact_*` past this line.
    emergency_contact_name: paperContacts.emergencyContactName,
    emergency_contact_relationship: paperContacts.emergencyContactRelationship || null,
    emergency_contact_phone: paperContacts.emergencyContactPhone,
    medical_notes: data.medical_notes || null,
    is_minor: isMinor,
    // The signer, resolved the same way the online form resolves it. A paper
    // form from the old single-block layout names only one person, so for those
    // the emergency contact is the guardian, exactly as before.
    guardian_name: paperContacts.guardianName || null,
    guardian_relationship: paperContacts.guardianRelationship || null,
    guardian_address: paperContacts.guardianAddress || null,
    guardian_phone: paperContacts.guardianPhone || null,
    guardian_email: paperContacts.guardianEmail || null,
    signed_at,
    template_version: data.template_version ?? null,
    // No IP: nobody connected from anywhere to sign this.
    signer_ip: null,
    signer_meta,
  };

  // Captured before anything below can reassign resumeWaiverId (the raced-adopt
  // branch does, on a fresh insert's unique violation), so this always reflects
  // whether the row we're about to write was found by the lookup above.
  const isResumeAttempt = Boolean(resumeWaiverId);
  const { data: written, error: writeErr } = resumeWaiverId
    ? await admin.from("waivers").update(waiverRow).eq("id", resumeWaiverId).select("id").single()
    : await admin.from("waivers").insert(waiverRow).select("id").single();

  if (isResumeAttempt) {
    // A real write now (not the no-op it used to be), so it can genuinely fail
    // — a DB hiccup here must surface, not be swallowed by the `!resumeWaiverId`
    // check below, which is written for the insert branch and would otherwise
    // treat this as success because resumeWaiverId is already set.
    if (writeErr || !written) {
      throw new Error(writeErr?.message || "Could not save the waiver.");
    }
  } else {
    // Two retries of one filing were genuinely in flight at once, so the lookup
    // at the top ran before the other had committed. The partial unique index is
    // what actually stopped the duplicate. Adopt the winner's row rather than
    // reporting a failure for a waiver that is on file — but only once its scan
    // is stored. Adopting a row the winner is still uploading (or is about to
    // roll back) would report a document that may never exist.
    if (writeErr?.code === UNIQUE_VIOLATION && submissionId) {
      const { data: raced } = await admin
        .from("waivers")
        .select("id, user_id, pdf_path, signer_meta")
        .eq("client_submission_id", submissionId)
        .maybeSingle();
      // Same scoping as the lookup above: never adopt a non-paper row.
      if (raced && !isPaperWaiver(raced.signer_meta)) throw new SubmissionIdConflictError();
      if (raced?.user_id && raced.pdf_path) {
        return { id: raced.id, user_id: raced.user_id, created: false };
      }
      // The winner is mid-flight. Both attempts carry the same scan and write to
      // the same path, so finishing its row is safe and idempotent rather than a
      // race to be avoided.
      if (raced?.id) resumeWaiverId = raced.id;
    }
    if (!resumeWaiverId && (writeErr || !written)) {
      throw new Error(writeErr?.message || "Could not save the waiver.");
    }
  }

  const waiverId = resumeWaiverId ?? written!.id;
  const path = `${waiverId}.pdf`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (upErr) {
    // A paper waiver whose scan did not store is worth nothing: there is no
    // generated PDF to fall back on, and no screen anywhere to attach one to
    // afterwards.
    //
    // With a submission id, the row is KEPT: it belongs to that key, a retry
    // resumes it, and deleting it would both break that promise and risk
    // removing a row another in-flight attempt has already been told about.
    // Without one there is nothing to resume from, so the row still comes back
    // out and the manager simply files it again.
    console.error("[filePaperWaiver] scan upload failed:", upErr);
    if (submissionId) {
      throw new WaiverFilingIncompleteError(
        "The scan could not be stored, so this waiver is not filed yet. Retry with the same client_submission_id to finish it.",
      );
    }
    const rowRemoved = await removeAbandonedWaiverRow(admin, waiverId);
    throw new Error(
      rowRemoved
        ? "The scan could not be stored. Nothing was filed, so please try again."
        : "The scan could not be stored, and the half-filed waiver could not be cleaned up. Check this person's waivers before filing it again.",
    );
  }

  const { error: pathErr } = await admin
    .from("waivers")
    .update({ pdf_path: path })
    .eq("id", waiverId);
  if (pathErr) {
    // The scan IS durably stored at this point, but nothing points at it: an
    // approval here would promote a waiver with no retrievable document, found
    // out only later when a manager tries to open it (getWaiverPdfUrl throws
    // "Waiver PDF not found").
    //
    // Keyed calls keep both halves and retry: the scan is already where the
    // resume will look for it, so finishing is one update rather than a whole
    // re-upload. Unkeyed calls unwind both, exactly as before.
    console.error("[filePaperWaiver] could not point the waiver at its scan:", pathErr);
    if (submissionId) {
      throw new WaiverFilingIncompleteError(
        "Could not finish filing this waiver, so it is not filed yet. Retry with the same client_submission_id to finish it.",
      );
    }
    const rowRemoved = await removeAbandonedWaiverRow(admin, waiverId);
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

  // `created` is false when this call resumed a row an earlier attempt had
  // already inserted: the waiver is complete either way, but only one call
  // created it. Named `created` rather than `filed` because uploadPaperWaiver
  // already uses `filed` for a different question (filed, or blocked as a
  // duplicate), and two meanings for one word in one flow is a trap.
  return { id: waiverId, user_id: userId, created: !resumeWaiverId };
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
/**
 * A likely duplicate is not an error the form should throw away: the manager
 * needs to see WHAT it collided with and then decide. So it comes back as a
 * successful call with `filed: false` and the existing rows, and the screen
 * offers to file it anyway (which re-sends with `confirm_duplicate: true`).
 * Every other failure still throws, and the form toasts the message.
 */
export type UploadPaperWaiverResult =
  | { ok: true; filed: true; id: string; user_id: string }
  | { ok: true; filed: false; duplicate: DuplicateWaiverRef[] };

export const uploadPaperWaiver = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => paperWaiverUploadSchema.parse(d))
  .handler(async ({ data, context }): Promise<UploadPaperWaiverResult> => {
    await requireManager(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    try {
      const { id, user_id } = await filePaperWaiver(supabaseAdmin, data, context.userId);
      return { ok: true as const, filed: true as const, id, user_id };
    } catch (e) {
      if (e instanceof DuplicateWaiverError) {
        return { ok: true as const, filed: false as const, duplicate: e.existing };
      }
      throw e;
    }
  });

// ---- Manager: approve / unapprove a waiver submission ----
//
// Approval is the promotion step: the approved submission's details are copied
// onto the person's profile (the club's current record), and if they are still
// a locked applicant (banned auth user, no credentials) the ban is lifted and
// they're emailed to say their account is active (applicant -> visitor).
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

      // A waiver with no stored document must never become somebody's ACTIVE
      // record. Approving promotes it onto the profile and makes it the waiver
      // the club would produce if anyone asked what this person signed —
      // discovered as missing only when a manager clicks download, long after.
      //
      // The window is real on every path: a row exists before its PDF does. It
      // is widest for a paper filing, whose scan cannot be regenerated from
      // anything, and an abandoned keyed attempt can leave one indefinitely.
      // Cheap to check here, and it closes the dangerous end regardless of how
      // the row got into that state.
      if (!waiver.pdf_path) {
        throw new Error(
          "This waiver has no document stored yet, so it cannot be approved. If it was filed from a scan, file it again; if it was signed on the site, wait a moment and reload.",
        );
      }

      // Promote: the approved submission becomes the person's record.
      //
      // `waiverToProfileFields` omits `media_consent` entirely when this
      // submission never asked, so approving an older waiver cannot erase a
      // consent the club already holds. When it DOES carry one, that answer
      // only supersedes the profile's existing one when this waiver is
      // actually newer -- approving out of chronological order (every pending
      // waiver can be approved any time, and re-approval after an unapprove
      // is possible) must not let an old ticked box silently overwrite a
      // withdrawal the member made more recently on /account. See
      // `supersedesMediaConsent` in waiver-approval.ts.
      const patch = waiverToProfileFields(waiver);
      const { media_consent: waiverMediaConsent, ...patchWithoutMediaConsent } = patch;
      let mediaConsentPatch: {
        media_consent?: boolean;
        media_consent_updated_at?: null;
        media_consent_updated_by?: null;
      } = {};
      if ("media_consent" in patch) {
        const { data: currentProfile, error: cpErr } = await admin
          .from("profiles")
          .select("media_consent_updated_at")
          .eq("user_id", waiver.user_id)
          .maybeSingle();
        if (cpErr) throw new Error(cpErr.message);
        if (
          supersedesMediaConsent({
            waiverSignedAt: waiver.signed_at,
            profileMediaConsentUpdatedAt: currentProfile?.media_consent_updated_at ?? null,
          })
        ) {
          mediaConsentPatch = {
            media_consent: waiverMediaConsent,
            media_consent_updated_at: null,
            media_consent_updated_by: null,
          };
        }
      }
      const { error: pErr } = await admin
        .from("profiles")
        .update({
          ...patchWithoutMediaConsent,
          ...mediaConsentPatch,
          updated_at: approvedAt!,
        })
        .eq("user_id", waiver.user_id);
      if (pErr) throw new Error(pErr.message);

      // Provision access on FIRST approval: an applicant's auth user is banned
      // (no login). Lift the ban and tell them their account is open. Skipped
      // for people who can already log in, so re-approvals don't spam them.
      // Best-effort — a hiccup must not undo the approval. A failed UNBAN is
      // retried by re-approving (they are still locked, so this block runs
      // again); a failed SEND is not, since the unban above already went
      // through. That person has an account and has not been told, and the
      // fix is a word out of band: nothing in the email was single-use, so
      // they can sign in at /auth whenever they hear.
      //
      // The email deliberately carries no sign-in link: it names the address
      // their login is keyed on and sends them to /auth to ask for a link
      // themselves. A magic link nobody requested expires in an hour, so it is
      // usually dead by the time it is read, and this email needs to stay good
      // for as long as it takes a new member to get round to it.
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
            const { sendAccountActivatedEmail } = await import("./waiver-email.server");
            await sendAccountActivatedEmail({
              waiverId: waiver.id,
              memberGreetingName: greetingName(waiver),
              memberEmail: authEmail,
            });
          }
        }
      } catch (e) {
        console.error("[setWaiverApproval] access provisioning failed:", e);
      }

      // Approved = visitor = trial assigned: give them the free trial on
      // first approval (one per person, ever; skipped for later approvals).
      // Best-effort like provisioning — re-approving retries it.
      //
      // Dated from the waiver's OWN signing time, not from this approval, so
      // the row records when the entitlement was really earned: a form filled
      // in at the gym may not be approved until hours or days later. Nothing
      // reads that date as a limit — a credit balance is not date-gated at
      // check-in (src/lib/checkin.ts `isOpenBalance`) — so approving late
      // cannot cost anyone a session either way.
      try {
        const { assignTrialMembership } = await import("./membership.functions");
        await assignTrialMembership(waiver.user_id, waiver.signed_at);
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
