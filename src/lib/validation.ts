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
// Same idea for the gi/belt size charts: `kit-sizes.ts` owns the two code sets
// (and the CHECK constraints on `profiles` mirror them), so the wire schemas
// below enumerate them from there rather than repeating the lists.
import { beltSizes, giSizes } from "./kit-sizes";
// A dated plan's window is computed in the club's own timezone (its last day
// must cover that evening's class, not cut off at UTC midnight), so this
// module needs the same zoned-time helpers the calendar uses. `calendar.ts` is
// the same kind of module as this one (pure, no server imports).
import { CLUB_TIME_ZONE, clubLocalDate, zonedWallTimeToUtc } from "./calendar";
import { formatDate, formatDateOnly } from "./dates";

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
  /**
   * Media/promotional-photo consent as ticked on this submission. `null` when
   * the template signed had no media acknowledgement, i.e. they were never
   * asked -- which is not the same as declining. Derived from the
   * acknowledgement ticks by `mediaConsentFromAnswers`, not sent by the client.
   */
  media_consent: boolean | null;
  emergency_contact_name: string;
  /** How the emergency contact is related. Not the guardian by definition. */
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string;
  medical_notes: string | null;
  is_minor: boolean;
  /**
   * The parent or legal guardian who signed for a minor, and how to reach
   * them. They may be a different person from the emergency contact above, so
   * they carry their own contact details; each is resolved against the
   * participant's own by `resolveWaiverContacts` before it lands here, so
   * "same as the participant's" is stored as the value, never as a blank.
   * All null for an adult.
   */
  guardian_name: string | null;
  guardian_relationship: string | null;
  guardian_address: string | null;
  guardian_phone: string | null;
  guardian_email: string | null;
};

/**
 * The patch shape approval writes onto `profiles`.
 *
 * Every field is copied across verbatim except `media_consent`, which is
 * *omitted* rather than set when the submission carries `null`. Approving a
 * waiver signed on a template that never asked about photos must not erase a
 * consent the club already holds -- a patch with `media_consent: null` in it
 * would do exactly that.
 */
export type WaiverProfilePatch = Omit<WaiverPersonFields, "media_consent"> & {
  media_consent?: boolean;
};

/**
 * The profile patch a manager's approval applies: the approved submission's
 * person fields become the club's current record of that person. Pure so the
 * promotion mapping is unit-testable; the caller adds `updated_at`.
 */
