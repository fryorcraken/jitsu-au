// Pure, server-import-free logic for the manager agent HTTP API.
//
// The endpoint (src/routes/api/manager/agent.ts) is the only place that touches
// the database; everything that can be unit-tested without a request/DB context
// lives here: the self-describing manifest, bearer-token handling, the
// invoice-edit patch builder, and the response projections.
//
// Keep AGENT_MANIFEST, managerAgentActions (validation.ts), the route dispatch,
// and the skill (.claude/skills/uts-manager-agent/) in lockstep. See docs/manager-agent-api.md.
import { formatCents } from "@/lib/validation";
import type { EditInvoiceInput } from "@/lib/validation";
import type { MembershipPlanRow, MembershipRow } from "@/lib/membership-types";

/** The columns `list_kb_articles` projects from. */
export type AgentKbArticle = {
  slug: string;
  nav_title: string | null;
  link_path: string | null;
  section_id: string | null;
  position: number;
  visibility: string;
  annotations_enabled: boolean;
  updated_at: string;
};

/** The live version of an article, when it has one. */
export type AgentKbVersion = {
  title: string;
  version: number;
  created_at: string;
  change_note: string | null;
};

/**
 * One row of `list_kb_articles`.
 *
 * `title` is always the LIVE VERSION's heading, never the sidebar label. That
 * distinction is the whole reason this is a function with a test: falling back
 * to `nav_title` makes an article's real heading unobtainable from the list, and
 * an agent that reads the list and builds a `save_kb_article` from what it read
 * would silently rename the heading to the sidebar label.
 *
 * A LINK ENTRY has no version, so there the label IS the title, and the null
 * `version` is what tells an agent it is looking at a signpost rather than a
 * page whose text it can edit.
 */
