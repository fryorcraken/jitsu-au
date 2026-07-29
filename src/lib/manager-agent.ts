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
        "List everyone in the club's funnel (leads, applicants, visitors, members) with their lifecycle status, roles, invoices, and how many classes they have attended (sessions_attended).",
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
        { name: "notes", required: false, description: "Free-text manager notes." },
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
  ],
};

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
    notes: m.notes,
    created_at: m.created_at,
  };
}