export function waiverToProfileFields(w: WaiverPersonFields): WaiverProfilePatch {
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
    // Omitted, not nulled, when this submission never asked -- see the patch type.
    ...(w.media_consent === null ? {} : { media_consent: w.media_consent }),
    emergency_contact_name: w.emergency_contact_name,
    emergency_contact_relationship: w.emergency_contact_relationship,
    emergency_contact_phone: w.emergency_contact_phone,
    medical_notes: w.medical_notes,
    is_minor: w.is_minor,
    guardian_name: w.guardian_name,
    guardian_relationship: w.guardian_relationship,
    guardian_address: w.guardian_address,
    guardian_phone: w.guardian_phone,
    guardian_email: w.guardian_email,
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

/**
 * The hidden field every write-from-a-form path carries, spelled once here so
 * all seven agree.
 *
 * **Required, not optional.** A browser always sends it, empty, because the
 * form has the input in it. A script hand-rolling a POST against the endpoint
 * has no reason to invent a field it cannot see, so it omits `hp` entirely —
 * and while this was `.optional()`, omitting it was a clean pass through the
 * trap. That is the exact shape of request the honeypot exists to catch, and
 * it was the only one getting through.
 *
 * So both a filled `hp` and an absent one are refused here, at the validator.
 * The `if (data.hp)` early-returns in the seven handlers are therefore
 * unreachable: `.max(0)` has already thrown by the time a handler runs. They
 * are left in place as the net if this ever loosens, not because they fire.
 *
 * Nothing about the browser's side changes: `""` still passes, and every call
 * site already sends it. Keep it that way — a new form that forgets `hp` is a
 * form that cannot be submitted at all. `honeypot.test.ts` reads the route
 * files and holds the other half of the bargain: that the decoy each form
 * renders is one something filling in a form would actually fill, and that its
 * value reaches the payload instead of a hardcoded `""`.
 *
 * **Why all seven, including the ones behind a login.** Three of these
 * (`startMembershipSchema`, `createAnnotationSchema`, `blogCommentSchema`) are
 * only reachable with a session, where an anonymous bot cannot get to them at
 * all, so the trap catches nothing there. They carry it anyway, because the
 * alternative is a rule with an exception list: every future schema would need
 * someone to decide which side of the line it falls on, and the way to get that
 * wrong is to call a public form authenticated. A uniform rule fails safe; a
 * remembered one does not.
 *
 * The cost that would argue the other way is a non-browser caller failing on a
 * field it cannot see. That cannot happen through the manager agent API, which
 * has its own schemas for the same operations and no honeypot on any of them
 * (`createMembershipSchema`, `paperWaiverUploadSchema`, and the rest in
 * `manager-agent.ts`). Anything machine-to-machine belongs on that seam, not on
 * a form schema. If a genuine non-browser caller for one of these seven ever
 * appears, that is the signal to give it its own schema, not to loosen this one.
 */
export const honeypot = z.string().max(0);

// ---- Interest registration ----

export const interestSchema = z.object({
  client_submission_id: clientSubmissionId,
  // The register form composes this from first + last name fields (each capped
  // at 60, matching the waiver), so allow up to 60 + " " + 60 = 121 characters.
  name: z.string().trim().min(1).max(121),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  message: z.string().trim().max(1000).optional().or(z.literal("")),
  hp: honeypot,
});

// ---- Contact message ----

// `name` and `subject` reach a manager's inbox inside the notification email's
// SUBJECT LINE, so they are the only two fields here that leave the page as
// anything but body text. Line breaks are refused: the send API posts JSON so
// a CR/LF cannot forge a mail header at that layer, but a subject is a
// single-line field and nothing downstream promises to keep treating it as
// data. `message` is unrestricted — it is body text everywhere it appears.
const singleLine = /^[^\r\n]*$/;

export const contactSchema = z.object({
  client_submission_id: clientSubmissionId,
  name: z.string().trim().min(1).max(100).regex(singleLine),
  email: z.string().trim().email().max(255),
  subject: z.string().trim().max(150).regex(singleLine).optional().or(z.literal("")),
  message: z.string().trim().min(1).max(2000),
  hp: honeypot,
});

/**
 * Manager: page through the messages the contact form has received. Bounded so
 * a manager screen cannot ask for the whole table; the default is generous
 * enough that the club will not page in practice.
 */
export const listContactMessagesSchema = z.object({
  limit: z.number().int().min(1).max(500).default(200),
});
export type ListContactMessagesInput = z.infer<typeof listContactMessagesSchema>;

/**
 * Manager: acknowledge everything up to the newest message they were shown.
 * `seen_at` is that message's `created_at`, not the current time — see
 * `markContactMessagesSeen`.
 */
export const markContactMessagesSeenSchema = z.object({
  seen_at: z.string().datetime({ offset: true }),
});
export type MarkContactMessagesSeenInput = z.infer<typeof markContactMessagesSeenSchema>;

// ---- Deleting an enquiry ----
//
// An enquiry is the one thing a person leaves behind that the club has no
// reason to keep once it has been dealt with: nothing was signed, nothing is
// owed, and no record hangs off it. Everything else a person creates is either
// evidence (a signed waiver) or the club's own history (memberships,
// attendance), and destroying those is a decision the club has not made yet.
// See docs/erasing-personal-data.md.

/** Manager: delete one message from the contact inbox. */
export const deleteContactMessageSchema = z.object({ id: z.string().uuid() }).strict();
export type DeleteContactMessageInput = z.infer<typeof deleteContactMessageSchema>;

/**
 * Manager: delete every interest-form registration filed under one address.
 *
 * Keyed by email rather than by row id because that is what a lead IS: the
 * directory merges every registration sharing an address into one person, so
 * deleting "this lead" has to mean all of them. Deleting one row of two would
 * leave the same person on the list with the older enquiry showing.
 */
export const deleteLeadSchema = z.object({ email: z.string().trim().email().max(255) }).strict();
export type DeleteLeadInput = z.infer<typeof deleteLeadSchema>;

/**
 * Why a lead the screen offered a Delete for turns out not to be one.
 *
 * Read by a manager, so it says what the refusal means rather than naming the
 * check: an address with a person behind it is somebody who signed something,
 * and their enquiry is part of that record now.
 */
export const LEAD_HAS_PERSON_MESSAGE =
  "That address belongs to someone the club has a record for, so this is more than an enquiry now. It can't be deleted here.";

/**
 * Where the club-wide "messages seen up to here" marker should land.
 *
 * Monotonic and clamped: the marker only moves forward, and never past the
 * present. Backwards would make already-read messages reappear when a stale tab
 * finishes late; into the future would mark messages read before they arrive,
 * which is the one failure that loses a message for good.
 *
 * Returns `current` unchanged when the candidate earns no move, so the caller
 * can skip the write.
 */
export function advanceSeenMarker(current: string | null, candidate: string, now: string): string {
  const clamped = candidate > now ? now : candidate;
  if (current && clamped <= current) return current;
  return clamped;
}

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
    // Optional gi size. NOT part of the waiver: it is never written to the
    // `waivers` row and never printed on the PDF, because it is equipment
    // sizing rather than anything the person is declaring or agreeing to. The
    // handler writes it straight onto their profile, and a blank one writes
    // nothing at all, so re-signing never clears a size already on file.
    gi_size: z.enum(giSizes).optional().or(z.literal("")),
    // Optional previous martial arts experience, moved here from the "Start
    // your free trial" lead form. Same treatment as gi_size: NOT part of the
    // waiver (no `waivers` column, never on the PDF), just context for
    // instructors, so the handler writes it straight onto the profile.
    martial_arts_experience: z.string().trim().max(500).optional().or(z.literal("")),
    // The emergency contact: who the club rings if something happens in class.
    // Required for everyone, with one exception -- for a minor whose emergency
    // contact IS the guardian below, the form does not ask twice and sends
    // `emergency_contact_is_guardian` instead (see the refine below, and
    // `resolveWaiverContacts` for what ends up stored).
    emergency_contact_name: z.string().trim().max(120).optional().or(z.literal("")),
    emergency_contact_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    emergency_contact_phone: z.string().trim().max(30).optional().or(z.literal("")),
    // "The emergency contact is the parent or guardian" -- the form's default
    // for a minor, and how it stays as short as it was before the guardian got
    // their own block. Meaningless for an adult, who has no guardian.
    emergency_contact_is_guardian: z.boolean().optional().default(false),
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
    // The parent or legal guardian of a minor: the person who signs, and who
    // the club may have to reach about their child. Asked for in their own
    // right because they are not always the emergency contact -- the parent at
    // work interstate and the aunt who does the pickup are two different
    // people, and the club needs both.
    //
    // Name and relationship are required for a minor (see the refine below).
    // The three contact fields are optional and mean "the same as the
    // participant's"; `resolveWaiverContacts` fills them in, so what is stored
    // is always the real value rather than a blank somebody has to interpret.
    guardian_name: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    guardian_address: z.string().trim().max(300).optional().or(z.literal("")),
    guardian_phone: z.string().trim().max(30).optional().or(z.literal("")),
    guardian_email: z.string().trim().email().max(255).optional().or(z.literal("")),
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
    hp: honeypot,
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
  // A minor's guardian is named on the document and signs it, so those two
  // fields are required whatever else is or is not the same as somebody else's.
  .refine((d) => !d.is_minor || Boolean(d.guardian_name?.trim()), {
    message: "Please give the parent or guardian's name.",
    path: ["guardian_name"],
  })
  .refine((d) => !d.is_minor || Boolean(d.guardian_relationship?.trim()), {
    message: "Please say how the parent or guardian is related to the participant.",
    path: ["guardian_relationship"],
  })
  // The emergency contact is required of everyone, unless it is the guardian --
  // in which case the form asked once and copies the answer across, and asking
  // again would be asking the same person to write themselves down twice.
  .superRefine((d, ctx) => {
    if (d.is_minor && d.emergency_contact_is_guardian) return;
    const fields = [
      [
        "emergency_contact_name",
        d.emergency_contact_name,
        "Please give an emergency contact name.",
      ],
      [
        "emergency_contact_relationship",
        d.emergency_contact_relationship,
        "Please say how the emergency contact is related.",
      ],
      [
        "emergency_contact_phone",
        d.emergency_contact_phone,
        "Please give an emergency contact mobile.",
      ],
    ] as const;
    for (const [path, value, message] of fields) {
      if (!value?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
      }
    }
  })
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
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

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

// ---- Manager agent API: the same three template actions, keyed by version ----
//
// The editor screen keys on the row id because it is holding the row it just
// listed. An agent is not: it reads a list, decides, and calls back later, so it
// keys on the VERSION NUMBER — unique on the table, stable, and the same number
// a manager reads off the screen and off a signed PDF. That is the only
// difference between these and the two schemas above; every rule about what a
// version may contain is shared.
//
// All three are `.strict()`, like `paperWaiverUploadSchema` and
// `editInvoiceSchema`: a misspelled `base_version` that Zod quietly stripped
// would publish an edit against the wrong wording and report success.

/** Read one stored version, or the live one when no version is named. */
export const agentGetWaiverTemplateSchema = z
  .object({ version: z.number().int().positive().optional() })
  .strict();
export type AgentGetWaiverTemplateInput = z.infer<typeof agentGetWaiverTemplateSchema>;

/**
 * Write a new version of the waiver and publish it.
 *
 * Every field is optional because an omitted one is CARRIED OVER from the
 * version the edit starts from (the live one, unless `base_version` names
 * another). That is what the screen does: a manager opens a version, changes one
 * clause or reworders one acknowledgement, and saves. Without the carry-over,
 * changing an acknowledgement would mean resending the whole legal text, and the
 * likeliest outcome of that is a body retyped from memory.
 *
 * Two refusals, both about not writing a version nobody meant:
 *
 *   * `title` and `body_md` travel together, as in `saveKbArticleSchema` — a
 *     version is written as a whole, and a body under last version's heading is
 *     nobody's intent.
 *   * A call naming no text and no acknowledgements is refused rather than
 *     publishing a byte-identical copy of the live version under a new number.
 */
export const agentSaveWaiverTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body_md: z.string().trim().min(1).max(30000).optional(),
    acknowledgements: templateAcknowledgementsSchema.optional(),
    /** Which stored version this edit starts from. Defaults to the live one. */
    base_version: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.title) !== Boolean(value.body_md)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.title ? "body_md" : "title"],
        message: "Saving new text needs both title and body_md: a version is written as a whole.",
      });
    }
    if (!value.title && !value.body_md && !value.acknowledgements) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body_md"],
        message:
          "Nothing to save: send title and body_md, acknowledgements, or both. To make an existing version live again, use publish_waiver_template.",
      });
    }
  });
export type AgentSaveWaiverTemplateInput = z.infer<typeof agentSaveWaiverTemplateSchema>;

/** Make an existing stored version the live one. */
export const agentPublishWaiverTemplateSchema = z
  .object({ version: z.number().int().positive() })
  .strict();
export type AgentPublishWaiverTemplateInput = z.infer<typeof agentPublishWaiverTemplateSchema>;

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
  hp: honeypot,
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
    // Three-state, unlike the consent above. A paper form that predates the
    // media question was never asked it, and the filing manager must be able to
    // say so rather than pick a yes or a no on the signer's behalf. Omitted
    // means exactly that, so old bulk filings keep working unchanged.
    media_consent: z.boolean().nullish().default(null),
    emergency_contact_name: z.string().trim().min(1).max(120),
    // Optional here, unlike the online form: older paper forms did not ask for
    // it, and a manager must not have to invent one to file a real document.
    // Required for a minor, where it is the relationship to the participant on
    // the signed page (see the refine below).
    emergency_contact_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    emergency_contact_phone: z.string().trim().min(1).max(30),
    // The parent or legal guardian who signed a minor's form, when the paper
    // names one separately from the emergency contact. All optional, including
    // for a minor: a form filed from the club's old single-block layout has
    // only one person written on it, and `resolveWaiverContacts` treats that
    // person as the signer. Blank address/mobile/email mean "the same as the
    // participant's", exactly as on the online form.
    guardian_name: z.string().trim().max(120).optional().or(z.literal("")),
    guardian_relationship: z.string().trim().max(80).optional().or(z.literal("")),
    guardian_address: z.string().trim().max(300).optional().or(z.literal("")),
    guardian_phone: z.string().trim().max(30).optional().or(z.literal("")),
    guardian_email: z.string().trim().email().max(255).optional().or(z.literal("")),
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
      !isMinorOn(d.date_of_birth, d.signed_on) ||
      Boolean(d.guardian_relationship?.trim() || d.emergency_contact_relationship?.trim()),
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

