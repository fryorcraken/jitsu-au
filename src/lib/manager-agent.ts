// Pure, server-import-free logic for the manager agent HTTP API.
//
// The endpoint (src/routes/api/manager/agent.ts) is the only place that touches
// the database; everything that can be unit-tested without a request/DB context
// lives here: the self-describing manifest, bearer-token handling, the
// invoice-edit patch builder, and the response projections.
//
// Keep AGENT_MANIFEST, managerAgentActions (validation.ts), the route dispatch,
// and the skill (.claude/skills/uts-manager-agent/) in lockstep — see AGENTS.md.
import { formatCents } from "@/lib/validation";
import type { EditInvoiceInput } from "@/lib/validation";
import type { MembershipPlanRow, MembershipRow } from "@/lib/membership-types";

/** One action's shape, returned verbatim by the GET manifest endpoint. */
export type AgentActionSpec = {
  name: string;
  method: "POST";
  summary: string;
  params: { name: string; required: boolean; description: string }[];
};

/**
 * The runtime source of truth for what the endpoint can do. An agent should GET
 * the endpoint to read this before acting, so a skill/MCP wrapper never drifts
 * from the deployed contract. When you add or change an action, update this,
 * the Zod schema in validation.ts, the route dispatch, and the skill.
 */
export const AGENT_MANIFEST: {
  service: string;
  version: string;
  changes: { version: string; breaking: boolean; notes: string[] }[];
  actions: AgentActionSpec[];
} = {
  service: "uts-jitsu-manager-agent",
  // Bumped when the behaviour a client can rely on changes, not just the action
  // list. See `changes` for what each version actually moved.
  version: "2",
  // What changed in each version, newest first.
  //
  // A bare version number tells a client THAT something moved, never what — and
  // the one client that most needs to know is the one that cached the manifest
  // at the start of a long bulk import and cannot re-read it mid-run. Diffing
  // whole manifest prose is not an answer.
  //
  // Deliberately a changelog and not a per-action `since` tag: every action here
  // existed in "1", so `since` would read "1" on all four and say nothing. What
  // moves between versions is the behaviour INSIDE an action — a new refusal, a
  // new response field — which is what these notes name.
  changes: [
    {
      version: "2",
      // A bare counter cannot say "this one can break you". Both refusals below
      // turn calls that used to succeed into errors, sitting next to additions
      // that harm nobody, and a client needs to tell "re-read when convenient"
      // from "stop now" without parsing prose.
      breaking: true,
      notes: [
        "edit_invoice: price_cents / payment_reference / payment_method on a PAID invoice are refused with 409 reconciled_invoice unless confirm_paid_edit is true. A call that used to succeed can now fail.",
        "edit_invoice: the result gained `changed` and `previous`.",
        "edit_invoice: an edit is refused with 409 invoice_changed if the invoice moved between the read and the write, so a `previous` you are shown is never stale.",
        "Every response now carries `version`, and error detail moved from the top of `error` into `error.details`.",
        "file_waiver: the duplicate check now matches ANY waiver signed on that UTC day, including one signed online, not only another paper filing.",
        "file_waiver: an unknown param is now a 400 rather than being silently dropped, so a misspelled confirm_duplicate cannot look like it was sent.",
        "file_waiver: a second waiver for the same person and signed_on is refused with 409 duplicate_waiver unless confirm_duplicate is true. A call that used to succeed can now fail.",
        "file_waiver: a failed duplicate check is 503 duplicate_check_failed; nothing was filed and the call is safe to retry unchanged.",
        "file_waiver: accepts client_submission_id, which makes a retry safe. Send one per record in any bulk import; the result's `created` says whether that call filed the waiver or replayed an earlier one.",
        "file_waiver: a half-filed waiver (scan not stored) is 503 waiver_filing_incomplete with Retry-After — the row is KEPT and only a retry with the same id completes it. An id bound to another record is 409 submission_id_conflict and will never succeed.",
        "file_waiver: client_submission_id draws from one namespace covering every waiver, paper and online, and every caller — not one scoped per token. It only ever resolves back to another paper filing, so a collision with an online signature is safe (409 submission_id_conflict), but two separate imports sharing the same id scheme can collide with each other. Prefer a random id per record.",
        "list_users / list_invoices: every invoice gained sessions_allowed and sessions_remaining.",
      ],
    },
    { version: "1", breaking: false, notes: ["First published action set."] },
  ],
  actions: [
    {
      name: "list_users",
      method: "POST",
      summary:
        "List everyone in the club's funnel (leads, applicants, visitors, members) with their lifecycle status, roles, invoices, and how many classes they have attended (sessions_attended, lifetime across all plans). Each invoice carries its own sessions_allowed (the plan's session credits, e.g. 2 for a trial_2_session plan) and sessions_remaining (this invoice's own live balance, spent one per check-in) — use those, not sessions_attended, to answer 'how much of this trial is left'. sessions_allowed is null for a plan with no session credits (e.g. a period plan); sessions_remaining is ALSO null for a still-pending invoice on a session-credit plan (it's set on activation) — null there means not started yet, not zero remaining.",
      params: [
        {
          name: "status",
          required: false,
          description: "Filter by lifecycle status: lead | applicant | visitor | member | lapsed.",
        },
        {
          name: "limit",
          required: false,
          description: "Max users to return (1-500, default 200).",
        },
      ],
    },
    {
      name: "list_invoices",
      method: "POST",
      summary:
        "List invoices (membership payment records) with member name/email — useful to find an invoice id to edit. Each carries sessions_allowed and sessions_remaining; read the list_users summary for what null means on each (they are not interchangeable with zero).",
      params: [
        {
          name: "status",
          required: false,
          description: "Filter by invoice status: pending | active | expired | cancelled.",
        },
        {
          name: "limit",
          required: false,
          description: "Max invoices to return (1-500, default 200).",
        },
      ],
    },
    {
      name: "edit_invoice",
      method: "POST",
      summary:
        "Correct an invoice's detail fields. Returns the updated invoice plus `changed` (the fields that actually moved) and `previous` (what they held before). Cannot set status to 'active' — activation grants the member role and emails the member, so it runs through bank reconciliation, not here. On an invoice that has been PAID (paid_at set), price_cents / payment_reference / payment_method describe money that already moved: they are refused with 409 reconciled_invoice unless confirm_paid_edit is true. A refusal is atomic — NOTHING is written, including any unguarded field sent in the same call — and `error.details.previous` covers only the `blocked` fields. Every edit is written to the server audit log (who, when, field, old -> new).",
      params: [
        { name: "id", required: true, description: "Invoice (membership) UUID." },
        { name: "price_cents", required: false, description: "Amount owed, integer cents." },
        {
          name: "notes",
          required: false,
          description: "Free-text manager notes. Pass null to clear it.",
        },
        {
          name: "payment_reference",
          required: false,
          description: "Bank-transfer reference the member should quote.",
        },
        {
          name: "payment_method",
          required: false,
          description: "bank_transfer | stripe | manual.",
        },
        { name: "status", required: false, description: "pending | cancelled | expired." },
        {
          name: "confirm_paid_edit",
          required: false,
          description:
            "Set true to allow price_cents / payment_reference / payment_method to be rewritten on an invoice that has already been paid. Not a field to write, and a no-op on an unpaid invoice.",
        },
      ],
    },
    {
      name: "file_waiver",
      method: "POST",
      summary:
        "File a waiver from a scanned paper form — for migrating records the club already holds on paper, or any waiver signed outside the site. Same params as the manager's paper-upload form. Attaches to the person with this email, or creates one. Lands PENDING: it does not approve, email anyone, or mark the email verified — a separate edit_invoice-style approval step is a manager's own call, not this endpoint's. A person's ACTIVE waiver is their most recently APPROVED one, not most recently signed, so approving a backlog out of chronological order changes who looks active. Refiling the same person + signed_on is refused with 409 duplicate_waiver (the existing waiver ids come back in `error.details.existing`, with `details.truncated` true if there are more than 20); pass confirm_duplicate to file it anyway. If the duplicate check itself fails, you get 503 duplicate_check_failed with a Retry-After header and NOTHING was filed — retry it, do not reach for confirm_duplicate. To make retries safe, send client_submission_id.",
      params: [
        { name: "first_name", required: true, description: "As written on the form." },
        { name: "middle_name", required: false, description: "As written on the form." },
        { name: "last_name", required: true, description: "As written on the form." },
        {
          name: "preferred_name",
          required: false,
          description: "What they go by, if different from first_name.",
        },
        { name: "date_of_birth", required: true, description: "YYYY-MM-DD." },
        { name: "address", required: true, description: "As written on the form." },
        { name: "phone", required: true, description: "As written on the form." },
        {
          name: "email",
          required: true,
          description:
            "Identifies the person: an address the club already knows attaches to that person, a new one creates one. A typo makes a second person.",
        },
        {
          name: "uts_student_number",
          required: false,
          description: "Non-empty unlocks the student rate.",
        },
        {
          name: "sms_whatsapp_consent",
          required: false,
          description: "Whether they ticked SMS/WhatsApp consent on the form. Default false.",
        },
        { name: "emergency_contact_name", required: true, description: "As written on the form." },
        {
          name: "emergency_contact_relationship",
          required: false,
          description:
            "Optional for an adult; REQUIRED if the participant was under 18 on signed_on, since that contact is the guardian who signed.",
        },
        {
          name: "emergency_contact_phone",
          required: true,
          description: "As written on the form.",
        },
        {
          name: "medical_notes",
          required: false,
          description: "Details of anything answered yes on the health declaration, if noted.",
        },
        {
          name: "signed_on",
          required: true,
          description:
            "YYYY-MM-DD, the date on the paper (not today). Determines minority and list ordering, not which waiver is active.",
        },
        {
          name: "template_version",
          required: false,
          description: "Which form version this is, if known. Null/omit for an unplaceable form.",
        },
        {
          name: "scan",
          required: true,
          description:
            "Array of { name, type, data }, 1-20 files, type is application/pdf | image/png | image/jpeg, data is raw base64 (no data: prefix). Joined into one PDF in array order. 10 MB decoded total across all files in this call.",
        },
        {
          name: "confirm_duplicate",
          required: false,
          description:
            "Set true to file even though this person already has a waiver signed on this date. Default false. Only use it when the second document is real (a corrected re-scan) — not to push a retried import past the check.",
        },
        {
          name: "client_submission_id",
          required: false,
          description:
            "Your own UUID for this filing attempt, minted once per record and RESENT UNCHANGED on every retry of it. This is what makes retrying safe: the same id always resolves to the same waiver, so a call whose reply you never saw can be repeated without filing twice. The duplicate check alone cannot catch two retries racing each other; this can. Send one per record in any bulk import. A new id means a new waiver, and an id already used for a different record is refused (409 submission_id_conflict). NOTE: sending an id means you own finishing that record — a filing that fails with 503 waiver_filing_incomplete leaves a waiver with no document, which only your retry completes.",
        },
      ],
    },
    {
      name: "list_documents",
      method: "POST",
      summary:
        "List the club's documents (versioned markdown pages served at /docs/<slug>) with their live version, visibility and whether they are taking comments.",
      params: [],
    },
    {
      name: "get_document",
      method: "POST",
      summary:
        "Read one document's full markdown. Returns the live version unless you name one. Read this before saving an edit: save_document replaces the whole body, so an edit built without reading first silently drops everything it did not include.",
      params: [
        { name: "slug", required: true, description: "The document's URL key, e.g. house-rules." },
        {
          name: "version",
          required: false,
          description: "Read a specific version instead of the live one.",
        },
      ],
    },
    {
      name: "save_document",
      method: "POST",
      summary:
        "Create or update a document. An unknown slug creates it; a known one adds a NEW version and publishes it — the body is replaced wholesale, never patched. Past versions are kept, and comments stay attached to the version they were written against, so readers whose comments predate this edit are shown that the wording moved on.",
      params: [
        {
          name: "slug",
          required: true,
          description:
            "URL key: lowercase letters, numbers and single hyphens (house-rules). A new slug creates a new document, so a typo makes a second one at a second URL.",
        },
        { name: "title", required: true, description: "Shown as the page heading." },
        {
          name: "body_md",
          required: true,
          description:
            "The whole document as markdown, up to 200000 characters. This REPLACES the previous body.",
        },
        {
          name: "visibility",
          required: false,
          description:
            "public | members | managers. Omit to leave it as it is; a new document defaults to members. 'managers' is the one to use for a draft.",
        },
        {
          name: "annotations_enabled",
          required: false,
          description:
            "Whether readers may comment. Omit to leave it as it is; new documents accept comments.",
        },
        {
          name: "change_note",
          required: false,
          description:
            "What changed, in your own words. Shown to readers whose comments were written against an earlier version.",
        },
        {
          name: "expect_new",
          required: false,
          description:
            "Set true when you believe the slug is free. The save is refused if it is not, instead of quietly adding a version to somebody else's document and patching its visibility to yours. Use it whenever you are creating rather than editing.",
        },
      ],
    },
    {
      name: "list_document_annotations",
      method: "POST",
      summary:
        "Read the SHARED comments on a document — what members said, in threads, with the passage each was about. Private notes are never returned: they are private from the club too, by design, so this is not a complete view of everything readers wrote.",
      params: [
        { name: "slug", required: true, description: "The document's URL key." },
        {
          name: "version",
          required: false,
          description: "Only comments written against this version.",
        },
        {
          name: "include_resolved",
          required: false,
          description: "Include resolved threads. Default false.",
        },
        {
          name: "limit",
          required: false,
          description: "Max comments to return (1-500, default 200).",
        },
      ],
    },
  ],
};

