// Shared validation schemas and pure helpers for form submissions.
//
// These live here (rather than inline in the *.functions.ts server modules) so
// they can be unit-tested directly and reused by both client and server without
// pulling in server-only imports. Keep this file free of side effects and of any
// server-only dependency (no supabase clients, no process.env reads).
import { z } from "zod";
// Domain constants for the knowledge base. `kb.ts` is the same kind of
// module as this one (pure, no server imports), and owns the vocabulary its
// permission rules are written in; importing it here keeps the wire schema and
// those rules from drifting into two different lists of visibilities.
import { annotationVisibilities, articleVisibilities } from "./kb";

// ---- Pure helpers ----

/** Join first/middle/last into a single display name, trimming and dropping blanks. */
export function composeFullName(first: string, middle: string, last: string): string {
  return [first, middle, last]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

/** Compose a display name from a profile's (nullable) name parts. */
export function profileFullName(p: {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
}): string {
  return composeFullName(p.first_name || "", p.middle_name || "", p.last_name || "");
}

/** The name parts every person-name helper below reads. All optional/nullable
 * because a profile may hold only some of them. */
export type PersonNameParts = {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
};

/**
 * The name to address someone BY: the preferred name they gave, else their
 * first name, else whatever full name we have. Use this wherever the club
 * speaks TO a person (email greetings, "Hi ..."), never where it identifies
 * them to a manager or on a document — those keep the legal name.
 */
export function greetingName(p: PersonNameParts): string {
  const preferred = (p.preferred_name || "").trim();
  if (preferred) return preferred;
  const first = (p.first_name || "").trim();
  if (first) return first;
  return profileFullName(p);
}

/**
 * A person's name for manager-facing lists: the legal full name with the
 * preferred name quoted in the conventional nickname position, e.g.
 * `Ada "Addy" Lovelace`. A preferred name that just repeats the first name
 * adds nothing, so it is left off.
 */
export function nameWithPreferred(p: PersonNameParts): string {
  const preferred = (p.preferred_name || "").trim();
  const first = (p.first_name || "").trim();
  if (!preferred || preferred.toLowerCase() === first.toLowerCase()) return profileFullName(p);
  const lead = first ? `${first} "${preferred}"` : `"${preferred}"`;
  return composeFullName(lead, p.middle_name || "", p.last_name || "");
}

/**
 * Normalize an email for use as the profile identity key: trimmed and lowercased
 * so case/whitespace variants map to the one profile (mirrors the DB unique key).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The name shown on a public/member-facing comment (blog comments, and
 * document annotations' shared comments): the person's own override
 * (`profiles.display_name`) if they set one, else derived as "first/preferred
 * name + last initial" (e.g. "Jane L."). Never the full legal name pulled from
 * waiver/profile data onto a comment that other members — or, for a public
 * document, anyone — can read.
 */
export function commentDisplayName(p: PersonNameParts & { display_name?: string | null }): string {
  const override = (p.display_name || "").trim();
  if (override) return override;
  const base = (p.preferred_name || "").trim() || (p.first_name || "").trim();
  const lastInitial = (p.last_name || "").trim().charAt(0).toUpperCase();
  if (base && lastInitial) return `${base} ${lastInitial}.`;
  if (base) return base;
  return "Member";
}

// ---- Health declaration (the application form's five safety questions) ----

/**
 * The five health questions, each answered yes or no. Every one is required:
 * an unanswered question is not a "no", and instructors read these before
 * anybody trains. The question prose lives in `waiver-health.ts` (shared by the
 * form and the signed document); only the shape is pinned here.
 *
 * The answers are not stored in a column. They are printed into the signed PDF,
 * which is the record, exactly like the acknowledgement ticks. Anything the
 * signer needs to explain goes in `medical_notes`, which the refine below makes
 * required as soon as any answer is yes.
 */
export const healthAnswersSchema = z.object({
  drugs: z.boolean(),
  blackouts: z.boolean(),
  device: z.boolean(),
  impairments: z.boolean(),
  other: z.boolean(),
});
export type HealthAnswers = z.infer<typeof healthAnswersSchema>;
export type HealthQuestionId = keyof HealthAnswers;

/** The question ids, in the order they appear on the form. */
export const healthQuestionIds = Object.keys(healthAnswersSchema.shape) as HealthQuestionId[];

/** The person fields a waiver submission carries (as submitted, frozen). */
export type WaiverPersonFields = {
  first_name: string;
  middle_name: string | null;
  last_name: string;
  /** What the person wants to be called, when it differs from their legal name. */
  preferred_name: string | null;
  date_of_birth: string;
  address: string;
  phone: string;
  uts_student_number: string | null;
  sms_whatsapp_consent: boolean;
  emergency_contact_name: string;
  /** How the emergency contact is related. For a minor this IS the guardian. */
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string;
  medical_notes: string | null;
  is_minor: boolean;
  guardian_name: string | null;
  guardian_relationship: string | null;
};

/**
 * The profile patch a manager's approval applies: the approved submission's
 * person fields become the club's current record of that person. Pure so the
 * promotion mapping is unit-testable; the caller adds `updated_at`.
 */
export function waiverToProfileFields(w: WaiverPersonFields): WaiverPersonFields {
  return {
    first_name: w.first_name,
    middle_name: w.middle_name,
    last_name: w.last_name,
    preferred_name: w.preferred_name,
    date_of_birth: w.date_of_birth,
    address: w.address,
    phone: w.phone,
    uts_student_number: w.uts_student_number,
    sms_whatsapp_consent: w.sms_whatsapp_consent,
    emergency_contact_name: w.emergency_contact_name,
    emergency_contact_relationship: w.emergency_contact_relationship,
    emergency_contact_phone: w.emergency_contact_phone,
    medical_notes: w.medical_notes,
    is_minor: w.is_minor,
    guardian_name: w.guardian_name,
    guardian_relationship: w.guardian_relationship,
  };
}

// ---- Signing-context evidence (kept on the waiver for liability) ----

/** Self-reported browser context sent with a waiver submission. All optional and
 * size-bounded; it is evidence, not identity, so nothing here is trusted. */
export const waiverClientMetaSchema = z.object({
  timezone: z.string().trim().max(80).optional().or(z.literal("")),
  screen: z.string().trim().max(40).optional().or(z.literal("")),
  viewport: z.string().trim().max(40).optional().or(z.literal("")),
  platform: z.string().trim().max(80).optional().or(z.literal("")),
  languages: z.array(z.string().trim().max(35)).max(10).optional(),
});
export type WaiverClientMeta = z.infer<typeof waiverClientMetaSchema>;

/**
 * The signer_meta evidence blob. Every value is a string or a list of strings,
 * which keeps it assignable to the `jsonb` column's generated `Json` type
 * without a cast.
 */
export type SignerMeta = Record<string, string | string[]>;

/**
 * Assemble the signer_meta evidence blob stored on a waiver: request headers
 * captured server-side (user agent, language, client hints) merged with the
 * browser's self-reported context. Pure — takes a header getter so it is
 * unit-testable; empty values are dropped so the blob stays compact.
 */
export function buildSignerMeta(
  getHeader: (name: string) => string | undefined,
  client: WaiverClientMeta | undefined,
): SignerMeta {
  const meta: SignerMeta = {};
  const header = (key: string, name: string) => {
    const value = getHeader(name)?.trim();
    if (value) meta[key] = value.slice(0, 400);
  };
  header("user_agent", "user-agent");
  header("accept_language", "accept-language");
  header("sec_ch_ua", "sec-ch-ua");
  header("sec_ch_ua_platform", "sec-ch-ua-platform");
  header("sec_ch_ua_mobile", "sec-ch-ua-mobile");
  if (client) {
    if (client.timezone) meta.timezone = client.timezone;
    if (client.screen) meta.screen = client.screen;
    if (client.viewport) meta.viewport = client.viewport;
    if (client.platform) meta.platform = client.platform;
    if (client.languages?.length) meta.languages = client.languages;
  }
  return meta;
}

/** The states a waiver submission can be shown in. Stored: pending/approved; the
 * approved set is split into the person's single ACTIVE waiver (latest approved)
 * and SUPERSEDED older ones. */
export const waiverListStatuses = ["pending", "active", "superseded"] as const;
export type WaiverListStatus = (typeof waiverListStatuses)[number];

/**
 * Derive each waiver's displayed status. Per person, the approved waiver with
 * the greatest approved_at (falling back to signed_at) is `active`; other
 * approved ones are `superseded`; everything else is `pending`.
 */
export function deriveWaiverListStatuses(
  rows: {
    id: string;
    user_id: string;
    approval_status: string;
    approved_at: string | null;
    signed_at: string;
  }[],
): Map<string, WaiverListStatus> {
  const activeByUser = new Map<string, { id: string; at: string }>();
  for (const r of rows) {
    if (r.approval_status !== "approved") continue;
    const at = r.approved_at ?? r.signed_at;
    const current = activeByUser.get(r.user_id);
    if (!current || current.at < at) activeByUser.set(r.user_id, { id: r.id, at });
  }
  const out = new Map<string, WaiverListStatus>();
  for (const r of rows) {
    if (r.approval_status !== "approved") out.set(r.id, "pending");
    else out.set(r.id, activeByUser.get(r.user_id)?.id === r.id ? "active" : "superseded");
  }
  return out;
}

/**
 * Which waiver panels start expanded on a person's manager page.
 *
 * A manager opens that page to deal with what is waiting on them, so only the
 * newest submission expands, and only while it is still pending. Everything
 * else stays collapsed: older submissions are history, and an approved waiver
 * (active or superseded) has already been dealt with. Managers can still open
 * any panel by hand.
 */
export function deriveExpandedWaivers(
  rows: { id: string; signed_at: string; status: WaiverListStatus }[],
): Set<string> {
  let newest: { id: string; signed_at: string; status: WaiverListStatus } | null = null;
  for (const row of rows) {
    if (!newest || newest.signed_at < row.signed_at) newest = row;
  }
  return new Set(newest && newest.status === "pending" ? [newest.id] : []);
}

/**
 * Split a single full-name string into first/middle/last parts.
 * One word → first only; two words → first + last; three+ → everything
 * between the first and last word becomes the middle name.
 */
export function splitFullName(full: string): { first: string; middle: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", middle: "", last: "" };
  if (parts.length === 1) return { first: parts[0], middle: "", last: "" };
  if (parts.length === 2) return { first: parts[0], middle: "", last: parts[1] };
  return { first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1] };
}