/**
 * The club's "one month": how far ahead the purchase screen nudges an
 * insurance renewal and the manager dashboard pushes for a new membership
 * window. Always 30 days, never a calendar month.
 */
export const RENEWAL_WINDOW_DAYS = 30;

/** The lifecycle a person moves through as they join the club:
 * lead (registered interest only) -> applicant (signed the waiver) ->
 * visitor (waiver approved, trial assigned) -> member (active paid
 * membership), plus lapsed (had a trial/membership that ended, nothing
 * active). Always derived, never stored. */
export const lifecycleStatuses = ["lead", "applicant", "visitor", "member", "lapsed"] as const;
export type LifecycleStatus = (typeof lifecycleStatuses)[number];

/**
 * The states an enrollment record can be in.
 *
 * `active` means **authorised to train**, and says nothing about money: a
 * membership is authorised the moment it is raised, with its invoice
 * outstanding. Whether it has been paid for is `paid_at`, written only when a
 * payment is actually recorded (see `isUnpaid`).
 *
 * `pending` is no longer produced by anything. It survives here for rows created
 * before authorising and paying were separated, when it meant "raised, waiting
 * for money" — a meaning that now belongs to `paid_at` being null.
 */
export const membershipStatuses = ["pending", "active", "expired", "cancelled"] as const;
export type MembershipStatus = (typeof membershipStatuses)[number];

/**
 * Does the club still expect money for this membership?
 *
 * The single definition of "unpaid", used by the member's invoice list, the
 * reconciliation screen, the check-in warning and the delete guard, so those
 * four can never disagree about who owes what. It deliberately reads `paid_at`
 * and not `status`: status is about permission to train.
 *
 * A cancelled membership is owed nothing. A manager closed it, and chasing
 * somebody for an invoice that was withdrawn is worse than not chasing at all.
 */
export function isUnpaid(membership: {
  status: string;
  paid_at: string | null;
  price_cents: number;
}): boolean {
  // A free membership is never owed for. It has no invoice to settle, so it can
  // never be "unpaid" — and leaving that out of this rule was a real bug rather
  // than a nicety. `paid_at` is null on every free trial for ever (nothing
  // records a payment against $0), so without the price test a member who was
  // simply approved is billed on their own membership page, in perpetuity, for
  // something the club gave them. Two call sites had bolted `price_cents > 0`
  // on locally; three had not, which is exactly the drift a shared rule exists
  // to prevent.
  if (membership.price_cents === 0) return false;
  return membership.paid_at === null && membership.status !== "cancelled";
}

/**
 * Why a membership may not be deleted outright.
 *
 * Deleting is for tidying up something that should never have existed: a junk
 * invoice, or someone who said they would join and never paid. Three things mean
 * a row is a record of something that really happened, and a record is cancelled
 * rather than erased.
 */
export const membershipDeleteBlockers = ["paid", "attended"] as const;
export type MembershipDeleteBlocker = (typeof membershipDeleteBlockers)[number];

/** Why each blocker stops the delete, in the manager's terms. */
export const MEMBERSHIP_DELETE_REASONS: Record<MembershipDeleteBlocker, string> = {
  paid: "a payment is recorded against it",
  attended: "a class was checked in against it",
};

/**
 * Everything standing between this membership and deletion, all at once.
 *
 * All of them, never the first one found: a manager who clears one blocker only
 * to be refused by the next has been sent round the loop for nothing, and the
 * whole point of the delete guard is that it is obvious what to do instead.
 */
export function whyMembershipCannotBeDeleted(membership: {
  paid_at: string | null;
  checkin_count: number;
}): MembershipDeleteBlocker[] {
  const blockers: MembershipDeleteBlocker[] = [];
  // `paid_at` on its own is enough now, and used to need propping up with
  // `price_cents > 0`. It was written by every activation, including the $0 free
  // trial's, so it meant "somebody switched this on" rather than "money
  // arrived" — and a manager who authorised a member by hand could never delete
  // that row again. Only `recordMembershipPayment` writes it now, so it says
  // exactly what this blocker needs it to say.
  if (membership.paid_at) blockers.push("paid");
  if (membership.checkin_count > 0) blockers.push("attended");
  return blockers;
}

/**
 * The refusal a manager (or an agent) reads. Empty blockers means deletable.
 *
 * `paid` is the blocker nobody can clear, so it decides the advice on its own:
 * there is no sequence of steps that ends in a settled invoice being deleted,
 * and sending someone off to move check-ins first would be a wasted trip.
 */
export function membershipDeleteMessage(blockers: readonly MembershipDeleteBlocker[]): string {
  if (!blockers.length) return "";
  const reasons = blockers.map((b) => MEMBERSHIP_DELETE_REASONS[b]);
  const listed =
    reasons.length === 1
      ? reasons[0]
      : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;

  const advice = blockers.includes("paid")
    ? "Cancel it instead. That closes it and keeps the club's record of the money."
    : "To delete it, move those check-ins to another membership first.";
  return `This membership cannot be deleted because ${listed}. ${advice}`;
}

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

/**
 * True when the haystack (a bank-statement line) contains the reference as a
 * whole alphanumeric token, not merely as a substring. Splits the haystack on
 * non-alphanumeric boundaries and normalizes each token, so `MEMSMITHAB12` does
 * not match inside `MEMSMITHAB123`. Used for bundle matching where amount alone
 * cannot disambiguate. Slightly stricter than `matchesMembershipReference` —
 * a reference split by the member with spaces (e.g. "MEM SMITH AB12") will not
 * match, which is acceptable because false negatives are safer than false
 * positives in bundle grouping.
 */
export function haystackContainsRef(haystack: string, reference: string): boolean {
  const ref = normalizeRef(reference);
  if (!ref) return false;
  const tokens = (haystack || "").toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  return tokens.some((t) => normalizeRef(t) === ref);
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

/** Format a plan's `starts_on` (YYYY-MM-DD) as a compact window tag: "JUL26". */
export function planWindowTag(startsOn: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(startsOn.trim());
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1] ?? "";
  return `${month}${m[1].slice(2)}`;
}

/**
 * Build a member's bank transfer reference: compact, uppercase, alphanumeric,
 * <= 18 chars (the Australian pay-anyone limit). Stable per member.
 *   - undated plan (insurance/trial, or a dated plan with no tag needed):
 *     `MEM<SURNAME><CODE>`                                        e.g. MEMNGUYEN7Q
 *   - dated plan (windowStartsOn set): `MEM<SURNAME><CODE><WindowTag>`
 *     e.g. MEMNGUYEN7QJUL26 (keeps the MEM prefix -- unlike casual sessions,
 *     this still is not per-session; the tag only tells two dated plans apart
 *     when both have a pending invoice at once).
 *   - per-session (sessionDate set): `<SURNAME><CODE><Day><Mon>` e.g. NGUYEN7Q7DEC
 *     (no MEM prefix — the session date already identifies the payment).
 */
