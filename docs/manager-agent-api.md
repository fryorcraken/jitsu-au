# Manager agent API

A small, token-authenticated HTTP endpoint that lets a manager's AI agent perform
a whitelisted set of manager actions against the live site. It is the "simplest
way to plug in an agent": a bearer token + JSON, wrappable as an MCP server or
driven directly by the bundled skill.

> Read this before changing `src/routes/api/manager/agent.ts`,
> `src/lib/manager-agent.ts`, or the agent schemas in `src/lib/validation.ts`.
> You do not need it for anything else.

- **Endpoint:** `src/routes/api/manager/agent.ts`
  - `GET  /api/manager/agent` → the self-describing **manifest** (the runtime
    source of truth for the current action set).
  - `POST /api/manager/agent` with `{ "action", "params" }` → dispatch.
- **Auth:** `Authorization: Bearer <token>`. Tokens are **manager-issued and
  revocable** — a manager mints them at `/manager/api-tokens` (route
  `_authenticated/manager.api-tokens.tsx`). Only a SHA-256 hash is stored
  (`manager_api_tokens` table); the raw token is shown once at creation. On each
  request the endpoint looks the token up by hash, confirms it isn't revoked, and
  re-checks the owner still holds the `manager` role. A `MANAGER_AGENT_API_KEY`
  env var is accepted as an **optional break-glass fallback** (e.g. bootstrap /
  CI); it is not required. The endpoint runs actions with the service-role
  client, so a token grants manager-level access to the exposed actions — treat
  it as a secret.
  - Token management server functions: `src/lib/manager-api-tokens.functions.ts`
    (`listApiTokens` / `createApiToken` / `revokeApiToken`); token crypto +
    the paste-able agent prompt: `src/lib/manager-api-tokens.ts`.
  - The `/manager/api-tokens` screen also renders a copy-paste **agent prompt**
    (`buildAgentPrompt`) for Claude Code / opencode / Cursor and points at the
    `uts-manager-agent` skill.

## Actions

An "invoice" is a `memberships` row — its price/reference/status _are_ the invoice.

- `list_users` — members and their lifecycle status, roles, and invoices.
- `list_invoices` — invoices with member name/email (to find an id to edit).
- `create_membership` — raise a **pending** invoice for a person, the agent's
  equivalent of the manager screen's "Add a membership" and of a member choosing
  a plan themselves. Dispatches to `createMembershipForUser` in
  `src/lib/membership.functions.ts`, the same function the screen posts to, so
  an agent-raised invoice and a manager's own are identical. A **priced** plan
  lands pending and does not activate: activation grants the member role and
  emails the member, so it stays the separate deliberate step it is everywhere
  else. A **free** plan (the trial) activates immediately, as it does for a
  member's own purchase — `activated` in the result says which happened. Two things it can do
  that a member's own purchase cannot, both for the same case — a manager
  writing down an enrolment that already happened: it accepts a plan that is no
  longer on sale (backfilling a past training period), and its
  `include_insurance` answer is final rather than enforced. `send_email: false`
  records the invoice without invoicing anybody for it. Re-raising the same
  person + plan reuses their existing unpaid invoice rather than creating a
  second one, so a retry is safe; the free trial is still once per person ever
  (`409 trial_already_used`), and an unknown plan code is `404 plan_not_found`.