/**
 * Resolve the waiver form's name prefill from optional search params.
 * Prefers explicit first/last (the register "free trial" flow); falls back to
 * splitting a single `name` string for legacy links (older bookmarks / emails).
 */
export function resolveNamePrefill(search: {
  first_name?: string;
  last_name?: string;
  name?: string;
}): { first: string; middle: string; last: string } {
  const first = (search.first_name ?? "").trim();
  const last = (search.last_name ?? "").trim();
  if (first || last) return { first, middle: "", last };
  return splitFullName(search.name ?? "");
}

/**
 * Decode a `data:image/png;base64,...` URL into raw PNG bytes.
 * Returns null for empty input or anything that isn't a base64 PNG data URL.
 */
export function decodeDataUrlPng(dataUrl: string): Uint8Array | null {
  if (!dataUrl) return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const binary = atob(m[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ---- Submission identity (idempotency) ----

/**
 * A uuid the browser mints once per form fill and sends on every attempt.
 *
 * It exists so a retry can be recognised as the SAME submission. Aborting a
 * request client-side does not stop the server, so without this an automatic
 * retry after a timeout can leave a duplicate lead, or a duplicate signed
 * waiver plus a second round of emails. Each table carries it behind a partial
 * unique index (20260729020000_submission_idempotency.sql).
 *
 * Optional on purpose: a client cached from before this shipped sends nothing
 * and still submits successfully, it simply gets no dedupe protection. The
 * empty-string branch mirrors the other optional fields here, which is what the
 * forms send for "not set".
 */
export const clientSubmissionId = z.string().uuid().optional().or(z.literal(""));

// ---- Interest registration ----

export const interestSchema = z.object({
  client_submission_id: clientSubmissionId,
  // The register form composes this from first + last name fields (each capped
  // at 60, matching the waiver), so allow up to 60 + " " + 60 = 121 characters.
  name: z.string().trim().min(1).max(121),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  experience: z.string().trim().max(500).optional().or(z.literal("")),
  message: z.string().trim().max(1000).optional().or(z.literal("")),
  hp: z.string().max(0).optional(), // honeypot — must stay empty
});

// ---- Contact message ----

export const contactSchema = z.object({
  client_submission_id: clientSubmissionId,
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  subject: z.string().trim().max(150).optional().or(z.literal("")),
  message: z.string().trim().min(1).max(2000),
  hp: z.string().max(0).optional(), // honeypot
});

// ---- Waiver submission (name-split + signature + minor guardian) ----

const sigImage = z.string().max(500_000).optional().or(z.literal(""));

export const waiverSubmitSchema = z
  .object({
    client_submission_id: clientSubmissionId,
    first_name: z.string().trim().min(1).max(60),
    middle_name: z.string().trim().max(60).optional().or(z.literal("")),
    last_name: z.string().trim().min(1).max(60),
    // Optional: what the person goes by, when that isn't their first name.
    // Purely for how the club addresses them; the legal name still signs.
    preferred_name: z.string().trim().max(60).optional().or(z.literal("")),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    address: z.string().trim().min(1).max(300),
    phone: z.string().trim().min(1).max(30),
    email: z.string().trim().email().max(255),
    // Optional UTS student number. Non-empty means the person is a UTS student
    // (there is no separate "is a student" flag); it unlocks the student rate.
    uts_student_number: z.string().trim().max(20).optional().or(z.literal("")),
    // Consent to be contacted by SMS/WhatsApp and added to club WhatsApp groups.
    // Optional (not required to submit); defaults to no consent.
    sms_whatsapp_consent: z.boolean().optional().default(false),
    // The emergency contact. For a participant under 18 this person IS the
    // parent/guardian who signs, which is why the relationship is required for
    // everyone and reused as the "relationship to minor" on the document.
    emergency_contact_name: z.string().trim().min(1).max(120),
    emergency_contact_relationship: z.string().trim().min(1).max(80),
    emergency_contact_phone: z.string().trim().min(1).max(30),
    // All five health questions, each answered yes or no.
    health_answers: healthAnswersSchema,
    // The one details box the form has always had. Required once any health
    // answer is yes (see the refine below); otherwise optional.
    medical_notes: z.string().trim().max(2000).optional().or(z.literal("")),
    // Map of acknowledgement id -> accepted. Which ids are *required* is defined
    // on the template, so that check lives in `missingRequiredAcks`, not here.
    acknowledgements: z.record(z.string(), z.boolean()).default({}),
    signature_name: z.string().trim().max(120).optional().or(z.literal("")),
    signature_image: sigImage,
    is_minor: z.boolean().optional().default(false),
    // No guardian name/relationship here: for a minor they are the emergency
    // contact fields above, so the server derives them rather than accepting a
    // second copy that could disagree with the first.
    guardian_signature: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_signature_image: sigImage,
    // Self-reported browser context, stored on the waiver as signing evidence.
    client_meta: waiverClientMetaSchema.optional(),
    // Which template version the signer actually READ, sent back so the server
    // can refuse to file a signature against different text.
    //
    // A manager can promote a new version while someone has the form open; the
    // page holds its template for the life of the tab. Without this the server
    // would file the submission against whatever is live at that moment, and the
    // signed PDF would carry a document the signer never saw. Optional so a
    // client that predates this still submits.
    template_version: z.number().int().positive().optional(),
    // Proof-of-click token from the interest confirmation email, carried through
    // from the prefill link. When it matches the address being submitted, the
    // person record is created already verified. Never required, and never
    // trusted for anything beyond that: it is re-checked server-side.
    vt: z.string().trim().max(120).optional().or(z.literal("")),
    hp: z.string().max(0).optional(),
  })
  .refine(
    (d) =>
      Boolean(
        (d.signature_name && d.signature_name.trim()) ||
        (d.signature_image && d.signature_image.trim()),
      ),
    { message: "A signature is required. Draw or type your name.", path: ["signature_name"] },
  )
  .refine(
    (d) =>
      !d.is_minor ||
      Boolean(
        (d.guardian_signature && d.guardian_signature.trim()) ||
        (d.guardian_signature_image && d.guardian_signature_image.trim()),
      ),
    {
      message: "A parent or guardian must sign for participants under 18.",
      path: ["guardian_signature"],
    },
  )
  // A "yes" nobody explained tells an instructor nothing, so the details box
  // stops being optional the moment any health question is answered yes.
  .refine(
    (d) =>
      !Object.values(d.health_answers).some(Boolean) ||
      Boolean(d.medical_notes && d.medical_notes.trim()),
    {
      message: "Please give details of anything you answered yes to.",
      path: ["medical_notes"],
    },
  );

export type WaiverSubmitInput = z.infer<typeof waiverSubmitSchema>;

// ---- Waiver prefill (Step 1 -> /waiver, carried on the URL query) ----
//
// Optional prefill values passed to the waiver page from Step 1 of the "Start
// your free trial" flow (e.g. /waiver?first_name=...&email=...&phone=61313131).
// The register step sends first_name/last_name; `name` is kept for legacy links
// (older bookmarks or emails that carried a single combined name) and resolved
// via resolveNamePrefill.
//
// TanStack Router parses search params through JSON, so an all-digits value
// like ?phone=61313131 arrives as a NUMBER, not a string — a plain z.string()
// would reject it and the field would silently fail to prefill. z.coerce.string()
// turns such values back into strings; .catch(undefined) keeps a malformed
// value from breaking the whole route. Length caps mirror the form fields.
export const waiverPrefillSearchSchema = z.object({
  first_name: z.coerce.string().max(60).optional().catch(undefined),
  last_name: z.coerce.string().max(60).optional().catch(undefined),
  name: z.coerce.string().max(120).optional().catch(undefined),
  email: z.coerce.string().max(255).optional().catch(undefined),
  phone: z.coerce.string().max(30).optional().catch(undefined),
  // Email-verification token, present only on links that arrived by email.
  vt: z.coerce.string().max(120).optional().catch(undefined),
});
export type WaiverPrefillSearch = z.infer<typeof waiverPrefillSearchSchema>;

// ---- Acknowledgements (defined on the template, edited by managers) ----

export const acknowledgementDefSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(500),
  required: z.boolean(),
});
export type AcknowledgementDef = z.infer<typeof acknowledgementDefSchema>;

export const templateAcknowledgementsSchema = z.array(acknowledgementDefSchema).max(20);

// ---- Manager: save waiver template ----

export const saveTemplateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body_md: z.string().trim().min(1).max(30000),
  acknowledgements: templateAcknowledgementsSchema.default([]),
});