export function buildPaymentReference(
  surname: string,
  userId: string,
  sessionDate?: string,
  windowStartsOn?: string,
): string {
  const code = stableCode(userId);
  const datePart = sessionDate
    ? sessionDateTag(sessionDate)
    : windowStartsOn
      ? planWindowTag(windowStartsOn)
      : "";
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

// ---- A plan's own window ----

/** A plan's own duration, as read from `membership_plans` (or projected from it). */
export type PlanWindow = {
  starts_on: string | null; // YYYY-MM-DD
  ends_on: string | null; // YYYY-MM-DD, inclusive
  duration_days: number | null;
};

/** `dateStr` (YYYY-MM-DD) plus `days` calendar days, as a new YYYY-MM-DD string. */
function addCalendarDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The absolute instants a plan's membership runs for, resolved from the plan
 * alone — no second table to look up, and no branch on the plan's `kind`:
 *   - a dated plan (`starts_on`/`ends_on` set): 00:00 Australia/Sydney on
 *     `starts_on` through 23:59:59 Australia/Sydney on `ends_on` inclusive
 *     (one second before the next day's midnight, so the final evening's
 *     class is covered rather than cut off at UTC midnight). Every member who
 *     buys this plan gets exactly those instants, whenever in the window they
 *     join — there is no pro rata.
 *   - a rolling plan (`duration_days` set): `now` through `now + duration_days`
 *     (this is how yearly insurance has always worked).
 *   - neither: 00:00 Australia/Sydney on the day of `now`, and `ends_at` is
 *     null — the plan ends with its session credits instead of a date (the free
 *     trial, casual classes). The day grain matches the dated branch and keeps
 *     the row readable as "granted on this day"; nothing enforces it, since a
 *     credit balance is not date-gated at check-in (see `isOpenBalance` in
 *     src/lib/checkin.ts). Credits, not dates, are what limit these plans.
 * A plan never has both set (a DB CHECK enforces it), so these are exhaustive.
 */
export function planMembershipWindow(
  plan: PlanWindow,
  now: string,
): { starts_at: string; ends_at: string | null } {
  if (plan.starts_on && plan.ends_on) {
    const starts_at = zonedWallTimeToUtc(plan.starts_on, "00:00", CLUB_TIME_ZONE).toISOString();
    const nextDayMidnightMs = zonedWallTimeToUtc(
      addCalendarDays(plan.ends_on, 1),
      "00:00",
      CLUB_TIME_ZONE,
    ).getTime();
    const ends_at = new Date(nextDayMidnightMs - 1000).toISOString();
    return { starts_at, ends_at };
  }
  if (plan.duration_days) {
    const ends_at = new Date(
      new Date(now).getTime() + plan.duration_days * 86_400_000,
    ).toISOString();
    return { starts_at: now, ends_at };
  }
  const startOfDay = zonedWallTimeToUtc(
    clubLocalDate(new Date(now), CLUB_TIME_ZONE),
    "00:00",
    CLUB_TIME_ZONE,
  ).toISOString();
  return { starts_at: startOfDay, ends_at: null };
}

/**
 * The plans a member may buy right now: an undated plan (trial, casual,
 * insurance) is always sellable while active; a dated plan drops off on its
 * own once its `ends_on` has passed, with no manager step required to retire
 * it. There is no pro rata, so a still-sellable dated plan is exactly as good
 * a buy on its first day as its last.
 */
export function sellablePlans<T extends PlanWindow & { is_active: boolean }>(
  all: T[],
  now: string,
): T[] {
  const today = clubLocalDate(new Date(now), CLUB_TIME_ZONE);
  return all.filter((p) => p.is_active && (!p.ends_on || p.ends_on >= today));
}

// ---- Member: what is still owed ----

/** One thing on an unpaid invoice: a plan, and what it costs. */
export interface UnpaidInvoiceLine {
  membership_id: string;
  plan_name: string | null;
  price_cents: number;
}

/** An unpaid invoice: one transfer the member owes, whatever it is made of. */
export interface UnpaidInvoice {
  /** What the member quotes on the transfer. Also the group's identity. */
  reference: string;
  /** What to transfer: every line added up. */
  total_cents: number;
  lines: UnpaidInvoiceLine[];
}

/**
 * The transfers a member still owes, from their membership rows.
 *
 * Buying a plan that bundles yearly insurance writes TWO pending memberships
 * sharing ONE payment reference, because reconciliation has to activate them
 * together off a single transfer. So "pending memberships" and "invoices to pay"
 * are different counts, and only the second is a number to put in front of a
 * member: they owe one payment, and paying half of it against the same reference
 * would reconcile neither.
 *
 * Grouping by reference is what makes them agree, and it is the same sum the
 * invoice email already shows — the page and the email are two views of one
 * amount, so they must not compute it differently.
 *
 * Input order is preserved (`getMyMemberships` hands them over newest first).
 */
export function unpaidInvoices(
  memberships: readonly {
    id: string;
    status: string;
    paid_at: string | null;
    plan_name: string | null;
    price_cents: number;
    payment_reference: string;
  }[],
): UnpaidInvoice[] {
  const byReference = new Map<string, UnpaidInvoice>();
  for (const m of memberships) {
    if (!isUnpaid(m)) continue;
    const line = { membership_id: m.id, plan_name: m.plan_name, price_cents: m.price_cents };
    const existing = byReference.get(m.payment_reference);
    if (existing) {
      existing.lines.push(line);
      existing.total_cents += m.price_cents;
    } else {
      byReference.set(m.payment_reference, {
        reference: m.payment_reference,
        total_cents: m.price_cents,
        lines: [line],
      });
    }
  }
  return [...byReference.values()];
}

// ---- Member: yearly insurance selection on the purchase screen ----

/**
 * What the purchase screen does with the yearly insurance add-on, derived
 * from when the member's current cover ends (null = never had it):
 *
 * - `preselect`: tick the add-on when there is no ongoing cover, or the
 *   cover runs out within `daysAhead` days. Never tick it a year out.
 * - `canDeselect`: only a member whose cover is ongoing right now may untick
 *   it. Nobody trains uninsured, so with nothing active the tick is forced.
 *
 * "Ongoing" compares against `ends_at` alone; a pending insurance invoice is
 * not cover until it is paid. The server re-derives its own answer at
 * purchase time — this shapes the screen, never grants permission.
 */
export function insuranceSelection(input: {
  insuranceEndsAt: string | null;
  now: string;
  daysAhead?: number;
}): { preselect: boolean; canDeselect: boolean } {
  const days = input.daysAhead ?? RENEWAL_WINDOW_DAYS;
  const nowMs = new Date(input.now).getTime();
  const coverMs = input.insuranceEndsAt ? new Date(input.insuranceEndsAt).getTime() : null;
  const ongoing = coverMs !== null && coverMs > nowMs;
  const expiringSoon = coverMs !== null && coverMs <= nowMs + days * 86_400_000;
  return { preselect: !ongoing || expiringSoon, canDeselect: ongoing };
}

// ---- Manager: dashboard notifications ----

/**
 * One item on the manager dashboard's "needs attention" list. Deliberately
 * data-shaped, not copy-ready JSX: the pure functions below are what turn
 * club data into these, so tests pin the messages without rendering.
 */
export type ManagerNotification = {
  type:
    | "define_membership_window"
    | "unread_contact_messages"
    | "waivers_awaiting_approval"
    | "new_interest_registrations";
  title: string;
  body: string;
  href: string;
  /**
   * What the item's button says. Carried here rather than fixed in the
   * dashboard, because the right verb depends on the item: unset training dates
   * really do need fixing, an unanswered message needs reading. Required, not
   * optional-with-a-default, so adding a kind of notification cannot silently
   * inherit a verb that does not fit it.
   */
  actionLabel: string;
};

/**
 * The membership-window notifications: training is unsellable while no dated
 * plan is defined, and an expiring final one needs its successor set. Fires
 * when no active dated plan exists at all, or when the latest active one's
 * `ends_on` is within `daysAhead` days (by the club calendar). A defined
 * successor pushes `ends_on` past the horizon, so "nothing set after this
 * one" falls out of the rule on its own. Callers pass only the plans that
 * actually carry dates (`starts_on`/`ends_on` both set) — an undated plan
 * (trial, casual, insurance) never needs a successor.
 */
export function sellableWindowNotifications<
  T extends { starts_on: string; ends_on: string; is_active: boolean; name: string },
>(all: T[], now: string, daysAhead: number = RENEWAL_WINDOW_DAYS): ManagerNotification[] {
  const today = clubLocalDate(new Date(now), CLUB_TIME_ZONE);
  const horizon = addCalendarDays(today, daysAhead);
  const active = all
    .filter((s) => s.is_active)
    .sort((a, b) => (a.ends_on < b.ends_on ? -1 : a.ends_on > b.ends_on ? 1 : 0));
  if (active.length === 0) {
    return [
      {
        type: "define_membership_window",
        title: "Set up the club's training dates",
        body: "Members cannot join as members until the club's training dates are set. Add them now on the membership plans page.",
        href: "/manager/membership-plans",
        actionLabel: "Fix it",
      },
    ];
  }
  const latest = active[active.length - 1];
  if (latest.ends_on > horizon) return [];
  return [
    {
      type: "define_membership_window",
      title: `The training period ${latest.name} ends ${formatDateOnly(latest.ends_on)}`,
      body: "Nothing is defined after it, so enrolments stop when it ends. Set the club's next training dates on the membership plans page.",
      href: "/manager/membership-plans",
      actionLabel: "Fix it",
    },
  ];
}

/**
 * " on 06/08/2026" for a notification body, resolved to the CLUB's day rather
 * than the server's, or "" when the timestamp could not be read.
 *
 * These strings are built inside `listMyNotifications`, so they render on the
 * server (UTC) while the screen each one links to formats the same timestamp in
 * the manager's browser. Something at 9am Sydney is still the previous date in
 * UTC, so a plain `toLocaleDateString` had the two screens naming different days
 * for one message. `clubLocalDate` gives the `YYYY-MM-DD` the club was actually
 * on, which is exactly what `formatDateOnly` is for, and being pure it also
 * drops the dependency on the runtime having full ICU.
 */
function clubDaySuffix(at: string | null | undefined): string {
  return at ? ` on ${formatDateOnly(clubLocalDate(new Date(at), CLUB_TIME_ZONE))}` : "";
}

/**
 * Somebody's name for notification copy, or "Someone" when it is blank. Every
 * one of these counts degrades to a name-less count rather than failing the
 * whole attention list, so the copy has to survive having no name.
 */
function personOrSomeone(name: string | null | undefined): string {
  return name?.trim() || "Someone";
}

/**
 * The first step of signing up: somebody filled in the interest form. Read-only
 * on purpose. Nothing is broken and nothing is blocked, a manager just needs to
 * know who has come in, so the item carries a reading verb and no other action.
 *
 * Says nothing about the emails that go out on a registration. Those are
 * best-effort, and the whole existing backlog counts as new on the day this
 * ships, so "you were emailed this too" is false exactly when it matters.
 */
export function interestRegistrationNotifications(input: {
  unread: number;
  latestName?: string | null;
  latestAt?: string | null;
}): ManagerNotification[] {
  const { unread, latestName, latestAt } = input;
  if (unread <= 0) return [];
  const who = personOrSomeone(latestName);
  const when = clubDaySuffix(latestAt);
  return [
    {
      type: "new_interest_registrations",
      title:
        unread === 1
          ? `${who} registered interest in training`
          : `${unread} people registered interest in training`,
      body:
        unread === 1
          ? `They left their details${when}. Nothing has to happen yet, this is just so you know who has come in.`
          : `The most recent is ${who}${when}. Nothing has to happen yet, this is just so you know who has come in.`,
      // The whole funnel, one row per person, which is where a registration
      // ends up whether or not that person has moved on from being a lead. It
      // is also where the new-lead email already sends managers.
      href: "/manager/users",
      actionLabel: unread === 1 ? "Read it" : "Read them",
    },
  ];
}

/**
 * The second step of signing up: somebody signed the waiver and is waiting on a
 * manager. Unlike the two items above, this one is real work, and the body says
 * what pressing through to it leads to. Approving is outward-facing and cannot
 * be taken back quietly (it emails the person and unlocks their login), so the
 * consequence belongs in front of the manager before the click, not after it.
 *
 * "A first waiver" is doing real work in that sentence, not hedging.
 * `setWaiverApproval` lifts the ban and sends the account-activated email only
 * for somebody still locked, and `assignTrialMembership` is one per person ever,
 * so none of the three happens when a returning member re-signs. Stating them
 * flatly would promise a manager an email and a trial that never go out. The
 * plural line has to hold for a mixed batch too, which is the other reason it is
 * written as what approving a first waiver does rather than what this batch will
 * do.
 */
export function waiverApprovalNotifications(input: {
  pending: number;
  latestName?: string | null;
  latestAt?: string | null;
}): ManagerNotification[] {
  const { pending, latestName, latestAt } = input;
  if (pending <= 0) return [];
  const who = personOrSomeone(latestName);
  const when = clubDaySuffix(latestAt);
  const consequence =
    "Approving a first waiver activates that person's account, emails them to say so, and gives them the free trial.";
  return [
    {
      type: "waivers_awaiting_approval",
      title:
        pending === 1
          ? `${who} signed the waiver and is waiting for approval`
          : `${pending} signed waivers are waiting for approval`,
      body:
        pending === 1
          ? `They signed${when}. ${consequence}`
          : `The most recent is ${who}${when}. ${consequence}`,
      href: "/manager/waivers",
      actionLabel: pending === 1 ? "Approve" : "Approve them",
    },
  ];
}

/**
 * How many contact-form messages have arrived since a manager last opened the
 * inbox. `seenAt` is the club-wide marker (`club_settings.contact_messages_seen_at`);
 * absent means nobody has ever opened it, so everything counts — which is right
 * both on the day this ships and if the setting is ever cleared.
 *
 * Strictly newer than the marker: the marker is stamped at the moment the inbox
 * is opened, so a message bearing exactly that timestamp was on screen and has
 * been seen. Counting it would leave a badge that never clears.
 */
export function unreadSince<T extends { created_at: string }>(
  messages: T[],
  seenAt: string | null | undefined,
): T[] {
  if (!seenAt) return [...messages];
  return messages.filter((m) => m.created_at > seenAt);
}

/**
 * The dashboard's unanswered-message item. Empty when nothing is unread, so the
 * "needs attention" list stays quiet rather than reporting a zero.
 *
 * Unlike the membership-window notification this is not a fault to fix: somebody
 * is waiting on a reply, which is why it carries its own button verb.
 */
export function contactMessageNotifications(input: {
  unread: number;
  latestName?: string | null;
  latestAt?: string | null;
}): ManagerNotification[] {
  const { unread, latestName, latestAt } = input;
  if (unread <= 0) return [];
  const who = personOrSomeone(latestName);
  const when = clubDaySuffix(latestAt);
  return [
    {
      type: "unread_contact_messages",
      title:
        unread === 1
          ? `${who} sent a message through the contact form`
          : `${unread} unanswered messages from the contact form`,
      // Says nothing about emails. The obvious line here is "every manager was
      // emailed a copy too", and it is false exactly when it matters most: on
      // the day this shipped the whole existing backlog counted as unread, and
      // none of those messages was ever emailed to anyone. It is false again
      // whenever a send fails, since sending is best-effort by design.
      body:
        unread === 1
          ? `It arrived${when} and nobody has opened the inbox since.`
          : `The most recent is from ${who}${when}. None have been opened yet.`,
      href: "/manager/contact-messages",
      actionLabel: unread === 1 ? "Read it" : "Read them",
    },
  ];
}

/**
 * The order a manager meets the "needs attention" items in.
 *
 * Sorted by who is held up and for how long:
 *
 * 1. **Waiver approvals.** Somebody has signed and cannot start until a manager
 *    presses the button. They are stuck, and only this list says so.
 * 2. **Unanswered messages.** Somebody is waiting on a reply, but nothing about
 *    them is blocked in the meantime.
 * 3. **New interest registrations.** Nobody is waiting on anything. It is news,
 *    and it sits below the two items that are work.
 * 4. **The membership window.** A chore that announces itself weeks ahead.
 *
 * Kept as a function rather than an inline spread in the handler so the priority
 * is a decision with a test on it, not an accident of argument order.
 */
export function composeManagerNotifications(sources: {
  waiverApprovals: ManagerNotification[];
  contactMessages: ManagerNotification[];
  interestRegistrations: ManagerNotification[];
  membershipWindows: ManagerNotification[];
}): ManagerNotification[] {
  return [
    ...sources.waiverApprovals,
    ...sources.contactMessages,
    ...sources.interestRegistrations,
    ...sources.membershipWindows,
  ];
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
    // Whether to add the yearly insurance to this purchase (second invoice,
    // same payment reference). The server makes its own call from the
    // member's current cover — a member with none cannot turn this off.
    include_insurance: z.boolean().optional().default(false),
    hp: honeypot,
  })
  .refine((d) => !d.is_student || Boolean(d.uts_student_number && d.uts_student_number.trim()), {
    message: "A UTS student number is required to take the student rate.",
    path: ["uts_student_number"],
  });