- `edit_invoice` — correct an invoice's detail fields. Cannot set `status` to
  `active` (activation grants the member role + emails the member, so it runs
  through bank reconciliation, not a raw edit). Returns `changed` + `previous`
  alongside the updated invoice, and writes an audit line to the server log
  (`[agent.edit_invoice] audit`) naming the actor and each field's old → new.
  **On a paid invoice** (`paid_at` set) the money fields — `price_cents`,
  `payment_reference`, `payment_method` (`RECONCILED_GUARDED_FIELDS`) — are
  refused with `409 reconciled_invoice` unless `confirm_paid_edit` is passed:
  a reconciled invoice's amount is a record of money that moved, and the
  status it belongs to is already protected. `notes` and `status` stay freely
  editable (a note claims nothing about money; expiring a membership that ran
  its course is ordinary). There is **no audit table** — if the log is not
  enough for the club's bookkeeping, that is a schema change and a product
  decision, not something to add quietly. Setting `status` to `cancelled` or
  `expired` also reconciles the person's `member` role (`syncMemberRole`), so
  `list_users` stops calling somebody a member once their last paid membership
  closes. Members-only **access** was never gated on that role — it is gated
  live by the `has_active_paid_membership` SQL helper — so this corrects a label
  that used to be granted and never taken back, and changes nobody's access.
- `delete_invoice` — delete an invoice outright, for tidying up one that should
  never have existed. Dispatches to `deleteMembershipRow`, which the manager
  screens' Delete button also calls, so both refuse for the same reasons in the
  same words. Refused with `409 invoice_not_deletable` when a payment is
  recorded against it, when it is still `active`, or when a class was checked in
  against it; `error.details.blockers` lists **every** reason at once
  (`paid | active | attended`), because a caller that fixes one and retries into
  the next has burned two calls to learn what one could have told it. There is
  deliberately **no confirm flag**: unlike `edit_invoice`'s paid guard these are
  not a caller's judgement call, so a paid invoice is never deletable and is
  cancelled instead. The `attended` blocker exists because
  `session_checkins.membership_id` is `ON DELETE SET NULL` — without it the
  delete would succeed and silently turn a class somebody attended into an
  uncovered one. Clearing it means moving those check-ins to another membership,
  which is a **manager-screen action with no agent equivalent**: this API has no
  check-in actions at all, and adding the first one is a wider surface decision
  than the change that introduced this made on its own.
- `file_waiver` — file a scanned paper waiver (migration / bulk filing from
  paper records). Same params as the manager's paper-upload form
  (`paperWaiverUploadSchema`); dispatches to `filePaperWaiver` in
  `src/lib/waiver.functions.ts`, the same function the web form calls, so an
  agent-filed waiver and a manager's own upload are identical. Always lands
  **pending**: it never approves, emails anyone, or marks the email verified
  — approving is a separate, deliberate manager action because it promotes
  the record, unlocks the login, emails them that their account is active and
  assigns the free trial (docs/waivers.md rule 6). `uploaded_by` on the filed row is the
  token's owner, or the `AGENT_ENV_KEY_UPLOADER` sentinel for the break-glass
  env key, which has no owner to resolve. Filing a waiver the person already
  has for the same `signed_on` is refused with `409 duplicate_waiver` (the
  colliding rows come back in `error.existing`); `confirm_duplicate` files it
  anyway, for the corrected re-scan that is a genuine second document. The
  check lives in `filePaperWaiver`, so the manager's own upload form gets the
  same speed bump.

### `file_waiver`: the parts that have bitten us

- **The two surfaces present that one check differently on purpose, and
  this is not an inconsistency to tidy up.** The HTTP API returns
  `409 duplicate_waiver`, because a machine caller needs a distinct status
  to branch on. `uploadPaperWaiver` instead returns a `filed: false` result
  carrying the collision, so the screen can show the manager _what_ it hit
  and offer "file it anyway". A thrown error would reach the form as a
  toast with the detail lost, which is what makes the guard useless to a
  human.
- The check is **check-then-insert, so it cannot stop two racing retries**
  — neither sees a row the other has not committed. `client_submission_id`
  is what makes a retry safe: same key, same waiver, enforced by the partial
  unique index from `20260729020000`, exactly as the online signing path
  uses it. That index covers the WHOLE table, so the key namespace is shared
  with the public signing path — both lookups therefore ignore anything that
  is not a paper filing, or a caller-chosen id could resolve to a waiver a
  signer's browser minted. Scoping uniqueness per caller
  (`(uploaded_by, client_submission_id)`) would need a migration and is a
  deliberate follow-up, not an oversight.