// ---- Manager: promote an existing template version to the live one ----
//
// Saving from the editor always writes a NEW version. Promoting is the other
// half: it makes an existing row the one `/waiver` serves, which is how a
// template that arrived any other way (a migration seeding a draft, say) goes
// live without being retyped into the editor first.
export const setCurrentTemplateSchema = z.object({
  id: z.string().uuid(),
});
export type SetCurrentTemplateInput = z.infer<typeof setCurrentTemplateSchema>;

// ---- Manager: approve / unapprove a signed waiver ----

/** The member-facing status a manager can set on a signed waiver. */
export const waiverApprovalStatuses = ["pending", "approved"] as const;
export type WaiverApprovalStatus = (typeof waiverApprovalStatuses)[number];

export const waiverApprovalSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(waiverApprovalStatuses),
});
export type WaiverApprovalInput = z.infer<typeof waiverApprovalSchema>;

// ---- Code of conduct ----
//
// Deliberately small next to `waiverSubmitSchema`. The signer is a person the
// club already has on file, so nothing about them is retyped here: the name and
// email stored on the acceptance are copied server-side from their profile and
// login. What the form actually collects is agreement and a signature.
//
// `token` is the proof-of-click token from the "sign it later" email. Someone
// who just signed a waiver is a locked applicant and cannot log in yet, so
// without it there would be no way to sign at all until a manager approved them.
// It is optional because a signed-in member needs no token, and it is never
// trusted client-side: the server resolves it and refuses anything expired,
// revoked, or minted for an address the account no longer has.
export const codeOfConductAcceptSchema = z.object({
  token: z.string().trim().max(120).optional().or(z.literal("")),
  // Must be ticked. A code of conduct signed by someone who did not agree to it
  // is not evidence of anything, so this is `z.literal(true)` rather than a
  // boolean the server has to remember to check.
  agree: z.literal(true),
  signature_name: z.string().trim().min(1).max(120),
  // Which version they actually read. The server refuses a version it does not
  // recognise rather than filing an agreement against unknown text, the same
  // rule the waiver applies to its template version.
  version: z.number().int().positive(),
  client_meta: waiverClientMetaSchema.optional(),
  hp: z.string().max(0).optional(), // honeypot
});
export type CodeOfConductAcceptInput = z.infer<typeof codeOfConductAcceptSchema>;

/** Optional `?t=` token on a code-of-conduct link that arrived by email. */
export const codeOfConductSearchSchema = z.object({
  t: z.coerce.string().max(120).optional().catch(undefined),
});
export type CodeOfConductSearch = z.infer<typeof codeOfConductSearchSchema>;

// ---- Manager: upload a scanned paper waiver ----
//
// Some people fill the form on paper at the door. A manager scans it and files
// it here, so the club has one place where every waiver lives. The scan IS the
// signed document: signatures, ticked acknowledgements and the five health
// answers are on the paper, exactly as they are inside a generated PDF for an
// online submission (docs/waivers.md rule 3), so none of them are re-typed.
//
// What the manager does type is what the club needs as data rather than as
// evidence: the person fields (which an approval promotes onto the profile) and
// anything an instructor needs to hand. The required set is exactly the
// `waivers` table's NOT NULL columns, so nothing here can produce a row the
// online form could not.

/**
 * The `signer_meta.source` marking a waiver as a scanned paper form filed by a
 * manager rather than signed on the site.
 *
 * It lives in the signing-context blob because that is what it is: evidence of
 * how this submission reached the club. An online waiver's blob holds the
 * browser and IP that signed it; a paper one holds who filed it, when, and from
 * which files. Nothing else about the row differs, which is the point — a paper
 * waiver is approved, superseded and downloaded exactly like any other.
 */
export const PAPER_WAIVER_SOURCE = "paper_upload";

/** Whether a waiver's signing context says it was a scanned paper form. */
export function isPaperWaiver(signerMeta: unknown): boolean {
  return Boolean(
    signerMeta &&
    typeof signerMeta === "object" &&
    !Array.isArray(signerMeta) &&
    (signerMeta as Record<string, unknown>).source === PAPER_WAIVER_SOURCE,
  );
}

/** The file types a scanned waiver can arrive as. */
export const scanMimeTypes = ["application/pdf", "image/png", "image/jpeg"] as const;
export type ScanMimeType = (typeof scanMimeTypes)[number];

/** How much scan a single upload may carry, decoded. Roughly 20 phone photos. */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;

/**
 * Decoded byte length of a base64 string, without decoding it.
 *
 * The scan arrives as base64 in the request body, which inflates it by a third,
 * so the size limit has to be checked against the real byte count. Doing that
 * by decoding first would mean holding the decoded copy just to reject it.
 */
export function base64ByteLength(b64: string): number {
  const clean = b64.replace(/\s+/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** One scanned file: a whole PDF or a single photographed/scanned page. */
export const scanFileSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(scanMimeTypes),
  /** Raw base64, no `data:` prefix. */
  data: z.string().min(1),
});
export type ScanFile = z.infer<typeof scanFileSchema>;

/**
 * Whether someone born on `dateOfBirth` was under 18 on `onDate`.
 *
 * Derived rather than asked: the paper form records a birth date, and "is this
 * a minor" is a fact about that date, not a separate answer a manager could
 * mistype. Both arguments are plain `YYYY-MM-DD` dates with no timezone, so
 * they are compared as parts (`new Date` would read them as UTC midnight and
 * shift the answer by a day for anyone west of Greenwich).
 */
export function isMinorOn(dateOfBirth: string, onDate: string): boolean {
  const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  const on = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onDate);
  if (!dob || !on) return false;
  const [, by, bm, bd] = dob.map(Number);
  const [, oy, om, od] = on.map(Number);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age--;
  return age < 18;
}

