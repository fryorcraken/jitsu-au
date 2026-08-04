# Memberships: plans, prices, and dated training periods

The product spec for how someone joins and pays. `docs/database.md` documents
the schema that backs this (the `## Membership ledger` section) and
`docs/check-in.md` what spends a session once someone is training; keep all
three aligned with the code in the same change.

## The model in one paragraph

A **plan** is what the club sells (free trial, casual class, a dated training
period, yearly insurance), and it carries everything about itself: its price
and how long it runs. A **membership** is one person's enrolment against a
plan: pending until paid, then active with a `starts_at`/`ends_at` window. A
plan's **kind** decides how it ends, and the manager screen asks for it as a
single plain-language question ("what kind of plan is this?"): a **training
period** runs between fixed dates (everyone who buys it gets exactly those
dates, regardless of when in it they joined), **yearly insurance** runs N days
from the moment payment clears, and a **casual class** or the **free trial**
ends with its session credits instead of on a date. There is no self-serve
sign-up: a membership only exists because someone bought one, or a manager
approved a waiver and the club's free trial was assigned automatically.

## Plans

| Plan               | Kind        | Shown to managers as       | Runs                                | What it buys                                      |
| ------------------ | ----------- | -------------------------- | ----------------------------------- | ------------------------------------------------- |
| `trial_2_session`  | `trial`     | Free trial                 | ends with its credits               | Two free classes, ever, no expiry.                |
| `casual_session`   | `session`   | Casual class or class pack | ends with its credits               | One class, tied to a session date.                |
| `2026-s2`, …       | `period`    | Training period            | fixed dates (`starts_on`/`ends_on`) | Unlimited classes for that training period.       |
| `insurance_yearly` | `insurance` | Yearly insurance           | rolling (`duration_days`)           | Club affiliation & insurance, 12 months from pay. |

The kind is the **only** control over how a plan runs: picking one on
`/manager/membership-plans` shows just that kind's fields and clears the
others, so a plan can never carry both a date range and a rolling duration
(which `savePlanSchema` rejects anyway). A `period` plan with no session
credits means unlimited classes for its dates, and the member purchase screen
says so. The database still permits any kind/date combination, so the manager
agent API can write one; the manager screen flags such a row rather than
hiding the values.

Each dated training period is **its own plan**, not a shared plan pointing at
a separate table of windows: "Semester 2 2026" and "Semester 1 2027" are two
rows, each with its own price and its own dates, so next year's can cost more
than this year's without touching anyone who already bought this year's.
Managers add, price and date plans on `/manager/membership-plans`; "Duplicate"
on an existing plan starts a new one pre-filled, with the dates cleared.

**The public pricing page (`/pricing`) is hand-written copy, not driven by
this catalogue.** It used to read the live plan list, but that breaks once
more than one dated plan can be on sale at once (this training period and the
next, at two different prices) — a marketing page cannot show two prices for
"membership". Only the member purchase screen (`/membership`, signed in) and
the manager screens read the live catalogue now. A price change is edited in
two places: the plan (immediate, drives what people actually pay) and the
pricing page copy (a code change, like any other website wording).

## Buying a dated plan

The member purchase screen shows one card per still-sellable plan — a dated
plan (`sellablePlans` in `src/lib/validation.ts`) stays listed until its
`ends_on` has passed, then drops off on its own with no manager step to retire
it; a plan not yet started is still offered (pre-sale). Whichever they pick,
the membership runs **exactly that plan's dates** — `00:00` on `starts_on`
through `23:59:59` on `ends_on`, both in the club's own timezone
(Australia/Sydney) — computed once at activation
(`planMembershipWindow`/`activateMembershipRow` in `src/lib/membership.functions.ts`
and `src/lib/validation.ts`) and never touched again. That last point matters
for a manager correcting a plan's dates after some memberships have already
activated against it: the correction only changes what a membership activated
**from now on** gets. Anyone already active keeps the dates they were given —
there is no re-sync.

**There is no pro rata.** Joining in week one or week ten costs the same. A
late joiner who would rather pay for only what is left is pointed at the
casual per-class rate instead — that is what it is for.

## Staying a member through the break

Nothing in the app closes a membership automatically when its `ends_at`
passes — see `docs/check-in.md`'s "When the last session goes" — so a member
who paid for the period just finished keeps their `member` role, and with it
the members-only calendar and blog comments, straight through the winter or
summer break and into the next period's first class. That is deliberate: the
alternative (locking members out at the exact hour a period ends) would drop
the whole club out of members-only areas every few months for no product
reason. The trade-off is symmetric with every other plan in this app: someone
who never comes back also keeps that access until a check-in eventually
closes their membership, or a manager cancels it by hand.

## Reconciliation and invoices

An "invoice" is a `memberships` row: its `price_cents`, `payment_reference`
and `status` **are** the invoice. A member buying a dated plan pending payment
gets a reference tagged to that plan's start date (so buying next period while
an invoice for this period is still sitting pending reconciles to the right
one — different periods are different `plan_id`s, so this falls out on its
own), and reconciliation, activation and cancellation follow the same
`edit_invoice` / bank-reconciliation flow as any other plan — see
`.claude/skills/uts-manager-agent/SKILL.md` and `/manager/reconciliation`.

## Manager screens & the manager agent API

| Manager UI                  | Manager agent actions                            | What it does                                   |
| --------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `/manager/membership-plans` | `list_membership_plans` / `save_membership_plan` | Add, price, date, retire, or duplicate a plan. |
| `/manager/memberships`      | `list_invoices` / `edit_invoice`                 | See and correct invoices.                      |

Per this repo's standing rule (`AGENTS.md`, "Manager agent API"), the agent
actions mirror what a manager can do in the UI — see the skill file for the
full parameter list and worked examples.