export type StartMembershipInput = z.infer<typeof startMembershipSchema>;

// ---- Manager: create / edit a plan ----

/**
 * A plan's own window fields, on the save form: a fixed date range XOR a
 * rolling duration XOR neither (mirrors the `membership_plans` CHECK
 * constraints — see the `_membership_plans_own_dates` migration). `id`
 * absent means create a new plan; present means update that one. `code` is
 * still supplied by the caller (unlike the old per-semester upsert, a plan's
 * code is not derived from anything else), so adding a plan is exactly
 * "fill in the form" with no server-side derivation to keep in sync.
 */
export const savePlanSchema = z
  .object({
    id: z.string().uuid().optional(),
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      // Hyphens are permitted because the club's own dated plans use them:
      // the codes were copied from `club_semesters` ('2026-s1', '2026-s2'),
      // whose CHECK constraint mandated that form. Without hyphens here the
      // manager screen could not save those plans at all — it renders no Code
      // field, so it echoes the stored code back and the server rejected it.
      .regex(/^[a-z0-9_-]+$/, "Use lowercase letters, digits, underscores and hyphens only."),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional().or(z.literal("")),
    kind: z.enum(membershipPlanKinds),
    public_price_cents: z.number().int().min(0).max(1_000_000),
    student_price_cents: z.number().int().min(0).max(1_000_000).nullable(),
    duration_days: z.number().int().positive().max(3650).nullable(),
    session_credits: z.number().int().positive().max(1000).nullable(),
    is_active: z.boolean(),
    sort_order: z.number().int().min(0).max(1000),
    starts_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
      .nullable(),
    ends_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
      .nullable(),
  })
  .refine((d) => Boolean(d.starts_on) === Boolean(d.ends_on), {
    message: "Set both a start and an end date, or neither.",
    path: ["ends_on"],
  })
  .refine((d) => !d.starts_on || !d.ends_on || d.ends_on >= d.starts_on, {
    message: "End date must be on or after the start date.",
    path: ["ends_on"],
  })
  .refine((d) => !(d.starts_on && d.duration_days), {
    message: "A plan can't have both a date range and a rolling duration.",
    path: ["duration_days"],
  });
