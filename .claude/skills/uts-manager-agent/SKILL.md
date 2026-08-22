---
name: uts-manager-agent
description: >-
  Perform UTS Jitsu manager actions (list members and their status, raise a
  membership for someone, cancel or delete an invoice, edit an invoice's
  details, file a scanned paper waiver, edit and publish the waiver template
  people sign, manage the club's membership dates, publish and reorder the
  club's knowledge base and read members' comments on it) against the live site
  via its manager agent HTTP API. Use when a club
  manager asks an agent to look up members/invoices, put a member on a plan or
  swap them onto a different one, cancel or delete a membership, correct invoice
  details (price, payment reference, notes, status), migrate/bulk-file waivers
  the club holds on paper, reword the waiver or its tick-boxes and publish a new
  version of it (or roll back to an earlier one), add or edit a membership
  window's start/end dates, or edit a
  knowledge base article at /kb/<slug>, change the order members read them in,
  and review the feedback left on them. Requires the UTS_MANAGER_API_URL and
  UTS_MANAGER_API_KEY environment variables.
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
Responses are `{ "ok": true, "version", "action", "result" }` or
`{ "ok": false, "version", "error": { "code", "message", "details"? } }`.

**`version` is on every response, not just the manifest.** Compare it against
the manifest you read at the start of a run: if it has moved, stop and re-read
rather than discovering the change as an unexplained refusal mid-import. Any
error payload beyond `code`/`message` lives under `error.details`.

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
> session credits at all (a period plan). `sessions_remaining` is `null` on a
> legacy `pending` row, where it means "not started yet" rather than "none left".
> Read `paid_at` alongside it before telling anyone they are out of classes.

> **`status` is not about money.** `active` means authorised to train, and every
> membership is authorised from the moment it is raised. `paid_at` is what says
> whether the club has been paid: null means the invoice is still outstanding.
> Filtering by `status` to find who owes money will find nobody.

`roles` is empty for a member on a **free** plan, including the trial: the
`member` role follows an active, priced, non-trial membership, so an active $0
invoice with `roles: []` is correct, not a missed grant.

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
To find unpaid invoices, filter the result on `paid_at` being null rather than by
status — see the note under `list_users`.

```bash
scripts/agent.sh list_invoices '{}'
```

### `create_membership` — raise a membership for somebody

The agent equivalent of a manager using **Add a membership** on a person's page,
and of a member choosing a plan themselves. The membership is authorised on the
spot and carries the payment reference they would quote on a transfer, so its
invoice reconciles off a bank statement like any other.

`params`: `user_id` (**required** — from `list_users`), `plan_code`
(**required** — from `list_membership_plans`), `uts_student_number` (optional),
`session_date` (optional `YYYY-MM-DD`, casual class only), `include_insurance`
(optional, default false), `send_email` (optional, default true).

```bash
scripts/agent.sh create_membership '{"user_id":"<uuid>","plan_code":"2026-s2"}'
```