export const paperWaiverUploadSchema = z
  .object({
    // Person fields, mirroring the online form's rules so a paper record and an
    // online one are the same shape.
    first_name: z.string().trim().min(1).max(60),
    middle_name: z.string().trim().max(60).optional().or(z.literal("")),
    last_name: z.string().trim().min(1).max(60),
    preferred_name: z.string().trim().max(60).optional().or(z.literal("")),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    address: z.string().trim().min(1).max(300),
    phone: z.string().trim().min(1).max(30),
    email: z.string().trim().email().max(255),
    uts_student_number: z.string().trim().max(20).optional().or(z.literal("")),
    sms_whatsapp_consent: z.boolean().optional().default(false),
    emergency_contact_name: z.string().trim().min(1).max(120),
    // Optional here, unlike the online form: older paper forms did not ask for
    // it, and a manager must not have to invent one to file a real document.
    // Required for a minor, where it is the relationship to the participant on
    // the signed page (see the refine below).
    emergency_contact_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    emergency_contact_phone: z.string().trim().min(1).max(30),
    medical_notes: z.string().trim().max(2000).optional().or(z.literal("")),
    // The date written on the paper, not the date it was filed. This is the
    // club's record of when they signed, and what the lists order by. It does
    // NOT decide which waiver is active: that is the most recently APPROVED one
    // (deriveWaiverListStatuses), so approving a backlog of old forms makes the
    // last one approved active regardless of its date.
    signed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Which version of the form the paper is, when the manager can tell. Null
    // is honest for an undated legacy form and is what the screens already
    // render as "—".
    template_version: z.number().int().positive().nullable().optional(),
    // The scan itself: one PDF, a stack of photos, or any mix, merged in order
    // into the single PDF this waiver's record points at.
    scan: z.array(scanFileSchema).min(1).max(20),
    // Not part of the waiver: the caller saying "I know this person already has
    // a waiver signed on this date, file it anyway". Filing the same paperwork
    // twice is the realistic accident in a bulk import (a retried batch, a
    // manager unsure the upload went through), and a pile of identical pending
    // waivers is a pile of chances to approve the wrong one. Refiling IS
    // legitimate for a corrected re-scan, so this warns and confirms rather
    // than blocking — see filePaperWaiver / waiver-duplicates.ts.
    confirm_duplicate: z.boolean().optional().default(false),
    // The caller's own id for this filing attempt, minted once per form/record
    // and resent on every retry. The duplicate check above is a check-then-
    // insert and cannot see an attempt that has not committed yet, so two
    // in-flight retries of one import would both pass it. This is what actually
    // makes a retry safe: `waivers.client_submission_id` carries a partial
    // unique index (20260729020000), so the database refuses the second write
    // and the loser adopts the winner's row. Same mechanism the online signing
    // path uses. Optional: a caller that sends none just gets no retry safety.
    client_submission_id: z.string().uuid().optional(),
  })
  // Strict, matching editInvoiceSchema. Without it Zod silently STRIPS an
  // unknown key, so `confirmDuplicate` or `confirm_duplicates` would vanish,
  // default to false, and return the same 409 again — telling the caller to do
  // the very thing they believe they just did, with nothing in the response
  // saying the flag never arrived. An agent guessing a parameter name from
  // prose is exactly who this endpoint serves, and an escape hatch that fails
  // silently is not an escape hatch. Unknown keys are a loud 400 instead.
  .strict()
  .refine(
    (d) =>
      !isMinorOn(d.date_of_birth, d.signed_on) || Boolean(d.emergency_contact_relationship?.trim()),
    {
      message:
        "The participant was under 18 when this was signed, so the guardian's relationship to them is required.",
      path: ["emergency_contact_relationship"],
    },
  )
  .refine((d) => d.scan.reduce((sum, f) => sum + base64ByteLength(f.data), 0) <= MAX_SCAN_BYTES, {
    message: "The scan is too large. Keep the whole upload under 10 MB.",
    path: ["scan"],
  });

export type PaperWaiverUploadInput = z.infer<typeof paperWaiverUploadSchema>;

/**
 * The `YYYY-MM-DD` after this one, as the exclusive upper bound of a one-day
 * range. Used by the duplicate probe, which has to match every waiver signed on
 * a date rather than only the midnight-UTC instant a paper filing writes.
 *
 * Parsed as UTC midnight explicitly (`T00:00:00Z`) so the arithmetic cannot pick
 * up the server's own timezone: the whole point is a UTC day boundary, and a
 * bare `new Date("2026-07-01")` is already UTC while `new Date(2026, 6, 1)` is
 * not — a difference too easy to introduce later by accident.
 */
export function nextUtcDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a signing date is in the future, and so cannot be what the paper says.
 *
 * A day of slack, deliberately: the club is in Sydney (UTC+10/+11) and the
 * server clock is UTC, so for most of a Sydney morning "today" is still
 * tomorrow's date in UTC. Rejecting on a strict comparison would refuse forms
 * dated the day they were signed. A day out is a typo nobody needs blocked;
 * a form dated next month is the mistake worth catching.
 */
export function isFutureSigningDate(signedOn: string, nowIso: string): boolean {
  const limit = new Date(nowIso);
  if (Number.isNaN(limit.getTime())) return false;
  limit.setUTCDate(limit.getUTCDate() + 1);
  return signedOn > limit.toISOString().slice(0, 10);
}

// ---- Manager: correct a person's email address ----
//
// The only email-editing path in the product. There is no self-serve version:
// the address IS the identity (one address, one person, one profile), so moving
// it moves the login as well as the record.
//
// Note what is NOT here: any way to assert that an address is verified. A badge
// a manager could set would only mean "a manager believed this", which is the
// state the club is already in. Correcting an address sends a fresh link; that
// is the whole remedy.
export const managerEmailChangeSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().trim().email().max(255),
});
export type ManagerEmailChangeInput = z.infer<typeof managerEmailChangeSchema>;

// ---- Memberships ----

/** The kinds of plan the club sells. */
export const membershipPlanKinds = ["insurance", "trial", "session", "period"] as const;
export type MembershipPlanKind = (typeof membershipPlanKinds)[number];

/** The lifecycle a person moves through as they join the club:
 * lead (registered interest only) -> applicant (signed the waiver) ->
 * visitor (waiver approved, trial assigned) -> member (active paid
 * membership), plus lapsed (had a trial/membership that ended, nothing
 * active). Always derived, never stored. */
export const lifecycleStatuses = ["lead", "applicant", "visitor", "member", "lapsed"] as const;
export type LifecycleStatus = (typeof lifecycleStatuses)[number];

/** The states an enrollment record can be in. */
export const membershipStatuses = ["pending", "active", "expired", "cancelled"] as const;
export type MembershipStatus = (typeof membershipStatuses)[number];

type PlanPricing = { public_price_cents: number; student_price_cents: number | null };

/**
 * The price (in cents) for a plan given whether the student rate applies. Falls
 * back to the public price when the plan has no student rate (e.g. insurance,
 * trial), so a UTS student picking such a plan is never under-charged.
 */
export function computeMembershipPrice(plan: PlanPricing, isStudent: boolean): number {
  if (isStudent && plan.student_price_cents != null) return plan.student_price_cents;
  return plan.public_price_cents;
}

/**
 * Student status is trust-based on the UTS student number: a non-empty number
 * (after trimming) means the person is a UTS student and unlocks the student
 * rate. There is no separate boolean flag. Shared by the membership page (live
 * price preview) and the server (authoritative pricing) so the two can never
 * disagree, and it matches the `memberships` DB CHECK constraint.
 */
export function isUtsStudent(utsStudentNumber: string | null | undefined): boolean {
  return Boolean(utsStudentNumber && utsStudentNumber.trim());
}