export type SavePlanInput = z.infer<typeof savePlanSchema>;

// ---- Manager: what kind of plan this is, and what that implies ----

/**
 * What a plan is, in a manager's words, and what that kind implies about the
 * rest of the form. One choice replaces the old "Kind" dropdown (raw enum
 * values) and the separate "Runs" picker: in practice the two always agreed,
 * and asking twice let them disagree.
 *
 * These live here rather than in the route so they are unit-testable without
 * rendering the screen (see CLAUDE.md, "Where to add tests") — the rules below
 * decide whether a plan can ever expire, which is worth pinning directly.
 */
export type PlanTypeSpec = {
  label: string;
  blurb: string;
  /** Which inputs the form shows for this kind. */
  dates: boolean;
  duration: boolean;
  credits: boolean;
  /**
   * Credits are the only thing that ends this kind, so a blank one is a plan
   * that never expires — not "unlimited". Only a dated kind can read a blank
   * as unlimited, because its dates still bound it.
   */
  creditsRequired: boolean;
  /** Applied over the previous kind's duration fields on switch. */
  defaults: { starts_on: null; ends_on: null; duration_days: number | null };
};

/** Keyed by kind, so adding one to the enum fails the typecheck here rather
 * than silently rendering no option for it. Listed in display order. */
export const PLAN_TYPES: Record<MembershipPlanKind, PlanTypeSpec> = {
  period: {
    label: "Training period",
    blurb: "Everyone who buys it trains between the same two dates.",
    dates: true,
    duration: false,
    credits: true,
    creditsRequired: false,
    defaults: { starts_on: null, ends_on: null, duration_days: null },
  },
  insurance: {
    label: "Yearly insurance",
    blurb: "Runs a set number of days from the day they pay.",
    dates: false,
    duration: true,
    credits: false,
    creditsRequired: false,
    defaults: { starts_on: null, ends_on: null, duration_days: 365 },
  },
  session: {
    label: "Casual class or class pack",
    blurb: "No end date. It ends when its classes run out.",
    dates: false,
    duration: false,
    credits: true,
    creditsRequired: true,
    defaults: { starts_on: null, ends_on: null, duration_days: null },
  },
  trial: {
    label: "Free trial",
    blurb: "The free introductory classes. One per person.",
    dates: false,
    duration: false,
    credits: true,
    creditsRequired: true,
    defaults: { starts_on: null, ends_on: null, duration_days: null },
  },
};

export const PLAN_TYPE_KINDS = Object.keys(PLAN_TYPES) as MembershipPlanKind[];

/** Falls back to `period` so a row carrying an unexpected kind still renders
 * an editable card instead of crashing the whole screen. */
export const planTypeOf = (kind: string): PlanTypeSpec =>
  PLAN_TYPES[kind as MembershipPlanKind] ?? PLAN_TYPES.period;

/**
 * Does a plan of this kind end by running out of classes rather than on a date?
 *
 * The free trial and a casual class or pack are sold as a NUMBER of classes:
 * nothing about them can go out of date, and the only thing that closes one is
 * spending the last credit. A training period and yearly insurance are the
 * opposite, sold as a stretch of time. `creditsRequired` already draws exactly
 * that line ("credits are the only thing that ends this kind"), so this reads it
 * rather than re-listing the kinds and giving them somewhere to disagree.
 *
 * Unknown or missing kinds answer `false`, which is the safe way round: a row
 * whose plan could not be resolved keeps the generic wording instead of claiming
 * a class count it may not have.
 */
export function endsWithCredits(kind: string | null | undefined): boolean {
  return kind ? (PLAN_TYPES[kind as MembershipPlanKind]?.creditsRequired ?? false) : false;
}

/** The fields whose meaning depends on the plan's kind. */
export type PlanShapeFields = {
  kind: string;
  starts_on: string | null;
  ends_on: string | null;
  duration_days: number | null;
  session_credits: number | null;
};

/** The full patch for switching a plan to `kind`: the new kind's duration
 * defaults, plus clearing session credits when the new kind has no use for
 * them (insurance never counts as mat time, so credits there are inert). */
export function planTypePatch(kind: MembershipPlanKind) {
  const spec = PLAN_TYPES[kind];
  return {
    kind,
    ...spec.defaults,
    ...(spec.credits ? {} : { session_credits: null }),
  };
}

/** Values stored on a plan whose own kind never reads them. Only reachable for
 * a row written by the manager agent API or by hand, but they would otherwise
 * be invisible on the screen and silently preserved on save. */
export function strandedPlanFields(p: PlanShapeFields): string[] {
  const spec = planTypeOf(p.kind);
  const out: string[] = [];
  if (!spec.dates && (p.starts_on || p.ends_on)) out.push("start and end dates");
  if (!spec.duration && p.duration_days) out.push("days from payment");
  if (!spec.credits && p.session_credits) out.push("session credits");
  return out;
}

/**
 * Whether this plan could ever end, phrased for a manager. `savePlanSchema`
 * permits a plan with no dates, no duration and no credits, but such a plan
 * activates to `ends_at: null` (`planMembershipWindow`) while still passing
 * `sellablePlans` — a membership that never expires. Worse, for a credit kind
 * `resolveCoverage` then matches no tier at all (`hasCredits` is false and the
 * `period` tier filters on kind), so the member is sold something that covers
 * no class and never lapses.
 *
 * The deleted generic `semester` plan was exactly this shape, and "Duplicate"
 * clears the dates on purpose, so it stays easy to recreate by accident.
 */
export function planShapeError(p: PlanShapeFields): string | null {
  const spec = planTypeOf(p.kind);
  if (spec.dates) {
    if (!p.starts_on || !p.ends_on) {
      return "A training period needs both a start and an end date.";
    }
    if (p.ends_on < p.starts_on) {
      return "End date must be on or after the start date.";
    }
  }
  if (spec.duration && !p.duration_days) {
    return "Set how many days it runs from payment.";
  }
  if (spec.creditsRequired && !p.session_credits) {
    return `Say how many classes a ${spec.label.toLowerCase()} includes. Left blank it would never run out, and it would cover no class either.`;
  }
  return null;
}

/** Whether two plans agree on every kind-dependent field. Lets the screen
 * accept an edit that leaves an already-malformed row no worse (renaming it,
 * or taking it off sale) instead of trapping a manager who cannot save the
 * one change that retires it. */
export function planShapeUnchanged(a: PlanShapeFields, b: PlanShapeFields): boolean {
  return (
    a.kind === b.kind &&
    a.starts_on === b.starts_on &&
    a.ends_on === b.ends_on &&
    a.duration_days === b.duration_days &&
    a.session_credits === b.session_credits
  );
}

/**
 * The editable half of a plan, as the manager screen holds it in state. Kept
 * structural (rather than importing `MembershipPlanRow`) so this module stays
 * free of the generated Supabase types; the row satisfies it, and so does the
 * "Add a plan" form once its price is known.
 */
export type PlanEditFields = {
  id?: string;
  code: string;
  name: string;
  description: string | null;
  kind: string;
  public_price_cents: number;
  student_price_cents: number | null;
  duration_days: number | null;
  session_credits: number | null;
  is_active: boolean;
  sort_order: number;
  starts_on: string | null;
  ends_on: string | null;
};

/**
 * Exactly what a save would send for this plan. The manager screen uses it for
 * both the request body and its "has anything changed?" check, so a greyed-out
 * Save button means precisely "the request would be identical" rather than an
 * approximation that can drift from the payload beside it.
 */
export function planEditPayload(p: PlanEditFields): SavePlanInput {
  return {
    ...(p.id ? { id: p.id } : {}),
    code: p.code,
    name: p.name,
    description: p.description || "",
    kind: p.kind as MembershipPlanKind,
    public_price_cents: p.public_price_cents,
    student_price_cents: p.student_price_cents,
    duration_days: finiteOrNull(p.duration_days),
    session_credits: finiteOrNull(p.session_credits),
    is_active: p.is_active,
    sort_order: p.sort_order,
    starts_on: p.starts_on,
    ends_on: p.ends_on,
  };
}