/**
 * The `uploaded_by` recorded on a waiver filed through the break-glass
 * `MANAGER_AGENT_API_KEY` fallback, which authenticates without resolving to
 * any real auth user. Not a UUID on purpose: `filePaperWaiver` only attempts
 * to look up an owner's email for values that look like one.
 */
export const AGENT_ENV_KEY_UPLOADER = "manager-agent-env-key";

/**
 * Classify a raw request body's `action` field before dispatch, distinguishing
 * an absent field from a present-but-invalid one — otherwise both report
 * "unknown_action" and a caller who built the body wrong (forgot the field
 * entirely) reads the same message as one who typo'd the action name.
 */
export function classifyAction(
  action: unknown,
  validActions: readonly string[],
):
  | { ok: true; action: string }
  | { ok: false; code: "missing_action" | "unknown_action"; message: string } {
  if (action === undefined || action === null) {
    return { ok: false, code: "missing_action", message: "Missing required field: action." };
  }
  if (typeof action !== "string" || !validActions.includes(action)) {
    return {
      ok: false,
      code: "unknown_action",
      message: `Unknown action. Valid actions: ${validActions.join(", ")}.`,
    };
  }
  return { ok: true, action };
}

/**
 * A dispatch/auth failure carrying the HTTP status + a stable machine code.
 *
 * `details` is merged into the response's `error` object for the failures where
 * a message alone leaves the caller stuck: a blocked duplicate names the waivers
 * it collided with, a blocked reconciled edit names the fields it refused.
 */