/** Format integer cents as AUD for display: 24500 -> "$245", 2050 -> "$20.50", 0 -> "Free". */
export function formatCents(cents: number): string {
  if (cents === 0) return "Free";
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * Derive a person's lifecycle status from their waivers + membership records.
 * Precedence:
 *   1. member  — any ACTIVE paid membership (kind != trial, price > 0).
 *   2. lapsed  — a trial or paid membership ended (expired/cancelled) and
 *                nothing is active: someone to chase for a renewal.
 *   3. visitor — an approved waiver (the free trial is assigned at approval).
 *   4. applicant — waiver submission(s), none approved yet.
 *   5. lead    — nothing beyond a registration (or a bare profile).
 */
export function deriveLifecycleStatus(input: {
  hasApprovedWaiver: boolean;
  hasPendingWaiver: boolean;
  memberships: { status: MembershipStatus; kind: MembershipPlanKind; price_cents: number }[];
}): LifecycleStatus {
  const isPaid = (m: { kind: MembershipPlanKind; price_cents: number }) =>
    m.kind !== "trial" && m.price_cents > 0;
  const isEnded = (m: { status: MembershipStatus }) =>
    m.status === "expired" || m.status === "cancelled";
  const active = input.memberships.filter((m) => m.status === "active");
  if (active.some(isPaid)) return "member";
  if (active.length === 0 && input.memberships.some(isEnded)) return "lapsed";
  if (input.hasApprovedWaiver) return "visitor";
  if (input.hasPendingWaiver) return "applicant";
  return "lead";
}

/** Uppercase + strip everything that isn't a letter or digit (for bank matching). */
export function normalizeRef(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * True when a bank-statement line pays a given membership: its description must
 * contain the membership's payment reference AND the amount must match. Both
 * sides are normalized (uppercase, non-alphanumerics stripped) so the match is
 * insensitive to how the member's bank formats the reference (hyphens, spaces).
 */
export function matchesMembershipReference(
  description: string,
  reference: string,
  amountCents: number,
  priceCents: number,
): boolean {
  const ref = normalizeRef(reference);
  if (!ref) return false;
  return normalizeRef(description).includes(ref) && amountCents === priceCents;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * Family name reduced to bank-safe uppercase letters: accents folded, non-letters
 * removed, truncated, falling back to "MEMBER" when nothing usable remains.
 */
export function sanitizeSurname(name: string): string {
  const cleaned = (name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return (cleaned || "MEMBER").slice(0, 8);
}

/**
 * A short, stable, deterministic code for a member (FNV-1a hash of their user id
 * in Crockford base32, no ambiguous I/L/O/U). Same user id -> same code forever,
 * so it distinguishes members who share a surname without ever changing.
 */
export function stableCode(userId: string): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 3; i++) {
    out += ALPHABET[h & 31];
    h >>>= 5;
  }
  return out;
}

/** Format a YYYY-MM-DD date as a compact tag like "7DEC" (no leading zero). */
export function sessionDateTag(sessionDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sessionDate.trim());
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1] ?? "";
  return `${Number(m[3])}${month}`;
}

/**
 * Build a member's bank transfer reference: compact, uppercase, alphanumeric,
 * <= 18 chars (the Australian pay-anyone limit). Stable per member.
 *   - period / insurance / trial: `MEM<SURNAME><CODE>`         e.g. MEMNGUYEN7Q
 *   - per-session (sessionDate set): `<SURNAME><CODE><Day><Mon>` e.g. NGUYEN7Q7DEC
 *     (no MEM prefix — the session date already identifies the payment).
 */
export function buildPaymentReference(
  surname: string,
  userId: string,
  sessionDate?: string,
): string {
  const code = stableCode(userId);
  const datePart = sessionDate ? sessionDateTag(sessionDate) : "";
  const prefix = sessionDate ? "" : "MEM";
  const assemble = (sur: string) => `${prefix}${sur}${code}${datePart}`;
  let sur = sanitizeSurname(surname);
  let ref = assemble(sur);
  if (ref.length > 18) {
    // Trim the surname (the only variable-length part) to fit the 18-char cap.
    const over = ref.length - 18;
    sur = sur.slice(0, Math.max(1, sur.length - over));
    ref = assemble(sur);
  }
  return ref.slice(0, 18);
}

// ---- Member: start a membership ----

export const startMembershipSchema = z
  .object({
    plan_code: z.string().trim().min(1).max(64),
    is_student: z.boolean(),
    uts_student_number: z.string().trim().max(20).optional().or(z.literal("")),
    // Only meaningful for the per-session plan; the server ignores it otherwise.
    session_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .or(z.literal("")),
    hp: z.string().max(0).optional(), // honeypot — must stay empty
  })
  .refine((d) => !d.is_student || Boolean(d.uts_student_number && d.uts_student_number.trim()), {
    message: "A UTS student number is required to take the student rate.",
    path: ["uts_student_number"],
  });
export type StartMembershipInput = z.infer<typeof startMembershipSchema>;

// ---- Manager: create / edit a plan ----

export const savePlanSchema = z.object({
  id: z.string().uuid().optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores only."),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  kind: z.enum(membershipPlanKinds),
  public_price_cents: z.number().int().min(0).max(1_000_000),
  student_price_cents: z.number().int().min(0).max(1_000_000).nullable(),
  duration_days: z.number().int().positive().max(3650).nullable(),
  session_credits: z.number().int().positive().max(1000).nullable(),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(1000),
});
export type SavePlanInput = z.infer<typeof savePlanSchema>;

// ---- Manager: set a membership's status ----

export const setMembershipStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(membershipStatuses),
});
export type SetMembershipStatusInput = z.infer<typeof setMembershipStatusSchema>;

// ---- Manager: import a bank statement ----

export const bankTxnRowSchema = z.object({
  posted_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
  amount_cents: z.number().int(),
  description: z.string().max(1000).default(""),
  reference: z.string().max(200).optional().or(z.literal("")),
});
export type BankTxnRow = z.infer<typeof bankTxnRowSchema>;

export const importBankStatementSchema = z.object({
  rows: z.array(bankTxnRowSchema).min(1).max(2000),
});
export type ImportBankStatementInput = z.infer<typeof importBankStatementSchema>;

export const matchTransactionSchema = z.object({
  transaction_id: z.string().uuid(),
  membership_id: z.string().uuid(),
});
export type MatchTransactionInput = z.infer<typeof matchTransactionSchema>;

// ---- Manager agent API (see src/lib/manager-agent.ts + AGENTS.md) ----
//
// A small HTTP surface a manager's AI agent can drive (via MCP or a skill). The
// action names below are the contract; keep them in sync with AGENT_MANIFEST in
// manager-agent.ts and the skill at .claude/skills/uts-manager-agent/.

/** Actions the manager agent endpoint accepts. Order mirrors AGENT_MANIFEST. */
export const managerAgentActions = [
  "list_users",
  "list_invoices",
  "edit_invoice",
  "file_waiver",
  "list_kb_sections",
  "save_kb_section",
  "list_kb_articles",
  "get_kb_article",
  "save_kb_article",
  "list_kb_comments",
] as const;
export type ManagerAgentAction = (typeof managerAgentActions)[number];

/** Payment methods an invoice can carry (mirrors the memberships CHECK). */
export const invoicePaymentMethods = ["bank_transfer", "stripe", "manual"] as const;

/**
 * `edit_invoice` params. An "invoice" is a membership row — its price, payment
 * reference and status ARE the invoice. Only correctable detail fields are
 * editable, and `status` deliberately EXCLUDES "active": activation grants the
 * member role and emails the member, so it must run through bank reconciliation
 * / setMembershipStatus, never a raw field edit here.
 *
 * `confirm_paid_edit` is not a field to write: it is the caller saying "yes, I
 * mean to rewrite the money record on an invoice that has already been paid"
 * (see RECONCILED_GUARDED_FIELDS in manager-agent.ts). It deliberately does not
 * satisfy the at-least-one-field refine below.
 */
export const editInvoiceSchema = z
  .object({
    id: z.string().uuid(),
    price_cents: z.number().int().min(0).max(1_000_000).optional(),
    // Nullable: notes is a nullable column, and once a manager has written one
    // there was otherwise no way back to blank. `null` clears it; `undefined`
    // (the field simply absent) leaves it untouched, same as every other field.
    notes: z.string().trim().max(2000).nullable().optional(),
    payment_reference: z.string().trim().min(1).max(64).optional(),
    payment_method: z.enum(invoicePaymentMethods).optional(),
    status: z.enum(["pending", "cancelled", "expired"]).optional(),
    // `.default(false)` to match confirm_duplicate on paperWaiverUploadSchema:
    // two structurally identical confirmation flags should not parse to
    // different types (`boolean | undefined` vs `boolean`) for no reason.
    confirm_paid_edit: z.boolean().optional().default(false),
  })
  .strict()
  .refine(
    (d) =>
      d.price_cents !== undefined ||
      d.notes !== undefined ||
      d.payment_reference !== undefined ||
      d.payment_method !== undefined ||
      d.status !== undefined,
    { message: "Provide at least one invoice field to edit." },
  );