/** A numeric input parsed with `Number()` yields NaN on a typo ("1e"), and
 * `JSON.stringify(NaN)` is `null` — so without this an unparseable keystroke
 * both compares equal to a stored null (greying Save out with no explanation)
 * and, from a non-null baseline, silently wipes the stored value on save. */
const finiteOrNull = (n: number | null) => (n != null && Number.isFinite(n) ? n : null);

/** Whether saving `edited` would send anything different from `saved`.
 * Compares the serialised payloads, so a field the save does not carry (say
 * `created_at`) can never make a card look dirty. */
export function planEditsDiffer(edited: PlanEditFields, saved: PlanEditFields): boolean {
  return JSON.stringify(planEditPayload(edited)) !== JSON.stringify(planEditPayload(saved));
}

// ---- Manager: set a membership's status ----

export const setMembershipStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(membershipStatuses),
});
export type SetMembershipStatusInput = z.infer<typeof setMembershipStatusSchema>;

// ---- Manager: record a payment ----
//
// The counterpart to bank reconciliation, for money that never touches the club
// account: cash at the door, or a transfer settled some other way. It is the
// only manual writer of `paid_at`, and therefore the only manual way to make a
// membership undeletable.
//
// `payment_method` is asked for rather than assumed, because the club's record
// of HOW somebody paid is the thread back to the money when the books and the
// bank disagree.

export const markMembershipPaidSchema = z.object({
  id: z.string().uuid(),
  payment_method: z.enum(["bank_transfer", "stripe", "manual"]).default("manual"),
});
export type MarkMembershipPaidInput = z.infer<typeof markMembershipPaidSchema>;

// ---- Manager: delete a membership ----

export const deleteMembershipSchema = z.object({ id: z.string().uuid() });
export type DeleteMembershipInput = z.infer<typeof deleteMembershipSchema>;

// ---- Manager: raise a membership for somebody ----
//
// The manager's counterpart to `startMembershipSchema`. Two fields differ, and
// both are the difference between buying for yourself and recording an
// enrolment for someone else: `user_id` names who it is for, and `send_email`
// can be turned off so a backfill of something already settled does not invoice
// anyone. `include_insurance` is here for the same reason it is on the member
// schema, but a manager's answer is final — the server refuses a member who
// unticks it and has no cover, and does not refuse a manager.

export const createMembershipSchema = z.object({
  user_id: z.string().uuid(),
  plan_code: z.string().trim().min(1).max(64),
  uts_student_number: z.string().trim().max(32).nullable().optional(),
  session_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  include_insurance: z.boolean().optional().default(false),
  send_email: z.boolean().optional().default(true),
});
export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;

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

// ---- Manager agent API (see src/lib/manager-agent.ts + docs/manager-agent-api.md) ----
//
// A small HTTP surface a manager's AI agent can drive (via MCP or a skill). The
// action names below are the contract; keep them in sync with AGENT_MANIFEST in
// manager-agent.ts and the skill at .claude/skills/uts-manager-agent/.

/** Actions the manager agent endpoint accepts. Order mirrors AGENT_MANIFEST. */
export const managerAgentActions = [
  "list_users",
  "list_invoices",
  "create_membership",
  "edit_invoice",
  "mark_invoice_paid",
  "delete_invoice",
  "file_waiver",
  "list_waiver_templates",
  "get_waiver_template",
  "save_waiver_template",
  "publish_waiver_template",
  "list_membership_plans",
  "save_membership_plan",
  "list_kb_sections",
  "save_kb_section",
  "delete_kb_section",
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

/**
 * `delete_invoice` params. Deliberately just the id: unlike `edit_invoice`'s
 * paid guard there is no `confirm` to override with, because the three things
 * that block a delete (see `whyMembershipCannotBeDeleted`) are not a caller's
 * judgement call. A paid invoice is cancelled, never erased.
 */
export const deleteInvoiceSchema = z.object({ id: z.string().uuid() }).strict();
export type DeleteInvoiceInput = z.infer<typeof deleteInvoiceSchema>;

/**
 * `create_membership` params. Same shape the manager screen posts, minus
 * nothing: an agent raising somebody's invoice must be able to say what a
 * manager can say, including leaving the email off for a backfill.
 */
export const createInvoiceSchema = createMembershipSchema.strict();
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/**
 * `mark_invoice_paid` params. The manual counterpart to bank reconciliation,
 * for money that never touches the club account.
 *
 * `payment_method` defaults to `manual` rather than `bank_transfer`: a caller
 * reaching for this action is recording something the reconciler could not see,
 * and guessing "bank transfer" would put a claim in the club's books that the
 * statement will never back up.
 */
export const markInvoicePaidSchema = markMembershipPaidSchema.strict();
export type MarkInvoicePaidInput = z.infer<typeof markInvoicePaidSchema>;

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

// ---- Manager: club settings (the club's bank account) ----

/**
 * The free-text instructions this replaced. Still exported because the manager
 * settings screen shows whatever is left in the old `club_settings` row as a
 * read-only reference while the structured fields are empty, and that row was
 * seeded with a stub. Nothing member-facing renders it any more.
 */
export const DEFAULT_INVOICE_INSTRUCTIONS =
  "Pay by bank transfer to the club account. Please include your payment reference in the transfer description so we can match your payment automatically.";

/**
 * A BSB is six digits identifying an Australian bank branch. Stored as the six
 * digits alone so what a manager typed (with or without the hyphen) cannot
 * change what a member copies; `formatBsb` puts the hyphen back for display.
 */
const BSB_DIGITS = /^\d{6}$/;

/**
 * BIC, the same thing as a SWIFT code: 4 letters for the bank, 2 for the country
 * (ISO 3166-1), 2 alphanumeric for the location, and an optional 3 more for a
 * branch. That is why it is always 8 or 11 characters and never 9 or 10.
 *
 * This is the field an overseas sender actually needs. Australia does not use
 * IBAN, so there is nothing else to give them.
 */
const BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** `062000` -> `062-000`. How every Australian bank prints a BSB. */
export function formatBsb(bsb: string): string {
  const digits = bsb.replace(/\D/g, "");
  return BSB_DIGITS.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : bsb;
}

/**
 * The club's bank account, as a member needs to see it.
 *
 * The four account fields are required TOGETHER. A half-filled account is worse
 * than no account at all, because it looks payable: someone copies a BSB, finds
 * no account number, and either guesses or gives up having already been told
 * what they owe. So an incomplete set never parses, and the screens treat it
 * exactly as "not published yet".
 *
 * The overseas fields are each optional. They only ever add to a set of account
 * details that already works domestically, and a club that never takes an
 * overseas payment should not be blocked on filling them in.
 */
export const clubPaymentDetailsSchema = z.object({
  account_name: z.string().trim().min(1, "Add the account name.").max(120),
  bsb: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.string().regex(BSB_DIGITS, "A BSB is six digits, like 062-000.")),
  account_number: z
    .string()
    .transform((v) => v.replace(/\s/g, ""))
    .pipe(z.string().regex(/^\d{4,10}$/, "An account number is 4 to 10 digits.")),
  bank_name: z.string().trim().min(1, "Add the bank's name.").max(120),
  swift_bic: z
    .string()
    .trim()
    .toUpperCase()
    .regex(BIC, "A SWIFT/BIC code is 8 or 11 characters, like CTBAAU2S.")
    .or(z.literal(""))
    .default(""),
  bank_address: z.string().trim().max(200).default(""),
  account_holder_address: z.string().trim().max(200).default(""),
  note: z.string().trim().max(1000).default(""),
});
export type ClubPaymentDetails = z.infer<typeof clubPaymentDetailsSchema>;

/** The manager form posts exactly the details. */
export const saveClubSettingsSchema = clubPaymentDetailsSchema;
export type SaveClubSettingsInput = ClubPaymentDetails;

/**
 * The account rows, in the order a member reads them, shared by the membership
 * page and the invoice email so the two can never drift apart.
 *
 * Every one of them is a value somebody pastes into a banking app, so every one
 * gets a copy button. `copyLabel` is carried per field rather than built from
 * `label`, because it is the button's accessible name: seven buttons all called
 * "Copy" are unusable by voice or screen reader, and "Copy bsb" is what
 * lowercasing the label would produce.
 *
 * `mono` marks the fields that are strings of digits and letters to be
 * transcribed, where a monospace font makes a misread digit visible.
 */