export class AgentError extends Error {
  code: string;
  httpStatus: number;
  details?: Record<string, unknown>;
  /** Emitted as a `Retry-After` header, for failures a client should repeat. */
  retryAfterSeconds?: number;
  constructor(
    httpStatus: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Constant-time string comparison for the API token: never early-exits on the
 * first differing byte, so it doesn't leak the token's length prefix by timing.
 * (The length itself is compared first — acceptable for a random opaque key.)
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull the token out of an `Authorization: Bearer <token>` header value. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** The membership columns `edit_invoice` may write (documented in the manifest). */
export const INVOICE_EDITABLE_FIELDS = [
  "price_cents",
  "notes",
  "payment_reference",
  "payment_method",
  "status",
] as const;

/**
 * Turn a validated edit_invoice input into a DB patch containing only the fields
 * the caller actually supplied (so unspecified columns are never overwritten).
 *
 * Takes a Partial rather than a whole `EditInvoiceInput`: this reads the five
 * editable fields and nothing else, so requiring `id` or the `confirm_paid_edit`
 * flag in the signature would only be asking callers for values it ignores.
 */
export function buildInvoicePatch(input: Partial<EditInvoiceInput>): Partial<MembershipRow> {
  const patch: Partial<MembershipRow> = {};
  if (input.price_cents !== undefined) patch.price_cents = input.price_cents;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.payment_reference !== undefined) patch.payment_reference = input.payment_reference;
  if (input.payment_method !== undefined) patch.payment_method = input.payment_method;
  if (input.status !== undefined) patch.status = input.status;
  return patch;
}

export type InvoiceEditableField = (typeof INVOICE_EDITABLE_FIELDS)[number];

/**
 * The subset of editable fields that record money which actually moved through
 * the bank. Once an invoice is paid, these are not "details" any more: they are
 * the club's account of a real transaction, and rewriting one silently makes
 * the books and the bank disagree with nothing to show what changed. Guarded on
 * a paid invoice — still editable, but only when the caller says so.
 *
 * `status` is deliberately NOT here. Expiring or cancelling a membership that
 * ran its course is an ordinary lifecycle move, not a rewrite of the payment,
 * and the one status that has consequences ("active") is already refused by the
 * schema. `notes` is free text about the invoice, never a claim about money.
 */
export const RECONCILED_GUARDED_FIELDS: readonly InvoiceEditableField[] = [
  "price_cents",
  "payment_reference",
  "payment_method",
];

/** What an edit would actually change, and what those fields hold right now. */
export type InvoiceEditDiff = {
  /** Editable fields whose value would genuinely move (a no-op edit is empty). */
  changed: InvoiceEditableField[];
  /** The pre-edit value of each changed field, keyed by field name. */
  previous: Partial<Record<InvoiceEditableField, unknown>>;
};

/**
 * Compare a patch against the row it is about to be written over. Submitting a
 * field with the value it already holds is not a change, so it neither trips the
 * reconciled guard nor shows up in the audit trail as an edit that happened.
 */
export function diffInvoicePatch(
  existing: Partial<Record<InvoiceEditableField, unknown>>,
  patch: Partial<Record<InvoiceEditableField, unknown>>,
): InvoiceEditDiff {
  const changed: InvoiceEditableField[] = [];
  const previous: Partial<Record<InvoiceEditableField, unknown>> = {};
  for (const field of INVOICE_EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const before = existing[field] ?? null;
    const after = patch[field] ?? null;
    if (before === after) continue;
    changed.push(field);
    previous[field] = before;
  }
  return { changed, previous };
}

/**
 * Which of an edit's changed fields the reconciled guard refuses. Empty for an
 * unpaid invoice (nothing has been reconciled yet), for an edit that only
 * touches unguarded fields, and when the caller has confirmed.
 */
export function reconciledEditBlockers(
  invoice: { paid_at: string | null },
  changed: readonly InvoiceEditableField[],
  confirmed: boolean | undefined,
): InvoiceEditableField[] {
  if (!invoice.paid_at || confirmed) return [];
  return changed.filter((f) => RECONCILED_GUARDED_FIELDS.includes(f));
}

/** The message a caller gets when the reconciled guard refuses their edit. */
export function reconciledEditMessage(blocked: readonly string[], paidAt: string): string {
  return (
    `This invoice was paid on ${paidAt}, so ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} a record of money that already moved. ` +
    "Send the edit again with confirm_paid_edit set to true if you mean to correct it anyway."
  );
}

/**
 * The audit record of an invoice edit: who changed what, from what, to what.
 * Written to the server log (there is no audit table) so a disagreement between
 * the books and the bank can be reconstructed rather than guessed at. Pure and
 * returned rather than logged here, so the shape is pinned by a test.
 */
export function invoiceEditAudit(opts: {
  invoiceId: string;
  actor: string;
  paidAt: string | null;
  confirmed: boolean | undefined;
  diff: InvoiceEditDiff;
  patch: Partial<Record<InvoiceEditableField, unknown>>;
  at: string;
}) {
  return {
    event: "invoice_edited",
    invoice_id: opts.invoiceId,
    actor: opts.actor,
    at: opts.at,
    reconciled: Boolean(opts.paidAt),
    // True only when the flag actually let a guarded field through. A caller
    // that sets confirm_paid_edit defensively on every call, then edits only
    // notes, has overridden nothing — and logging that as an override would put
    // false "someone rewrote the money record" entries in the very log the club
    // would reach for to reconstruct a books-versus-bank disagreement.
    overridden:
      Boolean(opts.paidAt) &&
      opts.confirmed === true &&
      opts.diff.changed.some((f) => RECONCILED_GUARDED_FIELDS.includes(f)),
    changes: opts.diff.changed.map((field) => ({
      field,
      from: opts.diff.previous[field] ?? null,
      to: opts.patch[field] ?? null,
    })),
  };
}

/** Client-safe projection of an invoice (membership) joined with its plan. */
export function projectInvoice(m: MembershipRow, plan?: MembershipPlanRow) {
  return {
    id: m.id,
    user_id: m.user_id,
    plan_code: plan?.code ?? null,
    plan_name: plan?.name ?? null,
    status: m.status,
    price_cents: m.price_cents,
    price: formatCents(m.price_cents),
    payment_reference: m.payment_reference,
    payment_method: m.payment_method,
    is_student: m.is_student,
    paid_at: m.paid_at,
    starts_at: m.starts_at,
    ends_at: m.ends_at,
    // The plan's session allowance and this invoice's own remaining balance —
    // set at activation (`activateMembershipRow`) and spent one-per-check-in
    // (see `checkin.functions.ts`). Deliberately per-invoice, not lifetime:
    // unlike `sessions_attended` on list_users (which counts all-time classes),
    // this is scoped to what THIS plan grants, so it answers "how much of this
    // trial/pack is left".
    // sessions_allowed is null only when the plan carries no session credits
    // (e.g. a period plan). sessions_remaining is ALSO null for a still-`pending`
    // invoice on a session-credit plan (e.g. a paid `casual_session` awaiting
    // bank transfer) — activation is what populates it, so null there means "not
    // started yet", not "no allowance". Read status/paid_at alongside it rather
    // than treating null as zero.
    sessions_allowed: plan?.session_credits ?? null,
    sessions_remaining: m.sessions_remaining,
    notes: m.notes,
    created_at: m.created_at,
  };
}