export type EditInvoiceInput = z.infer<typeof editInvoiceSchema>;

/** `list_users` params — optional lifecycle filter + result cap. */
export const listAgentUsersSchema = z.object({
  status: z.enum(lifecycleStatuses).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ListAgentUsersInput = z.infer<typeof listAgentUsersSchema>;

/** `list_invoices` params — optional membership-status filter + result cap. */
export const listAgentInvoicesSchema = z.object({
  status: z.enum(membershipStatuses).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ListAgentInvoicesInput = z.infer<typeof listAgentInvoicesSchema>;

// ---- Manager API tokens (see src/lib/manager-api-tokens.ts) ----

/** Mint a new manager API token — just a human label to tell tokens apart. */
export const createApiTokenSchema = z.object({
  label: z.string().trim().min(1, "Give the token a name.").max(80),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;

/** Revoke an existing token by id. */
export const revokeApiTokenSchema = z.object({
  id: z.string().uuid(),
});
export type RevokeApiTokenInput = z.infer<typeof revokeApiTokenSchema>;

// ---- Manager: club settings (invoice payment instructions) ----

/** Default invoice instructions used until a manager customizes them. */
export const DEFAULT_INVOICE_INSTRUCTIONS =
  "Pay by bank transfer to the club account. Please include your payment reference in the transfer description so we can match your payment automatically.";

export const saveClubSettingsSchema = z.object({
  invoice_payment_instructions: z.string().trim().max(5000),
});
export type SaveClubSettingsInput = z.infer<typeof saveClubSettingsSchema>;

// ---- Calendar (see docs/calendar.md) ----

/**
 * ACCESS setting. `public` shows to everyone including the marketing site;
 * `members` is visible only to PAID members (and managers). Enforced.
 */
export const calendarVisibilities = ["public", "members"] as const;
export type CalendarVisibility = (typeof calendarVisibilities)[number];

/** Cancelling keeps the row (so the feed emits STATUS:CANCELLED). */
export const eventStatuses = ["scheduled", "cancelled"] as const;
export type EventStatus = (typeof eventStatuses)[number];

/** An RSVP response. Open to any signed-in user, trial visitors included. */
export const rsvpResponses = ["going", "maybe", "declined"] as const;
export type RsvpResponse = (typeof rsvpResponses)[number];

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour HH:MM time.");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");
const isoDateTime = z.string().datetime({ offset: true });

/**
 * The details every calendar entry carries, whether it happens once or weekly.
 * Only the title is required — an entry with no instructor, no description and
 * no fixed location is perfectly normal (a social, a grading at a venue not yet
 * booked). Blank optional text is normalised to undefined so the column ends up
 * NULL rather than an empty string.
 */
const blankToUndefined = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const calendarEntryDetails = {
  title: z.string().trim().min(1, "Give it a title.").max(120),
  description: blankToUndefined(4000),
  instructor_name: blankToUndefined(80),
  location: blankToUndefined(120),
  visibility: z.enum(calendarVisibilities).default("public"),
  /** DISPLAY ONLY: badges the entry "invite only". Restricts nothing. */
  invite_only: z.boolean().default(false),
};

/** A one-off entry: an absolute start and end. */
export const calendarRepeatNeverSchema = z.object({
  type: z.literal("never"),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
});

/**
 * A weekly entry: a club-local time of day on a weekday, from a first date,
 * either open-ended (`ends_on` omitted/null) or until a set date.
 */
export const calendarRepeatWeeklySchema = z.object({
  type: z.literal("weekly"),
  weekday: z.number().int().min(0).max(6),
  start_time: timeOfDay,
  duration_minutes: z.number().int().positive().max(600),
  starts_on: dateOnly,
  ends_on: dateOnly.nullish(),
});

/**
 * Manager: put something on the calendar. There is ONE kind of thing — an entry
 * — and repeating is a property of it, not a different type. The discriminated
 * union is what makes "these fields only when it repeats" checkable, which two
 * separate schemas could not express.
 *
 * The date ordering rules live in a superRefine rather than on each member,
 * because a discriminated union's options must be plain objects.
 */
export const createCalendarEntrySchema = z
  .object({
    ...calendarEntryDetails,
    repeat: z.discriminatedUnion("type", [calendarRepeatNeverSchema, calendarRepeatWeeklySchema]),
  })
  .superRefine((v, ctx) => {
    if (v.repeat.type === "never") {
      if (new Date(v.repeat.ends_at) < new Date(v.repeat.starts_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "It must end at or after it starts.",
          path: ["repeat", "ends_at"],
        });
      }
      return;
    }
    if (v.repeat.ends_on && v.repeat.ends_on < v.repeat.starts_on) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The end date must be on or after the first date.",
        path: ["repeat", "ends_on"],
      });
    }
  });
export type CreateCalendarEntryInput = z.infer<typeof createCalendarEntrySchema>;

/**
 * Manager: edit an entry's details. `scope` answers the question the UI asks
 * when the entry repeats: just this date, or this and every future one? `id` is
 * the DATE that was clicked in both scopes (the server resolves its series), so
 * "every future one" is measured from there. Schedule shape (weekday, time,
 * duration) is deliberately not editable here — changing it invalidates dates
 * already on the calendar.
 */
export const updateCalendarEntrySchema = z
  .object({
    scope: z.enum(["event", "series"]),
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(4000).nullish(),
    instructor_name: z.string().trim().max(80).nullish(),
    location: z.string().trim().max(120).nullish(),
    visibility: z.enum(calendarVisibilities).optional(),
    invite_only: z.boolean().optional(),
  })
  .strict();
export type UpdateCalendarEntryInput = z.infer<typeof updateCalendarEntrySchema>;

/** Manager: stop a repeating entry. Future dates go; history is untouched. */
export const stopRepeatingSchema = z.object({ series_id: z.string().uuid() });
export type StopRepeatingInput = z.infer<typeof stopRepeatingSchema>;

/**
 * Manager: cancel or un-cancel. The row is always kept, so subscribers see the
 * cancellation rather than the entry silently disappearing. `scope` asks the
 * same question as editing: just this date, or this and every future one?
 */
export const cancelEventSchema = z.object({
  scope: z.enum(["event", "series"]).default("event"),
  id: z.string().uuid(),
  cancelled: z.boolean(),
});
export type CancelEventInput = z.infer<typeof cancelEventSchema>;

/** Manager: delete an event outright (use cancel to keep the record). */
export const deleteEventSchema = z.object({ id: z.string().uuid() });
export type DeleteEventInput = z.infer<typeof deleteEventSchema>;

/** Manager: list who responded to one event. */
export const eventRsvpsSchema = z.object({ event_id: z.string().uuid() });
export type EventRsvpsInput = z.infer<typeof eventRsvpsSchema>;

/** Member: set (upsert) an RSVP to an event. */
export const rsvpSchema = z.object({
  event_id: z.string().uuid(),
  response: z.enum(rsvpResponses),
});
export type RsvpInput = z.infer<typeof rsvpSchema>;

// ---- Check-ins (see docs/check-in.md) ----

/**
 * What covered a class, mirroring `membership_plans.kind` plus `none`. Stored on
 * the check-in as a record of what paid for it at the time, so editing a plan
 * afterwards cannot rewrite history. `insurance` is absent on purpose: yearly
 * insurance buys affiliation and cover, never mat time.
 *
 * Must match the CHECK constraint in the `session_checkins` migration.
 */
export const coverageSources = ["trial", "session", "period", "none"] as const;
export type CoverageSource = (typeof coverageSources)[number];

/**
 * Stable machine codes explaining a check-in, stored in `session_checkins.warnings`.
 * Codes rather than sentences so the wording can change without a migration, and
 * so the "needs attention" list can say *why* something is uncovered instead of
 * just that it is.
 */
export const checkInWarnings = [
  /** Nothing active covered this class; attach it to a membership later. */
  "no_cover",
  /** This took the final credit, so the membership is now finished. */
  "last_credit",
  /** They hold a membership still marked active but past its end date. */
  "membership_ended",
  /** They hold an active credit membership with nothing left on it. */
  "credits_exhausted",
  /** A membership is waiting on payment: the money has not landed yet. */
  "payment_pending",
  /** A concurrent check-in took the credit first; this one needs attaching. */
  "coverage_race",
] as const;
export type CheckInWarning = (typeof checkInWarnings)[number];

/** Manager: the roster and coverage preview for one class. */
export const checkInBoardSchema = z.object({ event_id: z.string().uuid() });
export type CheckInBoardInput = z.infer<typeof checkInBoardSchema>;

/** Manager: check one person in to one class. */
export const checkInSchema = z.object({
  event_id: z.string().uuid(),
  user_id: z.string().uuid(),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});
export type CheckInInput = z.infer<typeof checkInSchema>;

/** Manager: undo a check-in, refunding whatever credit it spent. */
export const undoCheckInSchema = z.object({ id: z.string().uuid() });
export type UndoCheckInInput = z.infer<typeof undoCheckInSchema>;

/**
 * Manager: give an uncovered check-in its cover. Without `membership_id` the
 * server re-runs the same precedence rules the door would have applied, which is
 * the right answer once a late payment has been reconciled; supplying one is the
 * override for when a manager wants a specific membership to absorb it.
 */
export const attachCheckInSchema = z.object({
  id: z.string().uuid(),
  membership_id: z.string().uuid().optional(),
});
export type AttachCheckInInput = z.infer<typeof attachCheckInSchema>;

/**
 * Parse a "$245", "245", "20.50" or "2,450.00" money string into integer cents.
 * Returns null for blanks / unparseable input. Used by the CSV importer.
 */
export function parseMoneyToCents(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ---- Knowledge base (see docs/knowledge-base.md) ----
//
// Versioned markdown pages people read at `/kb/<slug>` and annotate, grouped
// into ordered sections. The domain rules (block anchoring, who may
// read/annotate) live in `src/lib/kb.ts` and the ordering in `src/lib/kb-nav.ts`;
// this file only validates what crosses the wire.

/**
 * The URL key of an article, mirroring the `kb_articles.slug` CHECK exactly.
 *
 * Kept identical on purpose: `save_kb_article` treats an unknown slug as "create
 * this article", so a slug the app accepts but the database rejects would turn
 * a manager's typo into a raw constraint-violation message instead of a clear
 * one, after the request had already been accepted.
 */
export const kbSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers and single hyphens, e.g. house-rules.",
  );

/**
 * A site-relative path a sidebar entry can point at, mirroring the
 * `kb_articles.link_path` CHECK.
 *
 * Site-relative only, and the pattern is the security boundary rather than a
 * tidiness rule: an absolute URL here would let a caller put any destination
 * into the club's own navigation, and `//host` would turn `/kb/<slug>` into an
 * open redirect. Both are rejected by requiring a single leading slash followed
 * by an alphanumeric.
 */
export const kbLinkPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\/[a-z0-9][a-z0-9/-]*$/, "Use a path on this site, e.g. /first-class.")
  .refine((value) => !value.includes("//"), "Use a path on this site, e.g. /first-class.")
  // A link entry pointing back into the knowledge base is a redirect loop with
  // no way out: `/kb/<slug>` full-navigates to `link_path`, so an entry aimed at
  // itself (or a pair aimed at each other) hangs the tab, and no in-app control
  // can recover it. Ordering an article next to another one is what `section`
  // and `position` are for.
  .refine(
    (value) => !/^\/kb($|\/)/.test(value),
    "A link entry cannot point back into the knowledge base. Use section and position to order articles.",
  );