export const CLUB_ACCOUNT_FIELDS = [
  { key: "account_name", label: "Account name", copyLabel: "Copy account name", mono: false },
  { key: "bsb", label: "BSB", copyLabel: "Copy BSB", mono: true },
  { key: "account_number", label: "Account number", copyLabel: "Copy account number", mono: true },
  { key: "bank_name", label: "Bank", copyLabel: "Copy bank name", mono: false },
] as const;

/** The same, for someone sending from outside Australia. */
export const CLUB_INTERNATIONAL_FIELDS = [
  { key: "swift_bic", label: "SWIFT/BIC", copyLabel: "Copy SWIFT/BIC", mono: true },
  { key: "bank_address", label: "Bank address", copyLabel: "Copy bank address", mono: false },
  {
    key: "account_holder_address",
    label: "Account holder address",
    copyLabel: "Copy account holder address",
    mono: false,
  },
] as const;

export type ClubPaymentFieldKey =
  | (typeof CLUB_ACCOUNT_FIELDS)[number]["key"]
  | (typeof CLUB_INTERNATIONAL_FIELDS)[number]["key"];

/**
 * The value to show and to copy for one field. Only the BSB differs from what is
 * stored, and it must differ in exactly one place or the hyphen ends up on
 * screen but not on the clipboard.
 */
export function clubPaymentFieldValue(
  details: ClubPaymentDetails,
  key: ClubPaymentFieldKey,
): string {
  return key === "bsb" ? formatBsb(details.bsb) : details[key];
}

/** True when there is at least one overseas field worth showing. */
export function hasInternationalDetails(details: ClubPaymentDetails): boolean {
  return CLUB_INTERNATIONAL_FIELDS.some((f) => details[f.key].trim().length > 0);
}

/**
 * Read the stored JSON blob back. Returns null for anything that is not a
 * complete set of account details: never written, half-written, hand-edited into
 * invalid JSON, or written by a future version with a rule this one fails.
 *
 * Null is not an error state to swallow — it is what the screens render the
 * "we have not published these yet" message from. Guessing at a partial blob
 * would put a wrong account number in front of someone about to transfer money,
 * which is the one outcome worth being strict about.
 */
export function parseClubPaymentDetails(raw: string | null): ClubPaymentDetails | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = clubPaymentDetailsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
  /** They hold a membership that had not begun when this class ran. */
  "not_started",
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
 * Manager: move an already-covered check-in onto a different membership.
 *
 * The sibling of `attachCheckInSchema`, for the row that is not uncovered. Here
 * `membership_id` is required rather than optional: re-running the door's own
 * precedence rules would just pick the same membership again, so the only
 * reason to move a check-in is that a manager has one specific membership in
 * mind. It is what clears a membership of the classes blocking its deletion.
 */
export const transferCheckInSchema = z.object({
  id: z.string().uuid(),
  membership_id: z.string().uuid(),
});
export type TransferCheckInInput = z.infer<typeof transferCheckInSchema>;

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

/**
 * Manager: delete a section.
 *
 * Only the slug, because deleting one is not a decision with options: the
 * articles filed under it are never deleted with it (`ON DELETE SET NULL`), so
 * there is no "and its articles" variant to offer.
 */
export const deleteKbSectionSchema = z.object({ slug: kbSlugSchema });
export type DeleteKbSectionInput = z.infer<typeof deleteKbSectionSchema>;

/**
 * A reader reaching the end of an article.
 *
 * Carries the version they actually read, not "the live one": those differ when
 * somebody published while the page was open, and recording the live number
 * would mark a member as having read wording they never saw — which is the one
 * thing that would make "updated since you read it" a lie.
 */
export const markKbArticleReadSchema = z.object({
  slug: kbSlugSchema,
  version: z.number().int().positive(),
});
export type MarkKbArticleReadInput = z.infer<typeof markKbArticleReadSchema>;

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
  hp: honeypot,
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
 * derives one from the title prefixed with today's date, `YYYY-MM-DD-...`
 * (`defaultBlogSlug` in `src/lib/slug.ts`) and resolves any collision by
 * appending `-2`, `-3`, etc.
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
  hp: honeypot,
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

// ---- Notifications ----
//
// The /notifications page and the email switches behind it. The kinds and the
// defaults live in `src/lib/notifications.ts` (pure, and imported by the email
// sender too); this file only validates what crosses the wire.

/** The four switches, as the settings UI sends them.
 *
 * Every key is optional and every value is `boolean | null`, which is the whole
 * point: `null` is a real, meaningful value here meaning "no longer a choice of
 * mine, use the club default", not an absent field. So this deliberately uses
 * `.nullable().optional()` rather than `.nullish()` — an absent key means
 * "leave that switch alone", the same convention `updateProfileSchema` uses,
 * and collapsing the two would make clearing a switch impossible to express. */
export const notificationPreferencesSchema = z.object({
  reply_to_me: z.boolean().nullable().optional(),
  thread_activity: z.boolean().nullable().optional(),
  new_blog_post: z.boolean().nullable().optional(),
  manager_comment_alerts: z.boolean().nullable().optional(),
});
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

// There is no second, token-carrying version of this schema any more. The
// signed-out settings page sends exactly the patch above: its token travels in
// a cookie set by /email-settings/<token>, never in the body, and the bounds
// that schema used to enforce are now on the cookie
// (src/lib/email-settings-session.ts).

/** Mark notifications read. An empty/absent list means "all of mine", which is
 * what the "Mark all as read" button sends; naming ids is what opening the page
 * sends, so a notification that arrived while the page was open is not marked
 * read without ever having been on screen. */
export const markNotificationsReadSchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
});
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

// ---- Account: the details a member maintains themselves ----

/**
 * The patch `/account` sends when somebody edits their own record.
 *
 * Every key is optional because the page saves one card at a time, and each
 * card sends only its own fields. An absent key means "leave it alone"; an
 * explicit `null` on a nullable field means "clear it". The handler tells the
 * two apart by checking for `undefined`, so nothing here may use `.nullish()`,
 * which would collapse the distinction.
 *
 * What is deliberately NOT here, and cannot be reached through it: the legal
 * name, date of birth, UTS student number, medical notes, the minor/guardian
 * fields, and the email. Those are either evidence a waiver froze, a thing that
 * changes what somebody pays, or the person's identity — see the note at the
 * foot of `routes/_authenticated/account.tsx`. String bounds mirror
 * `waiverSubmitSchema` field for field so the two write paths cannot disagree
 * about what fits in a column.
 */
export const updateMyProfileSchema = z
  .object({
    // `null` clears the override and reverts to the derived name
    // (`commentDisplayName`). `""` is rejected: blanking the box is expressed
    // as null by the caller, not as an empty string in the column.
    // Nullable below means "the member may clear this". Kit sizes and the two
    // names can be cleared, because an absent one is a real state the app renders
    // (a derived comment name, no size on file). The contact fields cannot: the
    // club has to be able to reach somebody and to call someone if they get
    // hurt, so those are editable but not erasable, which is also why the form
    // marks them required.
    display_name: z.string().trim().min(1).max(60).nullable().optional(),
    // Same shape as `display_name` above: `null` clears it, `""` is rejected,
    // so "no preferred name" has exactly one representation in the column.
    preferred_name: z.string().trim().min(1).max(60).nullable().optional(),
    phone: z.string().trim().min(1).max(30).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    sms_whatsapp_consent: z.boolean().optional(),
    // Deliberately NOT nullable, unlike the kit sizes and the two names. The
    // column's null means "the club has never asked this person", which stops
    // being true the moment they look at the control -- so a member can answer
    // yes or no, and only a manager can put a record back to unasked.
    media_consent: z.boolean().optional(),
    emergency_contact_name: z.string().trim().min(1).max(120).optional(),
    emergency_contact_relationship: z.string().trim().min(1).max(80).optional(),
    emergency_contact_phone: z.string().trim().min(1).max(30).optional(),
    gi_size: z.enum(giSizes).nullable().optional(),
    belt_size: z.enum(beltSizes).nullable().optional(),
  })
  // Unknown keys are an attempt to write a field this path does not own (a
  // legal name, a date of birth), not a harmless extra. Rejecting beats
  // stripping: a caller that thought it was saving `first_name` should hear
  // that it was not.
  .strict()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: "Nothing to update.",
  });
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;

/** Manager: correct somebody's kit sizes from their detail page. */
export const managerKitSizesSchema = z.object({
  userId: z.string().uuid(),
  gi_size: z.enum(giSizes).nullable(),
  belt_size: z.enum(beltSizes).nullable(),
});
export type ManagerKitSizesInput = z.infer<typeof managerKitSizesSchema>;