- Comparing `signed_at` to the string this code WRITES never matches:
  PostgREST renders TIMESTAMPTZ as `+00:00` with no fractional part. Compare
  the date part. This killed the whole idempotency path once, and the test
  fixture hid it by using the write format.
- Sending a key **transfers an obligation**: a failed filing keeps its row
  for the retry instead of deleting it, so an abandoned attempt leaves a
  documentless waiver. `setWaiverApproval` refuses a waiver with no
  `pdf_path` so that row can never become somebody's ACTIVE record, and the
  manifest says the obligation exists.
- A failed probe is `503 duplicate_check_failed` with a `Retry-After`
  header, deliberately distinct from `file_waiver_failed` and deliberately
  silent about `confirm_duplicate` — offering that flag as the fix for an
  outage invites a retry policy to disable the guard wholesale. The 503 is
  documented as "nothing was filed, safe to retry unchanged", which is true
  only because the probe runs BEFORE `resolvePersonId`. Moving person
  creation above it would strand an auth user per retry, and no status-code
  test would notice.
- The probe matches a **UTC-day range**, not the midnight instant a paper
  filing writes, so it catches an online signature on the same day too. The
  club is UTC+10/+11, so a Sydney-morning signature falls on the previous
  UTC day — known and accepted, since widening to the club's own day would
  collide across two dates instead.
- `paperWaiverUploadSchema` is `.strict()`, matching `editInvoiceSchema`. A
  misspelled `confirm_duplicate` would otherwise be stripped by Zod, default
  to false, and return the same 409 forever while the message told the
  caller to do what they thought they just did.

## Agent glue

`.claude/skills/uts-manager-agent/` — a skill (with a `curl` helper) that
documents how to call the endpoint. An MCP wrapper is equally simple: one tool
per manifest action, forwarding to this endpoint.

## Keep these in sync

The action contract lives in **four** places — change all of them together, or
the agent glue drifts from the deployed API:

1. `src/lib/validation.ts` — `managerAgentActions` + the per-action Zod schemas.
2. `src/lib/manager-agent.ts` — `AGENT_MANIFEST` (self-description) + projections.
3. `src/routes/api/manager/agent.ts` — the request dispatch/handlers.
4. `.claude/skills/uts-manager-agent/SKILL.md` — the agent-facing docs.

`src/lib/manager-agent.test.ts` asserts the manifest matches `managerAgentActions`,
so a forgotten manifest update fails CI. The `GET` manifest is authoritative at
runtime: the skill instructs agents to read it before acting, so an MCP/skill
wrapper never needs hand-syncing beyond the human-readable docs above.

**Bump `AGENT_MANIFEST.version` whenever the behaviour a client can rely on
changes**, not only when an action is added or removed. A guard that starts
refusing a call that used to succeed, or a new field in a response, is exactly
what a client needs the version to tell it about. The version is pinned by a
test so the bump is a deliberate edit, and the current value is `"9"`.

**Responses carry `version` too**, not just the manifest, so a client that
cached the manifest at the start of a long run can notice a bump per call
instead of meeting it as an unexplained refusal. Error payload beyond
`code`/`message` is nested under `error.details` — never flat-merged, so the
envelope can grow a reserved key without shadowing a caller's field.

**There is no version pinning.** A caller cannot request the old behaviour; the
contract is latest-only. That is defensible for a single-tenant API with
manager-issued tokens where every caller is known, but it means `changes` is a
record of what already happened, not a negotiation — say so rather than letting
somebody build a client that expects to pin.

**Add a `changes` entry in the same edit**, with `breaking: true` when the
version turns a call that used to succeed into an error. A version number alone says only
that something moved; the client that most needs to know what is the one that
read the manifest at the start of a long import and cannot re-read it mid-run.
A test asserts the head of `changes` matches `version`, so the two cannot drift.
Call out anything that turns a previously-succeeding call into an error — that
is the note a caching client is actually reading for.
