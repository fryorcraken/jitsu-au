# Memberships: plans, prices, and the semester calendar

The product spec for how someone joins and pays. `docs/database.md` documents
the schema that backs this (the `## Membership ledger` section) and
`docs/check-in.md` what spends a session once someone is training; keep all
three aligned with the code in the same change.

## The model in one paragraph

A **plan** is what the club sells (free trial, casual class, one semester,
yearly insurance). A **membership** is one person's enrolment against a plan:
pending until paid, then active with a `starts_at`/`ends_at` window. Most
plans run a **rolling** window — N days from the moment payment clears — but
the **semester** plan runs a **fixed** window: the club's own semester dates,
chosen by the member at purchase, the same for everyone regardless of when in
it they joined. There is no self-serve sign-up: a membership only exists
because someone bought one, or a manager approved a waiver and the club's free
trial was assigned automatically.

## Plans

| Plan               | Kind        | Basis    | What it buys                                      |
| ------------------ | ----------- | -------- | ------------------------------------------------- |
| `trial_2_session`  | `trial`     | rolling  | Two free classes, ever, no expiry.                |
| `casual_session`   | `session`   | —        | One class, tied to a session date.                |
| `semester`         | `period`    | semester | Unlimited classes for one club semester.          |
| `insurance_yearly` | `insurance` | rolling  | Club affiliation & insurance, 12 months from pay. |

Managers edit prices, activity and (for a `period` plan) the rolling/semester
basis on `/manager/membership-plans`. The public pricing page and the member
purchase screen both read the live catalogue, so a price change there is
immediate everywhere.

## The club's semesters

The club sells **two semesters a year** — no summer term — on `club_semesters`:
a `code` (`<year>-s<1|2>`), a `name`, and a `starts_on`/`ends_on` date range
(inclusive of the last day). These are **the club's own dates**: aligned with
the UTS teaching calendar, but entered by a manager and free to differ from it
by a week either way, and they move every year. Nothing in the app derives
them from UTS — a manager sets each year's dates on `/manager/semesters` (or
through the manager agent's `list_semesters`/`save_semester` actions) before
enrolments open for it.

Two semesters can never have overlapping dates — the database enforces it —
so "the semester running today" is never ambiguous.

## Buying a semester

At purchase, a member picks from a **short list**: the semester running today
(if any) plus the next one to start (`sellableSemesters` in
`src/lib/validation.ts`). Whichever they pick, the membership runs **exactly
that semester's dates** — `00:00` on `starts_on` through `23:59:59` on
`ends_on`, both in the club's own timezone (Australia/Sydney) — computed once
at activation (`activateMembershipRow` in `src/lib/membership.functions.ts`)
and never touched again. That last point matters for a manager correcting a
semester's dates after some memberships have already activated against it:
the correction only changes what a membership activated **from now on** gets.
Anyone already active keeps the window they were given — there is no re-sync.

**There is no pro rata.** Joining in week one or week ten costs the same. A
late joiner who would rather pay for only what is left is pointed at the
casual per-class rate instead — that is what it is for.

## Staying a member through the break

Nothing in the app closes a membership automatically when its `ends_at`
passes — see `docs/check-in.md`'s "When the last session goes" — so a member
who paid for the semester just finished keeps their `member` role, and with it
the members-only calendar and blog comments, straight through the winter or
summer break and into the next semester's first class. That is deliberate: the
alternative (locking members out at the exact hour a semester ends) would drop
the whole club out of members-only areas every few months for no product
reason. The trade-off is symmetric with every other plan in this app: someone
who never comes back also keeps that access until a check-in eventually closes
their membership, or a manager cancels it by hand.

## Reconciliation and invoices

An "invoice" is a `memberships` row: its `price_cents`, `payment_reference`
and `status` **are** the invoice. A member buying a semester plan pending
payment gets a reference tagged to that semester (so buying Semester 1 while a
Semester 2 invoice from last time is still sitting pending reconciles to the
right one), and reconciliation, activation and cancellation follow the same
`edit_invoice` / bank-reconciliation flow as any other plan — see
`.claude/skills/uts-manager-agent/SKILL.md` and
`/manager/reconciliation`.

## Manager screens & the manager agent API

| Manager UI                  | Manager agent actions              | What it does                                                   |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `/manager/membership-plans` | —                                  | Edit a plan's price, activity, rolling/semester basis.         |
| `/manager/semesters`        | `list_semesters` / `save_semester` | Add or edit a semester's dates.                                |
| `/manager/memberships`      | `list_invoices` / `edit_invoice`   | See and correct invoices, including which semester one is for. |

Per this repo's standing rule (`AGENTS.md`, "Manager agent API"), the agent
actions mirror what a manager can do in the UI — see the skill file for the
full parameter list and worked examples.
