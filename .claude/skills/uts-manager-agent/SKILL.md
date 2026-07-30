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
tell a capped page from a complete one.
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
doesn't get silently ignored.

```bash
scripts/agent.sh edit_invoice '{"id":"<uuid>","price_cents":24500,"notes":"student rate applied"}'
```

> **You cannot set `status` to `active` here.** Activating a membership grants
> the member role and emails the member, so it must go through bank
> reconciliation / the manager UI — not a raw invoice edit.

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
int, or omit/null for a form you can't place), and `scan`: an array of
`{ "name", "type", "data" }` (1–20 files, `type` is `application/pdf` |
`image/png` | `image/jpeg`, `data` is raw base64 with **no** `data:` prefix),
joined into one PDF in array order. 10 MB decoded total per call.

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
