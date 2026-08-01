---
name: uts-manager-agent
description: >-
  Perform UTS Jitsu manager actions (list members and their status, edit an
  invoice's details, file a scanned paper waiver) against the live site via its
  manager agent HTTP API. Use when a club manager asks an agent to look up
  members/invoices, correct invoice details (price, payment reference, notes,
  status), or migrate/bulk-file waivers the club holds on paper. Requires the
  UTS_MANAGER_API_URL and UTS_MANAGER_API_KEY environment variables.
---

# UTS Jitsu — manager agent

This skill drives the club's **manager agent API** — a small, token-authenticated
JSON endpoint that exposes a whitelisted set of manager actions. It is the
simplest way to let an agent act for a manager: no login flow, just a bearer
token and `curl`.

The server code lives at `src/routes/api/manager/agent.ts`; the endpoint is
**self-describing**, so treat the live manifest — not this file — as the source
of truth for the current action set.

## Configuration

- `UTS_MANAGER_API_URL` — the site's base URL, e.g. `https://jitsu.au`
- `UTS_MANAGER_API_KEY` — a manager agent token. A manager mints one at
  **`/manager/api-tokens`** on the site (it's shown once — copy it then). A
  server-side `MANAGER_AGENT_API_KEY` env var also works as a break-glass
  fallback.

The endpoint is `POST $UTS_MANAGER_API_URL/api/manager/agent`. Every request
sends `Authorization: Bearer $UTS_MANAGER_API_KEY`.

A helper is provided: `scripts/agent.sh <action> [json-params]`.

## First: read the manifest

Always fetch the manifest before acting so you use the current action set and
parameter names:

```bash
curl -s "$UTS_MANAGER_API_URL/api/manager/agent" \
  -H "Authorization: Bearer $UTS_MANAGER_API_KEY" | jq
```

## Actions

All actions are `POST` with a body of `{ "action": "<name>", "params": { ... } }`.
Responses are `{ "ok": true, "action", "result" }` or
`{ "ok": false, "error": { "code", "message" } }`.

### `list_users` — list everyone in the funnel

Returns everyone known to the club, one row per person, with their
`lifecycle_status` (`lead | applicant | visitor | member | lapsed`), `roles`,
`sessions_attended` (classes they have been checked in to, all-time — not the
same as credits left, which is on each invoice), and their `invoices` (each with
an `id` you can pass to `edit_invoice`). A `lead` (registered interest only) has
`user_id: null`, no invoices, and `sessions_attended: 0`.

> **Session counts: read the right one.** `sessions_attended` is **lifetime**
> attendance across every plan the person has ever held, so on a second plan it
> includes classes from the first and cannot answer "how much of this trial is
> left". Each invoice carries that: `sessions_allowed` (what the plan grants) and
> `sessions_remaining` (what is left on that invoice). Never parse the allowance
> out of a plan code like `trial_2_session` — the code is a label and can change.
>
> **`null` is not zero.** `sessions_allowed` is `null` only for a plan with no
> session credits at all (a period plan). `sessions_remaining` is _also_ `null`
> on a still-`pending` invoice for a session-credit plan, because activation is
> what sets it — there it means "not started yet", not "none left". Read
> `status`/`paid_at` alongside it before telling anyone they are out of classes.

`roles` is empty for a member on a **free** plan, including the trial: the
`member` role is granted on a _paid_ activation, so an active $0 invoice with
`roles: []` is correct, not a missed grant.

```bash
scripts/agent.sh list_users '{"status":"member","limit":50}'
# or raw:
curl -s "$UTS_MANAGER_API_URL/api/manager/agent" \
  -H "Authorization: Bearer $UTS_MANAGER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"action":"list_users","params":{"status":"member"}}' | jq
```

`params` (all optional): `status` (lifecycle filter), `limit` (1–500, default 200).

### `list_invoices` — find an invoice to edit

Flat list of invoices (membership payment records) with member name/email. The
response's `total` is the full matching count regardless of `limit`, so you can
tell a capped page from a complete one. Each invoice also carries
`sessions_allowed` and `sessions_remaining`, including what `null` means on each
(see the note under `list_users`).
`params` (optional): `status` (`pending | active | expired | cancelled`), `limit`.

```bash
scripts/agent.sh list_invoices '{"status":"pending"}'
```

### `edit_invoice` — correct an invoice's details

`params`: `id` (**required** — the invoice UUID from a list call) plus at least
one editable field: `price_cents` (integer cents), `notes` (pass `null` to clear
a mistaken note), `payment_reference`, `payment_method`
(`bank_transfer | stripe | manual`), `status` (`pending | cancelled | expired`).
Any other key is rejected, naming itself in the error — so a typo like `price`
doesn't get silently ignored. This includes the read-only fields a `list_*`
call decorates an invoice with (`plan_code`, `plan_name`, `price`, `is_student`,
`paid_at`, `starts_at`, `ends_at`, `created_at`, `member_name`,
`member_email`): send only `id` plus the field(s) you're actually changing,
never a listed invoice echoed back wholesale.

```bash
scripts/agent.sh edit_invoice '{"id":"<uuid>","price_cents":24500,"notes":"student rate applied"}'
```

The result is `{ invoice, changed, previous }`: `changed` lists the fields that
actually moved and `previous` holds what each one was, so you can report the
correction accurately and spot a no-op (a field resubmitted at the value it
already had comes back with `changed: []`). Every edit is written to the server
audit log with who made it and each field's old and new value.

> **You cannot set `status` to `active` here.** Activating a membership grants
> the member role and emails the member, so it must go through bank
> reconciliation / the manager UI — not a raw invoice edit.

> **A paid invoice's money fields are guarded.** Once an invoice has a `paid_at`,
> its `price_cents`, `payment_reference` and `payment_method` are the club's
> record of money that actually moved through the bank. Changing one is refused
> with `409 reconciled_invoice`, and the error names the `blocked` fields and
> their `previous` values. Re-send with `"confirm_paid_edit": true` if the
> correction is genuinely right (a real data-entry mistake). `notes` and `status`
> are not guarded: a note claims nothing about money, and expiring or cancelling
> a membership that ran its course is an ordinary lifecycle move.
>
> **The refusal is all-or-nothing.** An unguarded field sent in the same call
> (say `notes` alongside `price_cents`) is not written either. `error.previous`
> covers only the `blocked` fields, so it always lines up with `blocked` rather
> than listing everything the call would have changed.
>
> Ask the manager before overriding. "The price is wrong" and "the price was
> recorded wrong" are different problems, and only the second one is fixed here.

### `file_waiver` — file a scanned paper waiver (migration / bulk filing)

The agent equivalent of a manager using **Upload a paper waiver** on the site.
Files one waiver per call: attaches to the person with the given email (or
creates a locked applicant if that email is new to the club), stores the scan
as the waiver's PDF, and lands the row **pending**.

`params` mirror the web form exactly — see the live manifest for the full list,
but the shape is: `first_name`, `middle_name` (optional), `last_name`,
`preferred_name` (optional), `date_of_birth` (`YYYY-MM-DD`), `address`, `phone`,
`email`, `uts_student_number` (optional), `sms_whatsapp_consent` (optional,
default false), `emergency_contact_name`, `emergency_contact_relationship`
(required if the participant was under 18 on `signed_on`, else optional),
`emergency_contact_phone`, `medical_notes` (optional), `signed_on`
(`YYYY-MM-DD` — the date on the paper, not today), `template_version` (optional
int, or omit/null for a form you can't place), `scan`: an array of
`{ "name", "type", "data" }` (1–20 files, `type` is `application/pdf` |
`image/png` | `image/jpeg`, `data` is raw base64 with **no** `data:` prefix),
joined into one PDF in array order (10 MB decoded total per call), and
`confirm_duplicate` (optional, default false — see below).

```bash
scripts/agent.sh file_waiver '{
  "first_name": "Ada", "last_name": "Lovelace",
  "date_of_birth": "1990-12-10", "address": "1 Broadway, Ultimo NSW",
  "phone": "0400000000", "email": "ada@example.com",
  "emergency_contact_name": "Charles Babbage",
  "emergency_contact_phone": "0400000001",
  "signed_on": "2024-03-02",
  "scan": [{"name": "waiver.pdf", "type": "application/pdf", "data": "<base64>"}]
}'
```

> **Read before running a migration batch:**
>
> - **It never approves, emails, or verifies.** Filing is not approving:
>   approval is what promotes the record onto the person's profile, unlocks
>   their login, **emails them a sign-in link**, and **assigns the free trial**.
>   `file_waiver` does none of that — every row lands pending, exactly like a
>   manager's own upload. Approving hundreds of migrated people would email all
>   of them and hand out that many trials; that decision belongs to the manager
>   running the migration, made deliberately (through the site, one at a time or
>   with an explicit follow-up they've asked for), never as a side effect of
>   filing.
> - **A waiver's `email` is its identity key.** A typo creates a second person
>   instead of attaching to the right one — check each address against source
>   data before sending it, especially in a scripted loop.
> - **A PDF is mandatory.** If a source record has no scan/document behind it,
>   this action is not the right tool for it — that's a data-only record, not a
>   waiver.
> - **Filing order does not decide who looks active.** A person's active waiver
>   is whichever one was most recently _approved_, not most recently signed.
>   Filing (or later approving) a backlog out of chronological order can leave
>   an older submission looking like the current one — flag this to the manager
>   rather than approving on their behalf.
> - **Send a `client_submission_id` on every call in a batch.** Mint one UUID per
>   paper record and resend it unchanged on any retry of that record. It is what
>   makes retrying safe: the same id always resolves to the same waiver, so a
>   call whose reply you never saw (timeout, dropped connection) can simply be
>   repeated. Without it, two retries racing each other both pass the duplicate
>   check — neither can see a row the other has not committed yet — and you get
>   the exact double-filing the check is meant to stop. A **new** id means a new
>   waiver, so never reuse one across different records.
> - **Filing the same paper twice is caught.** If the person already has a
>   waiver signed on that `signed_on`, the call is refused with
>   `409 duplicate_waiver` and the error's `existing` array lists the waivers it
>   collided with (`id`, `approval_status`, `signed_on`), plus `truncated: true`
>   if there are more than 20. **A retried or duplicated import batch is the
>   reason this exists — do not paper over it with `confirm_duplicate`.** Stop,
>   work out how many of the batch already landed, and resume from there. Only
>   set `"confirm_duplicate": true` when the second document is real (a corrected
>   re-scan of the same signing date), and say so to the manager when you do.
> - **`503 duplicate_check_failed` means the check itself broke, not that the
>   waiver is a duplicate.** Nothing was filed. Retry the call as-is. Do **not**
>   reach for `confirm_duplicate` to get past it: that disables the check rather
>   than fixing it, and would let a genuine duplicate through.

## Guidance

- Confirm the target invoice with the manager (member name + amount) before an
  `edit_invoice` — it writes to live records.
- Before a `file_waiver` batch, confirm scope with the manager: how many
  records, whether any should be flagged for review rather than filed
  automatically, and that leaving everything pending (not approved) is what
  they want.
- On `ok: false`, read `error.code`/`error.message`; `invalid_params` responses
  include an `issues` array pointing at the offending field. `file_waiver`
  failures (an unreadable scan, a storage hiccup) come back as
  `file_waiver_failed` with a plain-English message.
- Two error codes carry extra fields and both mean "stop and confirm", never
  "retry with the flag set": `reconciled_invoice` (409, with `blocked`,
  `paid_at`, `previous`) and `duplicate_waiver` (409, with `existing`,
  `truncated`). Both have an override, and both overrides are the manager's
  call, not yours.
- `duplicate_check_failed` (503) is the opposite: a transient failure, safe and
  correct to retry unchanged. Nothing was filed. Retryable failures are 5xx;
  a 4xx means the request itself needs to change before it will ever succeed.
- The manifest's `version` tells generations apart (currently `"2"`), and its
  `changes` array says what each version actually moved, newest first. If you
  cached the manifest at the start of a long batch, read `changes` rather than
  diffing prose — it calls out the calls that used to succeed and now refuse.