export function projectAgentKbArticle(
  article: AgentKbArticle,
  live: AgentKbVersion | undefined,
  sectionSlug: string | null,
  versions: number,
) {
  return {
    slug: article.slug,
    title: article.link_path ? article.nav_title : (live?.title ?? null),
    nav_title: article.nav_title,
    link_path: article.link_path,
    version: live?.version ?? null,
    versions,
    section: sectionSlug,
    position: article.position,
    visibility: article.visibility,
    annotations_enabled: article.annotations_enabled,
    url: article.link_path ?? `/kb/${article.slug}`,
    change_note: live?.change_note ?? null,
    updated_at: live?.created_at ?? article.updated_at,
  };
}

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
  version: "11",
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
      version: "11",
      // Five new optional fields on one action. Nothing that worked before
      // fails or means anything different, so a client that ignores them is
      // still correct -- it just files a minor's guardian less completely.
      breaking: false,
      notes: [
        "file_waiver takes the parent or legal guardian of a minor as their own person, separate from the emergency contact: guardian_name, guardian_relationship, guardian_address, guardian_phone and guardian_email, all optional. They are two people who may be the same one, not one person by definition, so a form that names the signer apart from the emergency contact can now be filed as it actually reads. Omit an address, mobile or email that is the participant's (the participant's is stored for the guardian too), and omit the lot for an older form with a single contact block, where that contact is still taken as the signer exactly as before.",
        "emergency_contact_relationship is still required for a minor, but guardian_relationship now satisfies that requirement instead, so a filing that gives the guardian's relationship and leaves the emergency contact's blank is accepted where it used to be refused.",
        "guardian_email is evidence on the waiver and is never used to identify anybody. The person record stays keyed on the participant's email, so a guardian_email the club has never seen does not create a second person.",
      ],
    },
    {
      version: "10",
      // Authorising a membership and paying for one used to be the same act.
      // Splitting them changes what `status` means and what `create_membership`
      // hands back, so a client that branched on either behaves differently.
      breaking: true,
      notes: [
        "A membership's `status` no longer says anything about money. `active` now means AUTHORISED TO TRAIN, and a membership is authorised the moment it is raised, with its invoice outstanding. Whether it has been paid for is `paid_at`, which is written only when a payment is actually recorded. Read `paid_at`, never `status`, to tell who owes the club money.",
        "`pending` is no longer produced by anything. Rows created before this still carry it and are unpaid in exactly the same way as any other unpaid row, so filter on `paid_at` rather than listing statuses.",
        "create_membership returns `authorised: true` in place of `activated`, and the membership it raises is already authorised whatever the plan costs. Its invoice is what is outstanding, and `reference` is non-null exactly when money is owed.",
        "New action mark_invoice_paid: record a payment against an invoice, for money that never touches the club account (cash at the door). It is idempotent — a second call on an already-paid invoice records nothing and re-sends nothing — and it emails the member a receipt. This is the manual counterpart to bank reconciliation, and it is what makes an invoice permanently undeletable.",
        "delete_invoice no longer refuses on `active`, because every membership is active now and that blocker would have made every delete a two-step. The remaining blockers are `paid` and `attended`. A call that used to be refused with `active` can now succeed.",
      ],
    },
    {
      version: "9",
      // Two new actions, and one existing action quietly doing more. Nothing
      // that worked before fails or means something different.
      breaking: false,
      notes: [
        "New action create_membership: raise a pending invoice for a person, the manager's counterpart to a member choosing a plan on the site. Unlike a member's own purchase it can use a plan that is no longer on sale (backfilling a past training period), its include_insurance answer is final rather than enforced, and send_email: false records the invoice without telling them about it. A priced plan always lands pending — activating it grants the member role and emails them, and stays a separate deliberate step. A FREE plan (the trial) activates immediately, exactly as it does when a member chooses it themselves; the result's `activated` says which happened.",
        "New action delete_invoice: delete an invoice outright. Refused with 409 invoice_not_deletable when a payment is recorded against it, it is still active, or a class was checked in against it; error.details.blockers lists every reason at once (paid | active | attended) so clearing one does not walk into the next. A paid invoice is never deletable — cancel it instead, via edit_invoice. Moving a check-in off a membership is UI-only for now, so an 'attended' blocker cannot be cleared through this API.",
        "edit_invoice: setting status to cancelled or expired now also reconciles the person's `member` role, so list_users stops reporting somebody as a member once their last paid membership closes. Members-only ACCESS was already gated live and is unaffected; this only corrects the label, which used to be granted and never taken back.",
      ],
    },
    {
      version: "8",
      // Purely additive: one new optional param on an existing action. Nothing
      // already working starts failing or means something different.
      breaking: false,
      notes: [
        "file_waiver: accepts media_consent, the same as sms_whatsapp_consent — true, false, or omitted if the paper form never asked about photo/video use. Omit rather than guessing; a false records a refusal the club never received.",
      ],
    },
    {
      version: "7",
      // A membership window is no longer a concept separate from the plan
      // that sells it: each dated training period is now its own
      // membership_plans row, carrying its own price, starts_on and ends_on.
      // The two actions that managed the old separate table are renamed with
      // no aliases, so any client that cached them 400s on unknown_action.
      breaking: true,
      notes: [
        "RENAMED, with no aliases: list_membership_windows -> list_membership_plans, save_membership_window -> save_membership_plan. list_membership_plans returns every plan the club sells (dated and undated alike), not just the club's training windows.",
        "save_membership_plan creates or updates a plan directly: code, name, price, kind, and either starts_on/ends_on (a fixed date range) or duration_days (a rolling window from payment) — never both. There is no year/half upsert key any more: code is supplied by the caller like any other plan field, and an unknown code creates a new plan.",
        "list_invoices / edit_invoice's returned invoice, and each invoice inside list_users, no longer carry semester_code / semester_name — the invoice's plan_name already names the period it was bought for (e.g. 'Semester 2 2026'), since a dated period is now a plan in its own right rather than a separate table an invoice points at.",
      ],
    },
    {
      version: "6",
      // The semester concept was folded into "membership windows" (the period
      // plan IS a windowed membership). Both semester actions were RENAMED with
      // no aliases, so any client that cached them 400s on unknown_action.
      breaking: true,
      notes: [
        "RENAMED, with no aliases: list_semesters -> list_membership_windows, save_semester -> save_membership_window. Same params, same response shape. The club's fixed training dates are now called membership windows: the period membership plan always runs exactly one chosen window.",
        "Purchases on the site may now bundle the yearly insurance as a second invoice sharing the same payment reference (insurance is mandatory when a member has no current cover). list_invoices / edit_invoice show such pairs the same way as any other two invoices sharing a reference.",
      ],
    },
    {
      version: "5",
      // Purely additive: two new actions, and a decorative field on existing
      // ones. Nothing already working starts failing or means something
      // different.
      breaking: false,
      notes: [
        "New actions list_semesters and save_semester. The `semester` membership plan now runs for a fixed, club-set semester date range instead of a rolling window from payment date; these actions manage the club's semester dates the same way list_kb_sections/save_kb_section manage the knowledge base's sections.",
        "list_invoices / edit_invoice's returned invoice, and each invoice inside list_users, now carry semester_code and semester_name — set when the invoice is for a semester-anchored plan, null otherwise.",
      ],
    },
    {
      version: "4",
      // `visibility: "public"` is now refused by the schema, so a client that
      // sends it on every save (rather than omitting it, as the guidance has
      // always said) starts failing. That is a 422, not a silent downgrade.
      breaking: true,
      notes: [
        "The knowledge base is signed-in only, reached from the member area. `visibility` lost its `public` level: it is now members | managers, and any article that was public is now members. Sending 'public' is refused.",
        "New action delete_kb_section. Deleting a section leaves its articles in place, in the 'Everything else' group, and reports how many were displaced.",
        "list_kb_articles is unchanged in shape, but no article can report visibility 'public' any more.",
      ],
    },
    {
      version: "3",
      // Every document action was renamed, so every call a cached client makes
      // to one of them now 400s on an unknown action. There is no aliasing and
      // no version pinning: this is the one bump where "re-read when convenient"
      // is wrong advice.
      breaking: true,
      notes: [
        "Club documents are now the knowledge base, served at /kb/<slug> rather than /docs/<slug>. The old paths are gone.",
        "RENAMED, with no aliases: list_documents -> list_kb_articles, get_document -> get_kb_article, save_document -> save_kb_article, list_document_annotations -> list_kb_comments. Calling an old name is a 400 unknown_action.",
        "Annotations report `article_version` where they used to report `document_version`.",
        "New actions list_kb_sections and save_kb_section. Articles now live in ordered sections, and that order is what members read through.",
        "save_kb_article: title and body_md are now OPTIONAL. Sending neither changes only the article's placement and writes NO new version; sending one without the other is refused. `version` in the result is null when no version was written.",
        "save_kb_article: accepts section, position, nav_title and link_path. An unknown section slug is refused rather than dropping the article out of the sidebar.",
        "save_kb_article: link_path makes the entry a sidebar LINK to another page on this site instead of an article. It needs a nav_title, refuses title/body_md, and an existing article that already has versions cannot be turned into one.",
      ],
    },
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
      name: "create_membership",
      method: "POST",
      summary:
        "Raise a membership for a person against a plan — the manager's counterpart to a member choosing a plan on the site. It is AUTHORISED immediately, whatever the plan costs: they can be checked in from that moment, with the invoice outstanding. Paying is a separate event (see mark_invoice_paid, or bank reconciliation); `reference` in the result is non-null exactly when money is owed, and carries what the member would quote on a transfer. Unlike a member's own purchase it accepts a plan that is no longer on sale, which is what backfilling a past training period needs. Re-raising the same person + plan reuses their existing UNPAID invoice rather than creating a second one, so a retry is safe. The free trial is still once per person, ever.",
      params: [
        {
          name: "user_id",
          required: true,
          description: "The person's user UUID, from list_users.",
        },
        {
          name: "plan_code",
          required: true,
          description: "Plan code from list_membership_plans. May be a plan no longer on sale.",
        },
        {
          name: "uts_student_number",
          required: false,
          description:
            "Their UTS student number. Its presence is what applies the student rate — there is no separate flag, and the price is computed server-side.",
        },
        {
          name: "session_date",
          required: false,
          description:
            "YYYY-MM-DD, for a casual class only, so the payment reconciles to that session. Defaults to today; ignored by every other plan kind.",
        },
        {
          name: "include_insurance",
          required: false,
          description:
            "Bundle yearly insurance as a second invoice on the same payment reference (default false). A member buying for themselves cannot decline this without current cover; a manager can, because recording an enrolment that really happened without cover is history, not a sale.",
        },
        {
          name: "send_email",
          required: false,
          description:
            "Email them the payment instructions (default true). Set false when backfilling something already settled, so nobody is invoiced for last semester.",
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
      name: "mark_invoice_paid",
      method: "POST",
      summary:
        "Record a payment against an invoice, for money that never touches the club account — cash at the door, or a transfer settled some other way. Bank reconciliation does this automatically when a statement line matches, so reach for this only when it cannot. It emails the member a receipt, and it is what makes the invoice permanently undeletable, so record it only once the money has actually arrived. Idempotent: a second call on an already-paid invoice records nothing, moves no date and sends no second receipt, and comes back with `recorded: false`. Refused on a free membership, which has nothing to pay.",
      params: [
        { name: "id", required: true, description: "Invoice (membership) UUID." },
        {
          name: "payment_method",
          required: false,
          description:
            "bank_transfer | stripe | manual. Defaults to manual, which is what an invoice the reconciler could not see almost always is — say bank_transfer only when a real transfer landed and you are recording it by hand.",
        },
      ],
    },
    {
      name: "delete_invoice",
      method: "POST",
      summary:
        "Delete an invoice outright, for tidying up one that should never have existed. Refused with 409 invoice_not_deletable when a payment is recorded against it, or when a class was checked in against it; error.details.blockers names EVERY reason at once (paid | attended) so clearing one does not walk into the next. Being active is NOT a blocker: every membership is authorised from the moment it is raised, so that would refuse everything. A paid invoice is never deletable and there is no confirm flag to force it — cancel it instead via edit_invoice, which closes it and keeps the club's record of the money. An 'attended' blocker is cleared by moving those check-ins to another membership, which is a manager-screen action and not available through this API.",
      params: [{ name: "id", required: true, description: "Invoice (membership) UUID." }],
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
        {
          name: "media_consent",
          required: false,
          description:
            "Whether they ticked photo/video consent on the form: true, false, or omitted if the form never asked. Omit rather than guessing — false records a refusal the club never received.",
        },
        { name: "emergency_contact_name", required: true, description: "As written on the form." },
        {
          name: "emergency_contact_relationship",
          required: false,
          description:
            "Optional for an adult; REQUIRED if the participant was under 18 on signed_on, unless guardian_relationship is given instead.",
        },
        {
          name: "emergency_contact_phone",
          required: true,
          description: "As written on the form.",
        },
        {
          name: "guardian_name",
          required: false,
          description:
            "The parent or legal guardian who signed a minor's form, when the paper names them separately from the emergency contact. Omit for an older form with only one contact block: that contact is then taken as the signer.",
        },
        {
          name: "guardian_relationship",
          required: false,
          description: "How the guardian is related to the participant, e.g. Mother, Father.",
        },
        {
          name: "guardian_address",
          required: false,
          description:
            "The guardian's address. Omit when it is the same as the participant's — the participant's is stored for them.",
        },
        {
          name: "guardian_phone",
          required: false,
          description: "The guardian's mobile. Omit when it is the participant's.",
        },
        {
          name: "guardian_email",
          required: false,
          description:
            "The guardian's email. Omit when it is the participant's. Never used to identify the person: the account is always keyed on the participant's email above.",
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
      name: "list_membership_plans",
      method: "POST",
      summary:
        "List every plan the club sells (trial, casual, each dated training period, yearly insurance), sorted for display. A dated plan (starts_on/ends_on both set) runs exactly those dates for anyone who buys it, full price regardless of when in it they join — there is no pro rata. A rolling plan (duration_days set, e.g. yearly insurance) runs that many days from payment. Neither set means the plan ends with its session credits instead of a date (trial, casual class). Includes inactive (retired) plans.",
      params: [],
    },
    {
      name: "save_membership_plan",
      method: "POST",
      summary:
        "Create or update a membership plan. Pass id to update an existing plan in place; omit it to create a new one. A plan may set starts_on/ends_on (a fixed date range) OR duration_days (a rolling window from payment) but never both — sending both is refused. Setting up a new training period is a new plan with its own price and dates, not a second date range on an existing one. NOTE: if the latest dated plan ends within 30 days and nothing is defined after it, the manager dashboard notifies managers — set the next one before then.",
      params: [
        {
          name: "id",
          required: false,
          description: "The plan's UUID, to update it. Omit to create a new plan.",
        },
        {
          name: "code",
          required: true,
          description:
            "Stable key, e.g. 'semester_2_2027'. Lowercase letters, digits and underscores only.",
        },
        { name: "name", required: true, description: "What members see, e.g. 'Semester 2 2027'." },
        { name: "description", required: false, description: "Shown under the plan's name." },
        {
          name: "kind",
          required: true,
          description: "insurance | trial | session | period.",
        },
        {
          name: "public_price_cents",
          required: true,
          description: "The general-public price, in integer cents.",
        },
        {
          name: "student_price_cents",
          required: false,
          description: "The UTS student price, in integer cents. Null/omit for no student rate.",
        },
        {
          name: "duration_days",
          required: false,
          description:
            "Rolling window: this many days from payment (e.g. 365 for yearly insurance). Mutually exclusive with starts_on/ends_on.",
        },
        {
          name: "session_credits",
          required: false,
          description: "Classes this plan grants (e.g. 2 for the free trial). Null for no credits.",
        },
        {
          name: "is_active",
          required: true,
          description: "Whether members can currently buy this plan.",
        },
        {
          name: "sort_order",
          required: true,
          description: "Lower sorts first on the member purchase screen.",
        },
        {
          name: "starts_on",
          required: false,
          description:
            "YYYY-MM-DD, the first day of training. Requires ends_on. Mutually exclusive with duration_days.",
        },
        {
          name: "ends_on",
          required: false,
          description:
            "YYYY-MM-DD, the LAST day of training (inclusive) — must be on or after starts_on. A membership bought for this plan covers this whole day.",
        },
      ],
    },
    {
      name: "list_kb_sections",
      method: "POST",
      summary:
        "List the knowledge base's sections in sidebar order. Sections are the groups a member reads through (Start here, Belts and grading, ...), and their order plus each article's position IS the onboarding path: the sidebar, the index page and the previous/next links all come from it.",
      params: [],
    },
    {
      name: "save_kb_section",
      method: "POST",
      summary:
        "Create a section, rename it, or move it in the sidebar. An unknown slug creates it. An omitted field is left alone, so moving a section cannot rename it by accident.",
      params: [
        {
          name: "slug",
          required: true,
          description:
            "URL key: lowercase letters, numbers and single hyphens (start-here). A new slug creates a new section.",
        },
        {
          name: "title",
          required: false,
          description: "The heading members see. Required when creating a section.",
        },
        {
          name: "position",
          required: false,
          description:
            "Lower sorts first. The seeded sections use 10, 20, 30 so a new one can be slotted between two others without renumbering anything.",
        },
      ],
    },
    {
      name: "delete_kb_section",
      method: "POST",
      summary:
        "Delete a section. Its articles are NOT deleted: they fall into the 'Everything else' group at the bottom of the sidebar, where a member can still find them, so this tidies the navigation rather than removing anything anyone reads. Reports how many articles it displaced.",
      params: [
        { name: "slug", required: true, description: "The section's URL key, e.g. start-here." },
      ],
    },
    {
      name: "list_kb_articles",
      method: "POST",
      summary:
        "List the knowledge base's articles (versioned markdown pages served at /kb/<slug>) with their live version, section, position, visibility and whether they are taking comments. An entry with a link_path is not an article but a sidebar LINK to a page elsewhere on the site, and it has no versions.",
      params: [],
    },
    {
      name: "get_kb_article",
      method: "POST",
      summary:
        "Read one article's full markdown. Returns the live version unless you name one. Read this before saving an edit: save_kb_article replaces the whole body, so an edit built without reading first silently drops everything it did not include.",
      params: [
        { name: "slug", required: true, description: "The article's URL key, e.g. our-history." },
        {
          name: "version",
          required: false,
          description: "Read a specific version instead of the live one.",
        },
      ],
    },
    {
      name: "save_kb_article",
      method: "POST",
      summary:
        "Create or update an article, or place it in the sidebar. Title + body_md write a NEW version and publish it — the body is replaced wholesale, never patched. Past versions are kept, and comments stay attached to the version they were written against, so readers whose comments predate this edit are shown that the wording moved on. Omit title and body_md to change only where the article sits, with no republish.",
      params: [
        {
          name: "slug",
          required: true,
          description:
            "URL key: lowercase letters, numbers and single hyphens (our-history). A new slug creates a new article, so a typo makes a second one at a second URL.",
        },
        {
          name: "title",
          required: false,
          description:
            "Shown as the page heading. Required with body_md when writing text; omit both to edit only the placement.",
        },
        {
          name: "body_md",
          required: false,
          description:
            "The whole article as markdown, up to 200000 characters. This REPLACES the previous body.",
        },
        {
          name: "section",
          required: false,
          description:
            "Slug of the section it belongs to. An unknown slug is refused rather than dropping the article out of the sidebar; send an empty string to move it into 'Everything else'. Omit to leave it where it is.",
        },
        {
          name: "position",
          required: false,
          description:
            "Lower sorts first within the section. This is the reading order a new member follows, so the first article of the first section is what 'start here' points at.",
        },
        {
          name: "nav_title",
          required: false,
          description:
            "A shorter label for the sidebar, when the title is long. Defaults to the title.",
        },
        {
          name: "link_path",
          required: false,
          description:
            "Makes this entry a LINK to a page elsewhere on this site (e.g. /first-class) instead of an article. Site-relative paths only, and it needs a nav_title since there is no article text to take a name from. Cannot be combined with title/body_md.",
        },
        {
          name: "visibility",
          required: false,
          description:
            "members | managers. Omit to leave it as it is; a new article defaults to members. 'managers' is the one to use for a draft. There is no public level: the whole knowledge base needs a login, so an article is either for the members or for the managers alone.",
        },
        {
          name: "annotations_enabled",
          required: false,
          description:
            "Whether readers may comment. Omit to leave it as it is; new articles accept comments and link entries never do.",
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
      name: "list_kb_comments",
      method: "POST",
      summary:
        "Read the SHARED comments on an article — what members said, in threads, with the passage each was about. Private notes are never returned: they are private from the club too, by design, so this is not a complete view of everything readers wrote.",
      params: [
        { name: "slug", required: true, description: "The article's URL key." },
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