> **It is authorised straight away, and that is not the same as paid.** Whatever
> the plan costs, the person can be checked in from the moment you raise it, with
> the invoice outstanding. Recording the money is a separate act
> (`mark_invoice_paid`, or bank reconciliation). `reference` in the result is
> non-null exactly when money is owed, and carries what the member would quote on
> a transfer; `authorised` is always true. With `send_email: false` no invoice
> email goes out.
>
> **Two things you can do here that a member cannot**, both for the same case —
> writing down an enrolment that already happened rather than selling one:
>
> - **A plan that is no longer on sale is accepted.** That is what backfilling a
>   past training period needs. It also means a typo in `plan_code` that happens
>   to match a retired plan will not be caught for you — check the code against
>   `list_membership_plans` before sending a batch. An unknown code is
>   `404 plan_not_found`.
> - **`include_insurance` is your answer, not a rule.** A member with no current
>   cover cannot decline it; you can. Only decline it when you are recording
>   something that genuinely happened without cover, and say so to the manager.
>
> **`send_email: false` is the backfill switch.** Left at its default, every
> invoice you raise emails that person their payment instructions. In a bulk
> import of settled history, that is an inbox full of demands for money already
> paid. Decide once, at the start of the batch, and tell the manager which way
> you went.
>
> **Retrying is safe.** Re-raising the same person and plan reuses their existing
> unpaid invoice rather than creating a second one (and does not re-send the
> email), so a call whose reply you never saw can simply be repeated. The free
> trial is still once per person ever: a second one is `409 trial_already_used`.

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
never a listed invoice echoed back wholesale. `plan_name` already names the
dated period an invoice is for (e.g. "Semester 2 2026", since each period is
its own plan — see `list_membership_plans` below); it is not editable here
(moving one person's dates is a plan correction, not an invoice edit).

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

> **Cancelling is how a membership is closed**, and it is safe from any status.
> Closing somebody's last membership also stops `list_users` calling them a
> member, and closes their members-only access at the same moment — that is gated
> on holding an active membership, never on the role.
>
> **`status` says nothing about money.** `active` means authorised to train, and
> every membership is authorised from the moment it is raised. To tell who owes
> the club money, read `paid_at`: null means unpaid. Rows created before this
> distinction existed still say `pending` and are unpaid in exactly the same way,
> so filter on `paid_at` rather than listing statuses.

> **A paid invoice's money fields are guarded.** Once an invoice has a `paid_at`,
> its `price_cents`, `payment_reference` and `payment_method` are the club's
> record of money that actually moved through the bank. Changing one is refused
> with `409 reconciled_invoice`, and `error.details` names the `blocked` fields
> and their `previous` values. Re-send with `"confirm_paid_edit": true` if the
> correction is genuinely right (a real data-entry mistake). `notes` and `status`
> are not guarded: a note claims nothing about money, and expiring or cancelling
> a membership that ran its course is an ordinary lifecycle move.
>
> **The refusal is all-or-nothing.** An unguarded field sent in the same call
> (say `notes` alongside `price_cents`) is not written either.
> `error.details.previous` covers only the `blocked` fields, so it always lines
> up with `blocked` rather than listing everything the call would have changed.
>
> **`409 invoice_changed` means somebody else got there first.** The edit is
> checked against the invoice as read, and refused if any field it would change
> moved in between — so a `previous` you are shown is never stale. Re-read the
> invoice and decide whether the edit still applies. Do not blind-retry: you
> would be racing the same writer again.
>
> Ask the manager before overriding. "The price is wrong" and "the price was
> recorded wrong" are different problems, and only the second one is fixed here.

### `mark_invoice_paid` — record money that arrived

`params`: `id` (**required** — the invoice UUID from a list call),
`payment_method` (optional: `bank_transfer | stripe | manual`, default `manual`).

```bash
scripts/agent.sh mark_invoice_paid '{"id":"<uuid>"}'
```

Bank reconciliation records payments on its own when a statement line matches, so
reach for this only when it cannot: cash at the door, or a transfer settled some
other way.

> **This is the one-way door.** It emails the member a receipt, and an invoice
> with a payment against it can be cancelled but **never deleted**. Record it
> only once the money has actually arrived. If you are marking something paid
> because a manager said so rather than because you saw it land, say so back to
> them.
>
> **Retrying is safe.** A second call on an already-paid invoice records nothing,
> moves no date and sends no second receipt — it comes back `recorded: false`,
> which is also how you tell a real recording from a replay. Count those
> separately when you report a batch.
>
> **`payment_method` defaults to `manual` on purpose.** Saying `bank_transfer`
> puts a claim in the club's books that the bank statement will never back up.
> Use it only when a real transfer landed and you are recording it by hand.
>
> A free membership has nothing to pay, so it is refused with
> `422 nothing_to_pay`.

### `delete_invoice` — remove an invoice that should never have existed

`params`: `id` (**required** — the invoice UUID from a list call).

```bash
scripts/agent.sh delete_invoice '{"id":"<uuid>"}'
```

Deleting is for tidying up junk: a duplicate raised by mistake, or somebody who
said they would join and never paid. Everything else is **cancelled**, which
closes the membership and keeps the record (`edit_invoice` with
`"status":"cancelled"`).

> **Two things refuse it, and you get both at once.**
> `409 invoice_not_deletable`, with `error.details.blockers` naming every reason
> that applies out of `paid | attended`. Fixing one and retrying into the next
> would cost you a call to learn what the first refusal already told you, so read
> the whole list.
>
> - **`paid`** — a payment is recorded against it. **There is no confirm flag,
>   and there will not be one.** Unlike `edit_invoice`'s paid guard this is not
>   a judgement call you can override: a paid invoice is the club's record that
>   money moved. Cancel it instead.
> - **`attended`** — a class was checked in against it. **You cannot clear this
>   one.** It is cleared by moving those check-ins to another membership, which
>   is a manager-screen action; this API has no check-in actions. Tell the
>   manager what is blocking it and leave it to them.
>
> Being **active is not a blocker**. Every membership is authorised from the
> moment it is raised, so there is nothing to cancel first.
>
> **Deleting is not reversible and there is no undo.** If you are unsure whether
> a row is junk or history, cancel it and say why — a cancelled invoice can be
> re-activated, a deleted one cannot be anything.

### `list_membership_plans` / `save_membership_plan` — the plan catalogue

A plan is what the club sells, and it carries everything about itself: name,
price, and how it runs. A **dated** plan (`starts_on`/`ends_on` both set) runs
exactly those dates for anyone who buys it, full price regardless of when in
it they join — there is no pro rata. A **rolling** plan (`duration_days` set,
e.g. yearly insurance) runs that many days from payment. Neither set means the
plan ends with its session credits instead of a date (the free trial, casual
class). Each dated training period is its **own plan row** — "Semester 2 2026"
and "Semester 1 2027" are two plans, each with its own price — not a shared
plan pointing at a separate table of windows.

```bash
scripts/agent.sh list_membership_plans '{}'
```

Returns every plan (including inactive/retired ones), each with `id`, `code`,
`name`, `description`, `kind`, `public_price_cents`, `student_price_cents`,
`duration_days`, `session_credits`, `is_active`, `sort_order`, `starts_on`,
`ends_on`.

```bash
scripts/agent.sh save_membership_plan '{
  "code": "semester_1_2027", "name": "Semester 1 2027",
  "kind": "period", "public_price_cents": 46000, "student_price_cents": 25500,
  "duration_days": null, "session_credits": null, "is_active": true, "sort_order": 2,
  "starts_on": "2027-02-01", "ends_on": "2027-06-26"
}'
```

Pass `id` to update an existing plan in place; omit it to create a new one.
`starts_on`/`ends_on` and `duration_days` are mutually exclusive — sending both
is refused. Setting up a new training period is a new plan with its own price
and dates, not a second date range on an existing one.

> [!TIP]
> Add next year's plan before enrolments open for it, and check
> `list_membership_plans` shows exactly the dated plans a member could be
> buying into at any moment. There is no overlap check across plans (unlike
> the old separate windows table) — a plan whose dates overlap another's is a
> product decision a manager can make deliberately (e.g. running two prices
> side by side briefly), not an error.

### `file_waiver` — file a scanned paper waiver (migration / bulk filing)

The agent equivalent of a manager using **Upload a paper waiver** on the site.
Files one waiver per call: attaches to the person with the given email (or
creates a locked applicant if that email is new to the club), stores the scan
as the waiver's PDF, and lands the row **pending**.

`params` mirror the web form exactly — see the live manifest for the full list,
but the shape is: `first_name`, `middle_name` (optional), `last_name`,
`preferred_name` (optional), `date_of_birth` (`YYYY-MM-DD`), `address`, `phone`,
`email`, `uts_student_number` (optional), `sms_whatsapp_consent` (optional,
default false), `media_consent` (optional tri-state: `true`, `false`, or omit
when the form has no photo/video consent box — omit rather than guessing, since
`false` records a refusal the club never received),
`emergency_contact_name`, `emergency_contact_relationship`
(required if the participant was under 18 on `signed_on`, else optional),
`emergency_contact_phone`, the guardian of a minor when the paper names one
apart from the emergency contact (`guardian_name`, `guardian_relationship`,
`guardian_address`, `guardian_phone`, `guardian_email` — all optional; omit an
address/mobile/email that is the participant's, and omit the lot for an older
form with a single contact block, where that contact is taken as the signer),
`medical_notes` (optional), `signed_on`
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
>   their login, **emails them that their account is active**, and **assigns
>   the free trial**.
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
>   waiver, so never reuse one across different records — an id already bound to
>   a different record is refused with `409 submission_id_conflict`, which no
>   retry will ever fix.
> - **The id space is global, not per token.** Every `client_submission_id` you
>   mint — including the club's own online waiver signing — draws from one
>   namespace covering the whole `waivers` table, not one scoped to your
>   import or your token. `file_waiver` only ever resolves an id back to another
>   paper filing, so an accidental collision with someone's online signature is
>   safe: you get `409 submission_id_conflict`, never their waiver. But two
>   different bulk imports (yours and another manager's, run separately) share
>   that same space, so an id derived deterministically from record data (e.g.
>   a UUID from the person's email) can collide across imports in a way a
>   random UUID cannot. Prefer minting a fresh random id per record unless you
>   have a specific reason to derive one.
> - **Sending an id means you own finishing that record.** Without one, a failed
>   filing cleans up after itself and means "nothing happened, send it again".
>   With one, the row is KEPT so your retry can resume it, and a
>   `503 waiver_filing_incomplete` means a waiver exists with no document behind
>   it. Retry until it succeeds. If you abandon it, a manager is left with a
>   pending waiver they cannot approve.
> - **The result's `created` tells a replay from a fresh filing.** `false` means
>   this call resolved to a waiver an earlier attempt already filed. Count those
>   separately when you report a batch, or a run that silently retried half its
>   calls will look identical to a clean one.
> - **Filing the same paper twice is caught.** If the person already has a
>   waiver signed on that `signed_on`, the call is refused with
>   `409 duplicate_waiver` and `error.details.existing` lists the waivers it
>   collided with (`id`, `approval_status`, `signed_on`), plus
>   `details.truncated` if there are more than 20. The check covers **any**
>   waiver signed that day, including one signed online — not just other paper
>   filings. **A retried or duplicated import batch is the
>   reason this exists — do not paper over it with `confirm_duplicate`.** Stop,
>   work out how many of the batch already landed, and resume from there. Only
>   set `"confirm_duplicate": true` when the second document is real (a corrected
>   re-scan of the same signing date), and say so to the manager when you do.
> - **`503 duplicate_check_failed` means the check itself broke, not that the
>   waiver is a duplicate.** Nothing was filed. Retry the call as-is. Do **not**
>   reach for `confirm_duplicate` to get past it: that disables the check rather
>   than fixing it, and would let a genuine duplicate through.

### The waiver everyone signs

The document at `/waiver` is **versioned**, and each signed waiver names the
version it was signed against — that link is the club's legal record, which is
why old versions are kept forever and why editing never touches them. Exactly
one version is **live** at a time.

There is **no draft state**: saving publishes. That is true on the manager screen
too, and it is the thing to say out loud before you call it.

### `list_waiver_templates` — every version, and which is live

Bodies are not included; `body_chars` and `acknowledgement_count` are, so you
can tell versions apart without pulling the text of each. (`get_waiver_template`
is where `acknowledgements` holds the real list.)

```bash
scripts/agent.sh list_waiver_templates '{}'
```

### `get_waiver_template` — read one version's text

The live version unless you pass `version`.

```bash
scripts/agent.sh get_waiver_template '{}'
```

The body is markdown carrying `{{placeholder}}` tokens (`full_name`,
`date_of_birth`, `signature_name`, `club_name`, the health questions, ...) that
are filled in per signer. Leave every token you are not deliberately changing
exactly as it is: a dropped `{{signature_name}}` is a waiver with no signature
line on it.

### `save_waiver_template` — publish new wording

Writes a **new version** and makes it the one everyone signs from that moment.
Anything you omit is carried over from the version the edit starts from (the live
one, unless `base_version` names another), so an acknowledgement can be reworded
without resending the legal text:

```bash
scripts/agent.sh save_waiver_template '{
  "acknowledgements": [
    {"id":"media","label":"I consent to photos and video of me training being used by the club.","required":false},
    {"id":"risk","label":"I understand jiu-jitsu carries a risk of injury.","required":true}
  ]
}'
```

Rewriting the text itself needs `title` and `body_md` together — a version is
written as a whole:

```bash
scripts/agent.sh save_waiver_template '{"title":"Training Waiver","body_md":"# Training Waiver\n\n..."}'
```

> [!IMPORTANT]
>
> - **Read `get_waiver_template` first and edit what it gives you back.** The
>   body is replaced wholesale, so a version built without reading first drops
>   every clause it did not include — from a legal document.
> - **`acknowledgements` replaces the whole list**, so send it complete. It must
>   still carry the `media` item with real wording: that tick is what records who
>   agreed to photos, so a version without it silently ends the club's consent
>   record and is refused (`422 save_waiver_template_failed`).
> - **Show the manager the exact wording before you save**, and say that it goes
>   live immediately for everyone who signs after it. People who already signed
>   are unaffected.
> - **`503 waiver_template_not_published` is not a refusal.** The change did not
>   reach the live waiver, usually because another manager was promoting at the
>   same moment, and the club may have no live waiver until somebody lands one.
>   Obey the `Retry-After` header. If `error.details.version` is there, that
>   version WAS written and is simply not live: finish with
>   `publish_waiver_template` on it rather than saving again, which would file a
>   second numbered draft of the same wording.

### `publish_waiver_template` — roll back to an earlier version

Makes a stored version live again. Nothing is rewritten and no new version is
created; on the version that is already live it does nothing and reports
`published: false`.

```bash
scripts/agent.sh publish_waiver_template '{"version": 4}'
```

### The knowledge base

Versioned markdown pages served at `/kb/<slug>` that members read and comment on,
grouped into ordered **sections**. The order matters more than it looks: the
sidebar, the index page and the previous/next links all come from it, so it is
literally the path a new member reads through. Get it right before worrying
about wording.

### `list_kb_sections` — the groups, in order

```bash
scripts/agent.sh list_kb_sections '{}'
```

### `save_kb_section` — add a group, rename it, or move it

An unknown `slug` creates it. An omitted field is left alone.

```bash
scripts/agent.sh save_kb_section '{"slug":"belts-and-grading","title":"Belts and grading","position":20}'
```

> [!TIP]
> Positions are seeded as 10, 20, 30 so you can slot a new section between two
> others without renumbering anything. Keep that habit.

### `delete_kb_section` — remove a group

Its articles are **not** deleted with it: they drop into the "Everything else"
group at the bottom of the sidebar, where members can still find them. The
result says how many were displaced, so re-file them.

```bash
scripts/agent.sh delete_kb_section '{"slug":"belts-and-grading"}'
```

### `list_kb_articles` — everything in the knowledge base

Returns each entry's `slug`, live `title` and `version`, how many `versions` it
has, its `section` and `position`, `visibility` (`members | managers`), and
whether it is still `annotations_enabled`.

An entry with a `link_path` is **not an article**: it is a sidebar link to a page
elsewhere on the site (`/first-class`, `/faq`), it has no versions, and its
`version` comes back null.

```bash
scripts/agent.sh list_kb_articles '{}'
```

### `get_kb_article` — read one article's markdown

Returns the live version unless you pass `version`, plus `sections`: every
heading in it, with the link that goes straight to that heading.

```bash
scripts/agent.sh get_kb_article '{"slug":"belts"}'
```

```json
{
  "sections": [
    {
      "id": "grading",
      "text": "How grading works",
      "depth": 2,
      "pinned": true,
      "url": "/kb/belts#grading"
    },
    { "id": "fees", "text": "Fees", "depth": 3, "pinned": false, "url": "/kb/belts#fees" }
  ]
}
```

### Linking to a section of another article

An article points at one section of another with an **ordinary markdown link**
carrying the heading's anchor. There is no special syntax:

```markdown
Bring the fee in cash, see [the fees](/kb/belts#fees).
```

Read the article you are pointing at with `get_kb_article` and copy the `url`
out of its `sections`. Do not work the fragment out from the heading yourself:
it is the heading's own words lowercased and hyphenated, which is right until
somebody rewords the heading, and a wrong one fails silently.

**Pin the heading you just linked to** by ending it with `{#anchor}`, the
attribute syntax Pandoc and Docusaurus use. The anchor then stays put however
the heading is reworded, and readers never see the suffix:

```markdown
## How grading works {#grading}
```

`sections[].pinned` says which anchors are already pinned. `#section` on its own
links within the same article.

### `save_kb_article` — write, or place in the sidebar

`title` + `body_md` write a **new version** and publish it. Past versions are
kept, and comments stay attached to the version they were written against.

```bash
scripts/agent.sh save_kb_article '{
  "slug":"our-history",
  "title":"Our history",
  "body_md":"# Our history\n\nThe club started in 2004.\n",
  "section":"about-the-club",
  "position":10,
  "change_note":"Added the founding years"
}'
```

Send neither `title` nor `body_md` to change only where an article sits. No new
version is written, so members are not shown "updated today" for a move:

```bash
scripts/agent.sh save_kb_article '{"slug":"our-history","section":"about-the-club","position":20}'
```

A **link entry** points at a page elsewhere on the site instead of holding text:

```bash
scripts/agent.sh save_kb_article '{
  "slug":"common-questions",
  "link_path":"/faq",
  "nav_title":"Common questions",
  "section":"start-here",
  "position":40
}'
```

> [!IMPORTANT]
>
> - **`body_md` REPLACES the whole article.** It is not a patch. Always
>   `get_kb_article` first and edit the text you get back, or everything you did
>   not include is dropped from the new version.
> - **A new slug silently creates a second article** at a second URL. Check
>   `list_kb_articles` before saving if you are not certain of the spelling, and
>   pass `"expect_new": true` when you mean to create one. The save is then
>   refused if the slug is already taken, rather than adding a version to an
>   existing article and patching its visibility to whatever you sent.
> - **Omit `visibility` unless you mean to change it.** Omitting leaves it as it
>   is; passing `members` on what was a managers-only draft publishes it to every
>   member of the club. New articles default to `members`. There is no `public`
>   level: the whole knowledge base needs a login.
> - **A cross-reference is not checked when you save it.** A link to an article
>   or a section that does not exist is stored exactly as written, and only a
>   reader following it finds out. Read the target before linking to it.
> - **`link_path` takes site-relative paths only** (`/faq`, not
>   `https://...`), needs a `nav_title`, and cannot be combined with
>   `title`/`body_md`. An article that already has versions cannot be turned
>   into a link.

### `list_kb_comments` — read what members said

Returns the **shared** comment threads on an article (`parent_id` links a reply
to its thread), each with the `quote` it was written about and the
`article_version` it was written against. Resolved threads are excluded unless
you pass `include_resolved: true`.

```bash
scripts/agent.sh list_kb_comments '{"slug":"our-history"}'
```

> [!NOTE]
> **Private notes are never returned.** Readers can keep notes only they can
> see, and those are private from the club too, by design. This action shows the
> conversation, not everything anybody wrote — do not describe its output to a
> manager as "all the feedback".

## Guidance

- Confirm the target invoice with the manager (member name + amount) before an
  `edit_invoice` — it writes to live records.
- Before a `save_kb_article` that carries text, read the current version back
  with `get_kb_article` and show the manager what you are changing. A save
  publishes immediately: there is no draft state on an existing article, and
  members see the new wording on their next page load.
- When a manager asks for a new article, ask where it goes in the reading order
  before writing it. An article with no `section` lands in "Everything else" at
  the bottom of the sidebar, which is visible but almost certainly not what they
  meant.
- Never save a waiver version the manager has not read. Fetch
  `get_waiver_template`, show them the exact wording you propose, and say plainly
  that saving publishes it to everyone who signs from that moment. It is the
  club's legal document, and rolling back (`publish_waiver_template`) restores
  old wording but cannot unsign anybody.
- Before a `file_waiver` batch, confirm scope with the manager: how many
  records, whether any should be flagged for review rather than filed
  automatically, and that leaving everything pending (not approved) is what
  they want.
- On `ok: false`, read `error.code`/`error.message`; `invalid_params` responses
  include an `issues` array pointing at the offending field. **An unknown or
  misspelled parameter is a 400, on every action** — a flag you typo'd is never
  silently dropped, so a refusal you thought you confirmed past means the
  confirmation genuinely was not accepted, not that it went missing. `file_waiver`
  failures (an unreadable scan, a storage hiccup) come back as
  `file_waiver_failed` with a plain-English message.
- Two error codes carry extra fields and both mean "stop and confirm", never
  "retry with the flag set": `reconciled_invoice` (409, with `blocked`,
  `paid_at`, `previous`) and `duplicate_waiver` (409, with `existing`,
  `truncated`). Both have an override, and both overrides are the manager's
  call, not yours.
- `duplicate_check_failed` (503) is the opposite: a transient failure, safe and
  correct to retry unchanged, and it carries a `Retry-After` header — obey it
  rather than retrying immediately. Nothing was filed. Retryable failures are 5xx;
  a 4xx means the request itself needs to change before it will ever succeed.
- The manifest's `version` tells generations apart (currently `"13"`), and its
  `changes` array says what each version actually moved, newest first, with
  `breaking: true` on any version that turns calls which used to succeed into
  errors. **There is no way to pin an older version** — the contract is
  latest-only, so `changes` tells you what moved rather than letting you opt
  out of it. If you
  cached the manifest at the start of a long batch, read `changes` rather than
  diffing prose — it calls out the calls that used to succeed and now refuse.
