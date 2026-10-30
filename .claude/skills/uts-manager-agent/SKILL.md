---
name: uts-manager-agent
description: >-
  Perform UTS Jitsu manager actions (list members and their status, look up
  everything the manager person page shows about one person, raise a
  membership for someone, cancel or delete an invoice, edit an invoice's
  details, file a scanned paper waiver, edit and publish the waiver template
  people sign and the code of conduct members agree to, manage the club's membership dates, publish and reorder the
  club's knowledge base and read members' comments on it) against the live site
  via its manager agent HTTP API. Use when a club
  manager asks an agent to look up members/invoices, check one person's state
  (verification, code of conduct, waivers, attendance, profile), put a member on a plan or
  swap them onto a different one, cancel or delete a membership, correct invoice
  details (price, payment reference, notes, status), keep the club's item price
  list and charge somebody for items, see where replies to club emails go,
  turn the notice across the top of the public site on or off and reword it,
  resend an invoice, receipt or waiver email,
  migrate/bulk-file waivers
  the club holds on paper, reword the waiver or its tick-boxes and publish a new
  version of it (or roll back to an earlier one), edit and publish the club's
  code of conduct (and choose whether members must agree to it again), add or edit a membership
  window's start/end dates (and email every member about a plan), or edit a
  knowledge base article at /kb/<slug>, change the order members read them in,
  and review the feedback left on them, or write, edit, publish or delete a
  blog post at /blog/<slug> and upload its pictures. Requires the
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

- `UTS_MANAGER_API_URL` — the site's base URL, `https://utsjitsu.com.au`. Use the
  host the site is served from, never `jitsu.au`: that domain now redirects, and
  a redirect to another host drops the `Authorization` header, so every call
  fails 401 with a token that is perfectly valid.