/**
 * Manager: save an article. Creates it if the slug is new, and always writes a
 * NEW version rather than editing text in place — same rule as the waiver
 * template, for the same reason: annotations name the version they were written
 * against, so rewriting a version underneath them would make that reference a lie.
 *
 * Every field except the slug is optional, and that is the whole contract: an
 * omitted field is LEFT ALONE. It is what stops an agent asked to fix a typo
 * from also moving the article to the top of the sidebar or publishing a
 * managers-only draft by not mentioning `visibility`.
 *
 * The refinement below splits the two kinds of row this creates:
 *
 *   * An ARTICLE has `title` + `body_md` and gets a new version.
 *   * A LINK ENTRY has `link_path` + `nav_title` and never gets a version. It is
 *     a sidebar item pointing at a page elsewhere on the site, so text on it
 *     would have nowhere to render.
 */
export const saveKbArticleSchema = z
  .object({
    slug: kbSlugSchema,
    title: z.string().trim().min(1).max(200).optional(),
    body_md: z.string().trim().min(1).max(200000).optional(),
    visibility: z.enum(articleVisibilities).optional(),
    annotations_enabled: z.boolean().optional(),
    change_note: z.string().trim().max(500).optional().or(z.literal("")),
    /** Slug of the section it belongs to. Empty string moves it out of every section. */
    section: kbSlugSchema.optional().or(z.literal("")),
    /** Lower sorts first within the section. */
    position: z.number().int().min(0).max(100000).optional(),
    /** Sidebar label, when it should be shorter than the title. */
    nav_title: z.string().trim().min(1).max(100).optional().or(z.literal("")),
    /** An empty string turns a link entry back into an article. */
    link_path: kbLinkPathSchema.optional().or(z.literal("")),
    /**
     * "I believe this slug is free." Set by anything creating an article, and
     * refused server-side if the slug is taken.
     *
     * A known slug is a SAVE, not a create, so a caller that thinks it is
     * creating would otherwise replace an existing article's live text and,
     * because it sends a visibility, republish it to whoever that admits. The
     * manager screen checks its own list first, but that list is a snapshot:
     * somebody else can create the slug between the screen loading and the
     * save. Only the database knows, so the check belongs here too.
     */
    expect_new: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    // Turning a link entry back into an article. It must arrive with the text
    // in the same call: a row with neither a link nor a version is invisible in
    // the sidebar, so clearing one on its own would make the entry vanish until
    // somebody remembered to write it.
    if (value.link_path === "") {
      if (!value.title || !value.body_md) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["link_path"],
          message:
            "Clearing link_path turns this into an article, so send title and body_md in the same call.",
        });
      }
      return;
    }
    if (value.link_path) {
      if (!value.nav_title) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nav_title"],
          message: "A link entry has no article text to take a name from, so it needs a nav_title.",
        });
      }
      if (value.title || value.body_md) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["link_path"],
          message:
            "A link entry points at another page, so it cannot also have a title or body_md.",
        });
      }
      return;
    }
    // Not a link entry, so it needs text — unless this is a pure metadata edit
    // (moving an existing article between sections), which names neither.
    if (Boolean(value.title) !== Boolean(value.body_md)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.title ? "body_md" : "title"],
        message: "Saving new text needs both title and body_md: a version is written as a whole.",
      });
    }
  });
export type SaveKbArticleInput = z.infer<typeof saveKbArticleSchema>;

/**
 * Manager: create or rename a section, or move it in the sidebar.
 *
 * Same "unknown slug creates it" rule as an article, and the same
 * omitted-means-unchanged rule, so reordering the knowledge base is one call per
 * section rather than a read-modify-write of the whole structure.
 */
export const saveKbSectionSchema = z.object({
  slug: kbSlugSchema,
  title: z.string().trim().min(1).max(100).optional(),
  position: z.number().int().min(0).max(100000).optional(),
});
export type SaveKbSectionInput = z.infer<typeof saveKbSectionSchema>;

/** A reader searching the knowledge base from the top bar. */
export const searchKnowledgeBaseSchema = z.object({
  q: z.string().trim().min(2).max(100),
});
export type SearchKnowledgeBaseInput = z.infer<typeof searchKnowledgeBaseSchema>;

/**
 * A reader opening an article. Deliberately has NO `version`: readers always get
 * the live one.
 *
 * Letting a reader name a version would publish an article's whole drafting
 * history the moment it goes live. A managers-only draft's earlier versions
 * (internal figures, names, wording nobody agreed to publish) are readable by
 * anyone the CURRENT visibility admits, because visibility lives on the article
 * and not on each version. Version-by-version access needs a per-version record
 * of what it was published under, which this schema does not have — so the
 * public read does not offer it at all.
 */
