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
  actions: AgentActionSpec[];
} = {
  service: "uts-jitsu-manager-agent",
  version: "1",
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
        "List invoices (membership payment records) with member name/email — useful to find an invoice id to edit.",
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
        "Correct an invoice's detail fields. Cannot set status to 'active' — activation grants the member role and emails the member, so it runs through bank reconciliation, not here.",
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
      ],
    },
    {
      name: "file_waiver",
      method: "POST",
      summary:
        "File a waiver from a scanned paper form — for migrating records the club already holds on paper, or any waiver signed outside the site. Same params as the manager's paper-upload form. Attaches to the person with this email, or creates one. Lands PENDING: it does not approve, email anyone, or mark the email verified — a separate edit_invoice-style approval step is a manager's own call, not this endpoint's. A person's ACTIVE waiver is their most recently APPROVED one, not most recently signed, so approving a backlog out of chronological order changes who looks active.",
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

/** A dispatch/auth failure carrying the HTTP status + a stable machine code. */
export class AgentError extends Error {
  code: string;
  httpStatus: number;
  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.httpStatus = httpStatus;
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
 */
export function buildInvoicePatch(input: EditInvoiceInput): Partial<MembershipRow> {
  const patch: Partial<MembershipRow> = {};
  if (input.price_cents !== undefined) patch.price_cents = input.price_cents;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.payment_reference !== undefined) patch.payment_reference = input.payment_reference;
  if (input.payment_method !== undefined) patch.payment_method = input.payment_method;
  if (input.status !== undefined) patch.status = input.status;
  return patch;
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