- `UTS_MANAGER_API_KEY` — a manager agent token. A manager mints one at
  **`/manager/api-tokens`** on the site (it's shown once — copy it then). That is
  the only kind of token the endpoint accepts: there is no server-side
  environment-variable fallback, so a lost token means minting a new one.

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

> **An `email` is not always that person's mailbox.** Somebody on somebody
> else's account — a child, typically — has no address of their own, so the
> `email` on their row is their **guardian's**. `email_belongs_to` names whose
> it is, and is `null` when the address really is the person's own. Report the
> two together or neither: an address under a nine-year-old's name with no
> caption tells a manager they can write to a nine-year-old, and nobody is
> reading it. `list_invoices` says the same thing in `member_email_belongs_to`.

> **The family is on the row.** `guardian_user_id` is the account holder this
> person is on, or `null` for almost everybody. `email_belongs_to` **names** that
> person for a caption; this **identifies** them, so you can fetch or act on the
> guardian rather than only mention them. `dependants` is the people on this
> person's account, each `{ user_id, name }` — always present, empty for almost
> everybody, and empty for a dependant too, because a household is one level
> deep and a dependant can never have any.
>
> **Read `dependants`; do not rebuild it** from `guardian_user_id` across the
> listing. A `status` filter can drop the children out of the response while
> leaving the parent in it, so a household reconstructed from what came back
> would report that parent as having none.
>
> This is how you learn that `create_membership` on a nine-year-old is expected
> rather than a mistake, and who to chase for the invoice it raises: billing is
> one invoice per child, and every one is delivered to the guardian. A child
> never has a login, and approving a child's waiver opens the **guardian's**.

`roles` is empty for a member on a **free** plan, including the trial: the
`member` role follows an active, priced, non-trial membership, so an active $0
invoice with `roles: []` is correct, not a missed grant.

`roles` and `lifecycle_status` reach through the household: a parent who does not
train reads as a `member`, and carries the `member` role, while a plan held by
anybody on their account is live. That matches what members-only access has done
for them since the household shipped. It stays a **label** either way — no policy
reads the `member` role — and it does not mean they are covered to train:
check-in coverage is strictly the person's own, so a parent at the door correctly
shows no cover.

```bash
scripts/agent.sh list_users '{"status":"member","limit":50}'
# or raw:
curl -s "$UTS_MANAGER_API_URL/api/manager/agent" \
  -H "Authorization: Bearer $UTS_MANAGER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"action":"list_users","params":{"status":"member"}}' | jq
```

`params` (all optional): `status` (lifecycle filter), `limit` (1–500, default 200).

Each row also carries three headline fields, the ones the person page leads with:

- `phone`.
- `email_confirmed_at`: when the address was verified, `null` when it is not.
  For a child it is the state of the guardian's address, because `email` is
  the guardian's.
- `code_of_conduct`: `{ state, current_version, required_version,
accepted_version, accepted_at, signature_name }`, where `state` is
  `unsigned | signed | outdated`. `outdated` means `accepted_version` is below
  `required_version`, the last version that asked everybody to agree again
  (unless a rollback undid that ask); a newer live version that did not ask (a
  correction) puts nobody out of date.
  It never blocks anything: an unsigned member can still train.

For anything more about one person, call `get_user`.

### `get_user` — everything the person page shows about one person

The answer a manager reads on `/manager/users/<id>`, from the same read the
page makes. Use it to answer "what is the state of this person?" rather than
piecing it together from `list_users`.

```bash
scripts/agent.sh get_user '{"user_id":"<uuid>"}'
```

`params`: `user_id` (**required**, from `list_users`). The result:

- `user`: name, `email` + `email_belongs_to`, `email_confirmed_at`, `phone`,
  `roles`, `lifecycle_status`, `sessions_attended` (exact, lifetime),
  `latest_plan_kind` / `latest_membership_status` /
  `latest_sessions_remaining`, `first_seen_at`.
- `profile`: the club's live record. `first_name` / `middle_name` /
  `last_name` and the preferred name, date of birth, address,
  UTS student number, emergency contact, `medical_notes`, `is_minor` and the
  guardian block, SMS/WhatsApp consent, `gi_size` / `belt_size`, and
  `media_consent` (`null` means never asked, not "no") with who last set it.
- `household`: `guardian` and `dependants`, by `user_id` and `name`.
- `memberships`: each with `plan_name`, `kind`, `status`, `price_cents`,
  `payment_reference`, dates, `sessions_remaining`, `paid_at` and
  `checkin_count` (a membership with check-ins cannot be deleted). The money
  detail (`payment_method`, `notes`, `plan_code`) is on `list_users`' `invoices`.
- `checkins`: attendance, newest first, capped at 100. `user.sessions_attended`
  is the real total.
- `code_of_conduct`: the same object `list_users` carries.
- `waivers`: every waiver they submitted, as submitted, with `status`
  (`pending | active | superseded`), `template_version`, `signed_at`,
  `has_pdf`, `approved_at`, the approver, and `is_paper` (`true` for a scanned
  paper form a manager filed; check it before `file_waiver` so you do not file
  one twice). The signer's IP address and browser context are deliberately not
  reported.

> **This is sensitive.** Medical notes, addresses and dates of birth are here
> because a manager needs them on the page. Read them when the question needs
> them; do not repeat them into a summary nobody asked for.

> **The same address rule as `list_users`.** A child's `email` is their
> guardian's, and `email_belongs_to` says so. Report the two together or
> neither.

A person, not a lead: an id with no person record is `404 not_found`. A read
that could not fill any part of the answer (the address, the code of conduct,
the guardian's name, a class name or a waiver approver's name) is
`500 db_error` rather than a `null` email, an `unsigned` or an unknown name the
server never actually checked, so retry it.

Some things a manager does from the person page are deliberately **not**
actions: approving a waiver, changing somebody's login email, resending the
verification email, correcting kit sizes, opening the waiver PDF, and moving
check-in coverage. Tell the manager to do those on the page.

### `list_invoices` — find an invoice to edit

Flat list of invoices (membership payment records) with member name/email, plus
`member_email_belongs_to` — whose address that is when it is not the member's
own (see the note under `list_users`; it is read-only, and `edit_invoice`
refuses it by name). The
response's `total` is the full matching count regardless of `limit`, so you can
tell a capped page from a complete one. Each invoice also carries
`sessions_allowed` and `sessions_remaining`, including what `null` means on each
(see the note under `list_users`).
`params` (optional): `status` (`pending | active | expired | cancelled`), `limit`.
To find unpaid invoices, filter the result on `paid_at` being null rather than by
status — see the note under `list_users`.

Every invoice (here and inside `list_users`) also carries `insurance_reminder`.
It is `null` unless the plan is yearly insurance. On those it is
`{ "ends_within_14_days", "owed", "last_sent" }`:

- `ends_within_14_days` is true while the member is owed the "your insurance
  ends soon" email: their cover ends in the next 14 days (Sydney), they have not
  renewed, and it is not cancelled. Paid or unpaid makes no difference.
- `owed` is the reminder owed today (`insurance_ending_soon` or
  `insurance_ended`), whether or not it has gone out yet, or `null`.
- `last_sent` is `{ "kind", "sent_at" }` for the latest reminder actually
  emailed (`insurance_ending_soon` 14 days before, `insurance_ended` on the
  day), or `null` if none has gone out.

The site sends both reminders itself every morning. There is no action to send,
resend or stop one, and members cannot switch them off. To answer "whose
insurance runs out soon?", filter `list_invoices` on
`insurance_reminder.ends_within_14_days`.

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
`session_date` (optional `YYYY-MM-DD`, casual class only), `starts_on` (optional
`YYYY-MM-DD`, yearly insurance only — see below), `include_insurance` (optional,
default false), `send_email` (optional, default true).

```bash
scripts/agent.sh create_membership '{"user_id":"<uuid>","plan_code":"2026-s2"}'
# Cover that really started in February, recorded now, with no invoice email:
scripts/agent.sh create_membership '{"user_id":"<uuid>","plan_code":"insurance_yearly","starts_on":"2026-02-01","send_email":false}'
```

> **It is authorised straight away, and that is not the same as paid.** Whatever
> the plan costs, the person can be checked in from the moment you raise it, with
> the invoice outstanding. Recording the money is a separate act
> (`mark_invoice_paid`, or bank reconciliation). `reference` in the result is
> non-null exactly when money is owed, and carries what the member would quote on
> a transfer; `authorised` is always true. With `send_email: false` no invoice
> email goes out.
>
> **Raising a plan they already owe for does not raise a second invoice, and does
> not reprice the first.** `reused: true` in the result means their existing
> unpaid invoice came back, and `price_cents` is what it really says. Sending a
> different `uts_student_number` does not change that price. If it is not the
> rate you meant, fix it with `edit_invoice`, or cancel or delete the invoice and
> raise the plan again.
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
>
> **`starts_on` says when the cover itself begins**, defaulting to today. Only a
> plan that runs for a fixed number of days takes one — today that is the yearly
> insurance — because its length is fixed while where it sits is a real choice.
> That makes it the other half of a backfill: `send_email: false` stops the
> invoice going out, `starts_on` puts the year of cover where it actually ran.
> The end date follows from the plan's duration.
>
> Anything else is refused with `422 start_date_not_choosable` rather than
> ignored: a **training period**'s dates belong to the plan and everyone who buys
> it gets exactly those, and a **casual class or free trial** ends with its
> classes rather than on a date (use `session_date` there — it dates the payment
> reference, not the membership). Re-raising with a different `starts_on` moves
> the reused invoice's window.
>
> A bundled `include_insurance` invoice always runs from **today**, never from
> `starts_on`: it is a second plan being sold now. To backdate cover as well,
> raise the insurance as its own `create_membership` call with its own
> `starts_on`.

### `edit_invoice` — correct an invoice's details

`params`: `id` (**required** — the invoice UUID from a list call) plus at least
one editable field: `price_cents` (integer cents), `notes` (pass `null` to clear
a mistaken note), `payment_reference`, `payment_method`
(`bank_transfer | stripe | manual`), `status` (`pending | cancelled | expired`),
`starts_on` (`YYYY-MM-DD`, yearly insurance only — see below).
Any other key is rejected, naming itself in the error — so a typo like `price`
doesn't get silently ignored. This includes the read-only fields a `list_*`
call decorates an invoice with (`plan_code`, `plan_name`, `price`, `is_student`,
`paid_at`, `starts_at`, `ends_at`, `created_at`, `member_name`,
`member_email`, `member_email_belongs_to`): send only `id` plus the field(s)
you're actually changing,
never a listed invoice echoed back wholesale. `starts_at` / `ends_at` move only
through `starts_on`, which names a day and lets the plan place it — you never
write the two instants yourself. `plan_name` already names the
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
> on holding an active membership, never on the role. Closing a **child's**
> membership re-syncs the **parent** too, so a parent whose last child's plan you
> just closed stops reading as a member on the same call.
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

> **`starts_on` corrects the day the cover began**, for a membership whose plan
> runs a fixed number of days (the yearly insurance). It writes `starts_at` and
> `ends_at` together: the window keeps the length it was sold at and moves as
> one, so a correction can never lengthen or shorten somebody's cover. Both show
> up in `changed` and `previous`, and in the audit log. Any other plan is refused
> with `422 start_date_not_choosable` — a training period's dates belong to the
> plan (correct them with `save_membership_plan`, which changes what activates
> from then on, not anyone already on it), and a class-credit plan has no window
> to move.
>
> It is deliberately **not** guarded by `confirm_paid_edit`. The dates say when
> somebody is covered, not what they paid, and the correction is wanted most
> often precisely because the money already landed. Still say what you moved:
> shortening live cover is felt by the member even though nothing about the
> invoice changed.

```bash
scripts/agent.sh edit_invoice '{"id":"<uuid>","starts_on":"2026-02-01"}'
```

### `mark_invoice_paid` — record money that arrived

`params`: `id` (**required** — the invoice UUID from a list call),
`payment_method` (optional: `bank_transfer | stripe | manual`, default `manual`),
`paid_on` (optional `YYYY-MM-DD`: the day the money arrived, default today,
refused if in the future or more than two years back), `paid_reference` (optional: a receipt number or the
transfer's own reference, up to 200 characters).

```bash
scripts/agent.sh mark_invoice_paid '{"id":"<uuid>"}'
scripts/agent.sh mark_invoice_paid '{"id":"<uuid>","paid_on":"2026-10-20","paid_reference":"Receipt 42"}'
```

`paid_reference` is **not** the invoice's `payment_reference` (what the member
quotes on a transfer); marking paid never changes that. When a manager tells you
when the cash was taken, pass that day rather than letting it default to today.

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
`ends_on`, and `last_announcement`: the plan's most recent email to members
(`announcement_id`, `announced_at`, `recipients`, `emailed`, `times`), or null
if it was never announced.

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

#### Emailing every member about a plan (`announce`)

The manager screen's "Email all members about this plan" box, as two params on
the same call:

```bash
scripts/agent.sh save_membership_plan '{
  "id": "<plan id>", "code": "semester_1_2027", "name": "Semester 1 2027",
  "kind": "period", "public_price_cents": 46000, "student_price_cents": 25500,
  "duration_days": null, "session_credits": null, "is_active": true, "sort_order": 2,
  "starts_on": "2027-02-01", "ends_on": "2027-06-26",
  "announce": true, "announcement_id": "<a UUID you mint, e.g. from uuidgen>"
}'
```

It saves the plan, then emails everyone whose waiver has been approved: one
email per family, to the parent, naming the children. The email has the plan's
dates, both prices, a line on yearly insurance for whoever needs it, and a link
to buy it. It goes immediately and **nobody can turn it off**.

> [!CAUTION]
> **This is irreversible and reaches the whole club.** Confirm with the manager
> first, in words, before sending `announce: true`: which plan, and that every
> member will be emailed. `last_announcement` on `list_membership_plans` says
> whether and when it already went, so check it before announcing again.

- **`announcement_id` is required with `announce: true`**, and it is what makes
  a retry safe. Mint one UUID per announcement and **reuse it** to retry a
  failed or timed-out call: the same id never emails anybody twice. A new id
  announces the plan again, on purpose (after a price change, say). Missing it
  is `400 invalid_params`, before anything is saved.
- The response carries `announcement`: `recipients` (emails it is), `emailed`,
  `pending`, `announced_at`. **`pending` above zero** means some emails have not
  gone yet (one call sends at most 150): call again with the same id to send the
  rest, or leave them for the next morning's summary, which picks them up.
- **`502 announcement_failed`** means the plan IS saved and the email did not
  go. `error.details.id` is the plan. Retry with **that `id`** and the same
  `announcement_id`: without the id, a plan you just created would be created
  again (and refused, since its code is taken).
- **`404 not_found`** means the `id` you sent matches no plan. Nothing was saved.
- **`409 submission_conflict`** means that id was already used for a different
  plan. Mint a new one.

> [!TIP]
> Add next year's plan before enrolments open for it, and check
> `list_membership_plans` shows exactly the dated plans a member could be
> buying into at any moment. There is no overlap check across plans (unlike
> the old separate windows table) — a plan whose dates overlap another's is a
> product decision a manager can make deliberately (e.g. running two prices
> side by side briefly), not an error.

### Charging for items (`list_items`, `save_item`, `delete_item`, and the item invoices)

For things the club sells that are not a membership: a gi, a patch, a grading
fee. Two parts, both kept deliberately small (docs/item-invoices.md):

- **The price list**: each item is a name and a price, and nothing else. No
  stock, no categories, no photos.
- **Item invoices**: one or more items, each with a quantity, raised against a
  person and emailed to them. **An item invoice is not a membership**: it never
  appears in `list_invoices`, and `edit_invoice` / `delete_invoice` do not touch
  it. Its reference looks like `INV0007` and is unique per invoice.

```bash
scripts/agent.sh list_items '{}'
scripts/agent.sh save_item '{"name":"Club gi","price_cents":8500}'          # add
scripts/agent.sh save_item '{"id":"<uuid>","name":"Club gi","price_cents":9000}'  # reprice
scripts/agent.sh delete_item '{"id":"<uuid>"}'
```

> **Repricing or removing an item never changes an invoice already raised.**
> Each invoice carries its own copy of every line's name and price. That is why
> `delete_item` is always safe.

### `create_item_invoice` — charge somebody, and email them

`params`: `user_id` (**required**, from `list_users`), `lines` (**required**, 1
to 20 of `{ "item_id", "quantity" }`, quantity 1 to 99), `client_submission_id`
(a UUID you mint; **send it**).

```bash
scripts/agent.sh create_item_invoice '{
  "user_id": "<uuid>",
  "client_submission_id": "<a uuid you generate once for this invoice>",
  "lines": [{"item_id":"<gi uuid>","quantity":1},{"item_id":"<patch uuid>","quantity":2}]
}'
```

> **It emails the invoice straight away**, to the person, or to their guardian
> for a child, and **an email cannot be unsent**. Confirm the person and the
> items with the manager before sending anything in bulk.
>
> **The price is read off the price list at that moment.** A line carrying a
> price is refused (`400 invalid_params`) rather than quietly ignored. The same
> item twice is refused too: set its `quantity`.
>
> **Resend the same `client_submission_id` on a retry.** If the reply was lost
> but the invoice was raised, the retry returns that invoice with
> `already_raised: true` and sends nothing. Without it, a retry raises and
> emails a second invoice.
>
> `emailed: false` means the invoice exists but the send failed. It is on their
> membership page; tell the manager so they can let the person know.
>
> `404 not_found` for an unknown person; `422 item_not_listed` when an item was
> removed from the list since you read it.

### `list_item_invoices` / `mark_item_invoice_paid` / `cancel_item_invoice` / `delete_item_invoice`

```bash
scripts/agent.sh list_item_invoices '{"state":"unpaid"}'
scripts/agent.sh list_item_invoices '{"user_id":"<uuid>"}'
scripts/agent.sh mark_item_invoice_paid '{"id":"<uuid>"}'
scripts/agent.sh mark_item_invoice_paid '{"id":"<uuid>","paid_on":"2026-10-20","paid_reference":"Receipt 42"}'
scripts/agent.sh cancel_item_invoice '{"id":"<uuid>"}'
scripts/agent.sh delete_item_invoice '{"id":"<uuid>"}'
```

Each row carries `payment_reference`, `lines`, `summary`, `total_cents`,
`state` (`unpaid | paid | cancelled`), `paid_at`, `paid_reference`, and who it
is for. `mark_item_invoice_paid` takes the same optional `paid_on` and
`paid_reference` as `mark_invoice_paid`. Same rule as the
membership listings: for a child, `member_email` is the guardian's and
`member_email_belongs_to` names them, so **print the two together or not at
all**.

> **Bank reconciliation settles these by itself** when a statement line carries
> the reference and exactly the total. Reach for `mark_item_invoice_paid` only
> for money that never touched the club account (cash). It emails a receipt,
> defaults `payment_method` to `manual`, and is idempotent (`recorded: false` on
> a second call).
>
> **A paid item invoice is finished.** Cancel and delete both refuse it with
> `409 item_invoice_settled`, and there is no refund flow. Cancel keeps the
> record and stops it showing as owed; delete removes it as though it was never
> raised. Neither emails anybody, and neither can be undone.

### `get_club_settings` — where replies to club emails go, and the bank account

```bash
scripts/agent.sh get_club_settings '{}'
```

Returns `email_reply_to` (or null) and `payment_details` (the bank account, or
null when not published). A `503 settings_unreadable` means the read failed,
**not** that nothing is set: retry, never treat it as empty.

Once `email_reply_to` is set, every email the club sends to a member or visitor
carries it as `Reply-To` and says "reply to this email"; while it is null those
emails point at the contact page, phone and WhatsApp instead.

> **Both settings are read-only here, on purpose.** They decide where members'
> replies and money go, so there is no action that changes either. If a manager
> wants one changed, tell them it is on the Club settings screen
> (`/manager/settings`). Do not try to work around this.

### `get_site_banner` / `save_site_banner` — the notice across the top of the site

```bash
scripts/agent.sh get_site_banner '{}'
scripts/agent.sh save_site_banner '{"enabled":true,"message":"We are training at a temporary location, so free trials are paused for now.","link_label":"Register your interest","link_href":"/register-interest"}'
scripts/agent.sh save_site_banner '{"enabled":false}'
```

`get_site_banner` returns `{ banner: { enabled, message, link_label, link_href } }`.
A banner nobody has set reads as `enabled: false`. A `503 settings_unreadable`
means the read failed, **not** that the banner is off.

`save_site_banner` takes only the fields you are changing; the rest keep their
stored values, so turning it off keeps the message for next time. The message
is one line of up to 200 characters. The link is optional, but `link_label` and
`link_href` go together, and `link_href` is a page on this site (`/classes`,
`/faq#trial`). An outside `https://` address is refused here: if the manager
wants one, tell them it is on the Site banner screen (`/manager/site-banner`).
If the stored banner already links to another site, you can only switch it off
(`409 outside_link` for anything else); send the manager to the same screen.

> **It is public the moment it saves.** Every visitor sees the banner at the top
> of every public page, and a changed message is shown again even to people who
> closed the old one. Read the wording back to the manager and get a yes before
> saving, and write it in the club's voice: plain, no em dashes.

### `resend_email` — send an email again

```bash
scripts/agent.sh resend_email '{"kind":"membership_invoice","record_id":"<membership uuid>","client_submission_id":"<new uuid>"}'
```

`kind` is one of `membership_invoice`, `membership_receipt` (record: the
membership), `item_invoice`, `item_invoice_receipt` (the item invoice),
`waiver_confirmation`, `account_activated` (the waiver), `email_verification`
(the person's `user_id`). It goes to the person it went to, which is the
guardian for a child: the result's `to` and `to_belongs_to` say exactly where,
so **print the two together**.

It is rebuilt from today's records: a resent invoice carries the amount owed
**now** and the club's **current** bank details, not the original's. Managers
are not copied.

- **Once a minute per email per record.** A second call inside that is
  `429 rate_limited` with a `Retry-After`. Do not loop on it.
- **Mint a `client_submission_id` per resend and reuse it only to retry that
  resend** (after a lost answer or `503 email_not_sent`). A new id is a new
  email in somebody's inbox. Reusing an id whose email already went is
  `409 already_sent`, never a second email: mint a new id if the manager
  really wants it sent again.
- A `409` means the record has moved on (`paid`: resend the receipt instead;
  `already_verified`: nothing to send). A `422` means nothing can be sent
  (`no_address`, `paper`, `dependant`, `free`). Report it; do not retry.
- Confirm with the manager before resending to a person who did not ask for it.

### `file_waiver` — file a scanned paper waiver (migration / bulk filing)

The agent equivalent of a manager using **Upload a paper waiver** on the site.
Files one waiver per call: attaches to the person with the given email (or
creates a locked applicant if that email is new to the club), stores the scan
as the waiver's PDF, and lands the row **pending**.

**`signing_for`** (optional, `"self"` by default) says who the paper is for.
Leave it out and nothing changes. Set it to `"dependant"` to file for somebody
on another person's account, typically a child: then `email` is **refused**
(they have none of their own) and `guardian_email` and `guardian_name` become
**required**, because the guardian is who the club writes to and whose login an
approval opens. The participant gets their own person record all the same, so
two children filed under one parent address are two people with two free trials.
The server decides which existing child a filing belongs to by matching
`first_name`, `last_name` and `date_of_birth` within that guardian's household,
so spell them the same way each time or a second record is created.

`params` mirror the web form exactly — see the live manifest for the full list,
but the shape is: `first_name`, `middle_name` (optional), `last_name`,
`preferred_name` (optional), `date_of_birth` (`YYYY-MM-DD`), `address`, `phone`,
`signing_for` (optional, see above),
`email` (required unless `signing_for` is `"dependant"`, where it is refused),
`uts_student_number` (optional), `sms_whatsapp_consent` (optional,
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
>   **the login of whoever the club writes to about them** (their guardian's,
>   for a dependant), **emails that person to say the account is active**, and
>   **assigns the free trial** (`docs/waivers.md`, rule 6).
>   `file_waiver` does none of that — every row lands pending, exactly like a
>   manager's own upload. Approving hundreds of migrated people would email all
>   of them and hand out that many trials; that decision belongs to the manager
>   running the migration, made deliberately (through the site, one at a time or
>   with an explicit follow-up they've asked for), never as a side effect of
>   filing.
> - **A waiver's `email` is its identity key.** A typo creates a second person
>   instead of attaching to the right one — check each address against source
>   data before sending it, especially in a scripted loop. For a
>   `signing_for: "dependant"` filing the identity key is the guardian's
>   address **plus** the participant's name and date of birth, so a typo in any
>   of the three has the same effect.
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

### The code of conduct

The club's house rules, at `/code-of-conduct`. Members agree to them by typing
their name; it is never a condition of training. Like the waiver, the text is
kept in numbered versions with one live, and these four actions are the
agent's equivalent of the manager's editor at `/manager/code-of-conduct`.
They work the same way as the waiver template actions above (version-keyed,
saving publishes, omitted text carried over from `base_version`, the same
refusals with `code_of_conduct_not_published` as the 503), with one addition.

> **`asks_reagreement` decides who is out of date.** Every save is a new
> version, but only a save with `asks_reagreement: true` asks everybody who
> agreed to an earlier version to agree again. Leave it off for a correction
> (a typo, a broken link, clearer wording): everybody stays up to date. Turn it
> on when the rules themselves change, and tell the manager the reply's
> `reprompted` count, which is how many people it put out of date. Nobody is
> emailed either way; they see a prompt on their account page.

### `list_code_of_conduct_versions` — every version, and which is live

`live_version`, `required_version` (anybody whose highest agreement is below it
is out of date), and each version without its text: `version`, `title`,
`status` (`Live | Previous | Draft`; `Previous` means it has been live, so a
version rolled away from stays `Previous`), `asks_reagreement`,
`required_version`, `first_published_at`. Read a version's text with
`get_code_of_conduct`.

### `get_code_of_conduct` — read one version's text

`params`: `version` (optional, default the live one). The text is a small
markdown subset: `# Heading`, `## Section`, `- bullet`, `**bold**`, bare
`https://` links, and a blank line between paragraphs. Anything else shows as
typed.

### `save_code_of_conduct` — publish new wording

```bash
# A correction: nobody is asked to agree again.
scripts/agent.sh save_code_of_conduct '{"title":"UTS Jitsu Code of Conduct","body_md":"# UTS Jitsu Code of Conduct\n\n..."}'
# The rules changed: ask everybody to agree to the new text.
scripts/agent.sh save_code_of_conduct '{"title":"...","body_md":"...","asks_reagreement":true}'
```

`params` (all optional, but there must be something to save): `title` and
`body_md` (together, or neither), `asks_reagreement` (default `false`),
`base_version`, `client_submission_id` (a UUID you choose; resend it on a retry
and a save that already landed comes back `already_saved: true` instead of
writing a second version). Sending only `asks_reagreement: true` republishes the
current text as a new version that asks everybody to agree to it, for when a
rewrite went out without asking.

> **Read `reprompted` even when you did not ask.** A correction normally puts
> nobody out of date, but if nothing was live (a publish failed and left the
> club without one) the new version inherits the newest version's requirement,
> and that can. Tell the manager the number either way.
>
> **A retry can come back `503 code_of_conduct_not_published` with
> `error.details.version`.** That version was written but is not live: its first
> attempt lost the race to publish, or somebody has changed the live version
> since. It is never made live behind your back. Check with
> `list_code_of_conduct_versions`, then `publish_code_of_conduct` it only if it
> should replace what is live now.

### `publish_code_of_conduct` — roll back to an earlier version

`params`: `version` (**required**). The reply's `required_version` says who is
out of date afterwards: rolling back below a version that asked undoes that
ask. Its `reprompted` is how many people this publish asked to agree again:
tell the manager that number, as the editor screen would have before the click.

```bash
scripts/agent.sh publish_code_of_conduct '{"version": 3}'
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

### The blog

Posts at `/blog/<slug>`, written in Markdown. These are the same saves the
manager's blog editor at `/manager/blog` makes. A post is a **draft** (only
managers can see it) or **published** (anyone on the internet can).

### `list_blog_posts` — every post, drafts included

```bash
scripts/agent.sh list_blog_posts '{}'
```

Each post has `url`, its public address, which is **null for a draft**: a draft
has no public address, so never hand a draft's slug to anybody as a link. Give a
manager `edit_url` instead, their own screen for the post.

### `get_blog_post` — read one post in full

By `id`, or by the `slug` in its address:

```bash
scripts/agent.sh get_blog_post '{"slug":"2026-10-20-grading-day"}'
```

### `save_blog_post` — write, edit or publish

No `id` creates a post, which is a draft unless you say otherwise:

```bash
scripts/agent.sh save_blog_post '{
  "title": "Grading day",
  "body_md": "Grading is on Saturday 8 November.\n\n![The mats](https://...)\n"
}'
```

With an `id`, **every field you leave out keeps what is stored**. Publishing a
draft as it stands:

```bash
scripts/agent.sh save_blog_post '{"id":"<id>","status":"published"}'
```

A blank `slug` is made from today's date and the title, and a blank `excerpt`
from the opening of the body; read both back from the result. An excerpt does
not follow a rewritten body by itself: send `"excerpt": ""` with the new body to
have it taken afresh.

> [!IMPORTANT]
>
> - **Publishing is public and announced.** The post is on the public blog the
>   moment it saves, and the first time a post goes live every member who opted
>   in to announcements hears about it in their daily summary email. Taking it
>   back to draft hides it again but cannot take the announcement back. The
>   result's `announced` says whether this save announced it.
> - **`body_md` REPLACES the whole body.** Always `get_blog_post` first and edit
>   the text you get back.
> - **Changing the slug of a live post moves it.** Every link already shared to
>   the old address stops working. A slug another post has gets `-2` added, so
>   read the `slug` the result returns.
> - **A retry never duplicates a post.** A new post refuses an address another
>   post already has, with `409 slug_taken` and that post's `id` in
>   `error.details`. If you were retrying a create you never heard back from,
>   that is your post: read it with `get_blog_post` rather than creating again.
>   Two different posts with the same title on the same day need a `slug` of
>   your own for the second.
> - **`409 post_changed` means somebody saved the post after you read it**, and
>   nothing was written. Read it again and redo the change on what is there.
> - A line of its own reading `[[video:<url>]]` embeds a video: a YouTube link
>   plays inline, anything else shows as a plain link.

### `upload_blog_image` — a picture for a post

PNG, JPEG, WebP or GIF, up to 8 MB. Send the file as base64 `data`, or a public
https `url` the site downloads it from (the one to use over MCP). The format is
read from the image itself.

```bash
scripts/agent.sh upload_blog_image "$(jq -n --arg d "$(base64 -w0 mats.jpg)" \
  '{data:$d, name:"mats.jpg", alt:"The mats laid out for grading"}')"
scripts/agent.sh upload_blog_image '{"url":"https://images.example.com/belt.png","alt":"A brown belt"}'
```

The result has `path` (give it to `save_blog_post` as `cover_image_path` for the
picture at the top of the post) and `markdown` (paste it into `body_md` where the
picture belongs). Uploading changes no post: the picture appears nowhere until a
save puts it in one. `image_rejected` (422) means this image will never work;
`image_fetch_failed` (502) means the address could not be read just now.

Write `alt` for somebody who cannot see the picture: what is in it, not
"image".

### `delete_blog_post` — remove a post for good

Deletes the post and every comment on it, with no undo. To take a post off the
blog and keep it, save it with `"status":"draft"` instead.

```bash
scripts/agent.sh delete_blog_post '{"id":"<id>"}'
```

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
- Before publishing a blog post, show the manager the title and the text and
  say plainly that it goes public and is announced to members. Drafting is
  safe; publishing is the step to confirm. The same goes for
  `delete_blog_post`, which cannot be undone.
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
- The manifest's `version` tells generations apart (currently `"25"`), and its
  `changes` array says what each version actually moved, newest first, with
  `breaking: true` on any version that turns calls which used to succeed into
  errors. **There is no way to pin an older version** — the contract is
  latest-only, so `changes` tells you what moved rather than letting you opt
  out of it. If you
  cached the manifest at the start of a long batch, read `changes` rather than
  diffing prose — it calls out the calls that used to succeed and now refuse.
