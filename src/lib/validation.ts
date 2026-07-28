// Shared validation schemas and pure helpers for form submissions.
//
// These live here (rather than inline in the *.functions.ts server modules) so
// they can be unit-tested directly and reused by both client and server without
// pulling in server-only imports. Keep this file free of side effects and of any
// server-only dependency (no supabase clients, no process.env reads).
import { z } from "zod";

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
 * Assemble the signer_meta evidence blob stored on a waiver: request headers
 * captured server-side (user agent, language, client hints) merged with the
 * browser's self-reported context. Pure — takes a header getter so it is
 * unit-testable; empty values are dropped so the blob stays compact.
 */
export function buildSignerMeta(
  getHeader: (name: string) => string | undefined,
  client: WaiverClientMeta | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
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

// ---- Interest registration ----

export const interestSchema = z.object({
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
    emergency_contact_name: z.string().trim().min(1).max(120),
    emergency_contact_phone: z.string().trim().min(1).max(30),
    medical_notes: z.string().trim().max(2000).optional().or(z.literal("")),
    // Map of acknowledgement id -> accepted. Which ids are *required* is defined
    // on the template, so that check lives in `missingRequiredAcks`, not here.
    acknowledgements: z.record(z.string(), z.boolean()).default({}),
    signature_name: z.string().trim().max(120).optional().or(z.literal("")),
    signature_image: sigImage,
    is_minor: z.boolean().optional().default(false),
    guardian_name: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    guardian_signature: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_signature_image: sigImage,
    // Self-reported browser context, stored on the waiver as signing evidence.
    client_meta: waiverClientMetaSchema.optional(),
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
      (d.guardian_name &&
        d.guardian_relationship &&
        ((d.guardian_signature && d.guardian_signature.trim()) ||
          (d.guardian_signature_image && d.guardian_signature_image.trim()))),
    {
      message:
        "Parent/guardian name, relationship and signature are required for participants under 18.",
      path: ["guardian_name"],
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

// ---- Manager: approve / unapprove a signed waiver ----

/** The member-facing status a manager can set on a signed waiver. */
export const waiverApprovalStatuses = ["pending", "approved"] as const;
export type WaiverApprovalStatus = (typeof waiverApprovalStatuses)[number];

export const waiverApprovalSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(waiverApprovalStatuses),
});
export type WaiverApprovalInput = z.infer<typeof waiverApprovalSchema>;

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
export const managerAgentActions = ["list_users", "list_invoices", "edit_invoice"] as const;
export type ManagerAgentAction = (typeof managerAgentActions)[number];

/** Payment methods an invoice can carry (mirrors the memberships CHECK). */
export const invoicePaymentMethods = ["bank_transfer", "stripe", "manual"] as const;

/**
 * `edit_invoice` params. An "invoice" is a membership row — its price, payment
 * reference and status ARE the invoice. Only correctable detail fields are
 * editable, and `status` deliberately EXCLUDES "active": activation grants the
 * member role and emails the member, so it must run through bank reconciliation
 * / setMembershipStatus, never a raw field edit here.
 */
export const editInvoiceSchema = z
  .object({
    id: z.string().uuid(),
    price_cents: z.number().int().min(0).max(1_000_000).optional(),
    notes: z.string().trim().max(2000).optional(),
    payment_reference: z.string().trim().min(1).max(64).optional(),
    payment_method: z.enum(invoicePaymentMethods).optional(),
    status: z.enum(["pending", "cancelled", "expired"]).optional(),
  })
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