export const readKbArticleSchema = z.object({ slug: kbSlugSchema });
export type ReadKbArticleInput = z.infer<typeof readKbArticleSchema>;

/**
 * Manager: read one article, optionally a named version. Manager-only for the
 * reason above — a manager may read their own drafting history.
 */
export const getKbArticleSchema = z.object({
  slug: kbSlugSchema,
  version: z.number().int().positive().optional(),
});
export type GetKbArticleInput = z.infer<typeof getKbArticleSchema>;

/** Manager: list the annotations on an article, to read back what people said. */
export const listKbCommentsSchema = z.object({
  slug: kbSlugSchema,
  /** Omit for every annotation; set to read one version's feedback in isolation. */
  version: z.number().int().positive().optional(),
  include_resolved: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ListKbCommentsInput = z.infer<typeof listKbCommentsSchema>;

/**
 * Write an annotation.
 *
 * `article_version` is the version the reader had on screen. The server stores
 * it verbatim: unlike the waiver (which REFUSES a submission against a stale
 * version, because a signature is evidence of what was read), a comment on an
 * older wording is a perfectly good comment, and the reader is shown that the
 * text has moved on rather than having their words thrown away.
 */
export const createAnnotationSchema = z.object({
  slug: kbSlugSchema,
  article_version: z.number().int().positive(),
  /** Null/omitted anchors the annotation to the article as a whole. */
  block_id: z.string().trim().max(100).optional().or(z.literal("")),
  /** The passage as it stood, so a later edit can be reported honestly. */
  quote: z.string().trim().max(2000).optional().or(z.literal("")),
  visibility: z.enum(annotationVisibilities),
  /** Set to reply to an existing shared annotation. */
  parent_id: z.string().uuid().optional(),
  body: z.string().trim().min(1).max(5000),
  hp: z.string().max(0).optional().or(z.literal("")),
});
export type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>;

/** Edit your own annotation's text. Nothing else about it can change. */
export const updateAnnotationSchema = z.object({
  id: z.string().uuid(),
  body: z.string().trim().min(1).max(5000),
});
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationSchema>;

/** Delete your own annotation (and, by cascade, its replies). */
export const deleteAnnotationSchema = z.object({ id: z.string().uuid() });
export type DeleteAnnotationInput = z.infer<typeof deleteAnnotationSchema>;

/** Resolve or reopen a shared thread. */
export const resolveAnnotationSchema = z.object({
  id: z.string().uuid(),
  resolved: z.boolean(),
});
export type ResolveAnnotationInput = z.infer<typeof resolveAnnotationSchema>;
// ---- Blog (see docs/blog.md) ----

export const blogPostStatuses = ["draft", "published"] as const;
export type BlogPostStatus = (typeof blogPostStatuses)[number];

export const blogCommentStatuses = ["visible", "hidden"] as const;
export type BlogCommentStatus = (typeof blogCommentStatuses)[number];

const blogSlug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and hyphens only.");

/**
 * Manager: create or edit a post. `slug` is optional — when blank, the server
 * derives one from the title (`slugify` in `src/lib/slug.ts`) and resolves any
 * collision by appending `-2`, `-3`, etc.
 */
export const blogPostSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  slug: blogSlug.optional().or(z.literal("")),
  excerpt: z.string().trim().max(500).optional().or(z.literal("")),
  body_md: z.string().trim().min(1).max(50000),
  cover_image_path: z.string().trim().max(500).optional().or(z.literal("")),
  status: z.enum(blogPostStatuses).default("draft"),
});
export type BlogPostInput = z.infer<typeof blogPostSchema>;

/** Manager: fetch one post (any status) for editing. */
export const getBlogPostForEditSchema = z.object({ id: z.string().uuid() });
export type GetBlogPostForEditInput = z.infer<typeof getBlogPostForEditSchema>;

/** Manager: delete a post. */
export const deleteBlogPostSchema = z.object({ id: z.string().uuid() });
export type DeleteBlogPostInput = z.infer<typeof deleteBlogPostSchema>;

/** Public: fetch one published post by its slug. */
export const blogPostSlugSchema = z.object({ slug: z.string().trim().min(1).max(200) });
export type BlogPostSlugInput = z.infer<typeof blogPostSlugSchema>;

/** Public: page through the published post list. */
export const listBlogPostsSchema = z.object({ page: z.number().int().min(1).default(1) });
export type ListBlogPostsInput = z.infer<typeof listBlogPostsSchema>;

/** The `/blog` route's `?page=` search param. `catch(1)` rather than reject:
 * a mistyped or stale page number should just show page one, not error. */
export const blogListSearchSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
});
export type BlogListSearch = z.infer<typeof blogListSearchSchema>;

/** Public: comments for one post. */
export const listBlogCommentsSchema = z.object({ post_id: z.string().uuid() });
export type ListBlogCommentsInput = z.infer<typeof listBlogCommentsSchema>;

/** Manager: comments across the blog, optionally filtered to one post. */
export const listCommentsForModerationSchema = z.object({
  post_id: z.string().uuid().optional(),
});
export type ListCommentsForModerationInput = z.infer<typeof listCommentsForModerationSchema>;

/** Image types a manager may upload for a post (cover or inline). Videos are
 * never uploaded — a post embeds one by pasting a link (see blogCommentSchema
 * sibling `[[video:<url>]]` convention in body_md, applied by the renderer). */
export const blogImageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type BlogImageMimeType = (typeof blogImageMimeTypes)[number];

/** How large a single blog image may be, decoded. */
export const MAX_BLOG_IMAGE_BYTES = 8 * 1024 * 1024;

/** Manager: upload an image for a post. Same base64-in-JSON convention as the
 * scanned-waiver upload (`scanFileSchema`). `post_id` is omitted while
 * composing a brand-new, not-yet-saved post — the image is filed under
 * `drafts/` and stays there permanently (the path is just a storage key, not
 * something shown to anyone, so there's no need to move it once the post has
 * an id). */
export const uploadBlogImageSchema = z
  .object({
    post_id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    type: z.enum(blogImageMimeTypes),
    /** Raw base64, no `data:` prefix. */
    data: z.string().min(1),
  })
  .refine((d) => base64ByteLength(d.data) <= MAX_BLOG_IMAGE_BYTES, {
    message: "That image is too large. Keep it under 8 MB.",
    path: ["data"],
  });
export type UploadBlogImageInput = z.infer<typeof uploadBlogImageSchema>;

// ---- Blog comments ----
//
// Any signed-in person may comment or reply — membership status irrelevant,
// the same rule as calendar RSVPs — and upvote a comment once (no downvote).
// Reply nesting is one level: a reply's own parent must be top-level, checked
// server-side against the parent row (not expressible in this schema).

export const blogCommentSchema = z.object({
  post_id: z.string().uuid(),
  parent_comment_id: z.string().uuid().optional(),
  body: z.string().trim().min(1).max(2000),
  hp: z.string().max(0).optional(), // honeypot — must stay empty
});
export type BlogCommentInput = z.infer<typeof blogCommentSchema>;

/** Toggle (add if absent, remove if present) the caller's upvote on a comment. */
export const toggleUpvoteSchema = z.object({ comment_id: z.string().uuid() });
export type ToggleUpvoteInput = z.infer<typeof toggleUpvoteSchema>;

/** Manager: hide or restore a comment. */
export const setCommentVisibilitySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(blogCommentStatuses),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});
export type SetCommentVisibilityInput = z.infer<typeof setCommentVisibilitySchema>;

/** Manager: block a person from commenting anywhere on the blog — the extreme
 * moderation action, separate from hiding a single comment. */
export const blockCommenterSchema = z.object({
  user_id: z.string().uuid(),
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});
export type BlockCommenterInput = z.infer<typeof blockCommenterSchema>;

export const unblockCommenterSchema = z.object({ user_id: z.string().uuid() });
export type UnblockCommenterInput = z.infer<typeof unblockCommenterSchema>;

// ---- Account: display name (shown on blog comments) ----

/** `display_name: null` clears the override, reverting to the derived name. */
export const updateDisplayNameSchema = z.object({
  display_name: z.string().trim().min(1).max(60).nullable(),
});
export type UpdateDisplayNameInput = z.infer<typeof updateDisplayNameSchema>;
