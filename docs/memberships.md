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
sign-up: a membership only exists because someone bought one, because a manager
raised it for them, or because a manager approved a waiver and the club's free
trial was assigned automatically.

## Plans

| Plan               | Kind        | Shown to managers as       | Runs                                | What it buys                                      |
| ------------------ | ----------- | -------------------------- | ----------------------------------- | ------------------------------------------------- |
| `trial_2_session`  | `trial`     | Free trial                 | ends with its credits               | Two free classes, ever, no expiry.                |
| `casual_session`   | `session`   | Casual class or class pack | ends with its credits               | One class, tied to a session date.                |
| `2026-s2`, …       | `period`    | Training period            | fixed dates (`starts_on`/`ends_on`) | Unlimited classes for that training period.       |
| `insurance_yearly` | `insurance` | Yearly insurance           | rolling (`duration_days`)           | Club affiliation & insurance, 12 months from pay. |

A plan that ends with its credits carries a `starts_at` for the record, but
**nothing reads it as a limit**: at check-in a credit balance covers any class
until the credits run out, including one held before the membership existed
(`docs/check-in.md`). Training is a fact that already happened, and late
paperwork must not be able to unmake it. The auto-assigned trial still dates
itself from the day its **waiver was signed** rather than the day a manager
approved it, so the row reflects when the entitlement was really earned.

The kind is the **only** control over how a plan runs: picking one on
`/manager/membership-plans` shows just that kind's fields and clears the
others, so a plan can never carry both a date range and a rolling duration
(which `savePlanSchema` rejects anyway). A `period` plan with no session
credits means unlimited classes for its dates, and the member purchase screen
says so. The database still permits any kind/date combination, so the manager
agent API can write one; the manager screen flags such a row rather than
hiding the values.

The screen also refuses to save a plan that could never end: a training period
with no dates, yearly insurance with no day count, or a casual/trial plan with
no session credits. `savePlanSchema` allows all three, but they activate to
`ends_at: null` (`planMembershipWindow`) while still passing `sellablePlans`,
so the membership never expires. For the two credit kinds it is worse:
`resolveCoverage` matches no tier at all (`docs/check-in.md`), so the member
is sold something that covers no class either. The old generic `semester` plan
was exactly that shape and is deleted by
`20260805000000_delete_generic_semester_plan.sql`.

The guard only applies to a shape a manager is actually changing: a row that
arrived malformed (written through the manager agent API, which the database
still permits) can still be renamed or taken off sale without fixing it first.

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
who paid for the period just finished keeps the members-only calendar and blog
comments straight through the winter or summer break and into the next period's
first class. That is deliberate: the alternative (locking members out at the
exact hour a period ends) would drop the whole club out of members-only areas
every few months for no product reason. The trade-off is symmetric with every
other plan in this app: someone who never comes back also keeps that access
until a check-in eventually closes their membership, or a manager cancels it by
hand.

**Members-only access is not gated on the `member` role.** It is gated live by
the `has_active_paid_membership` SQL helper — an active, non-`trial`,
`price_cents > 0` membership — which the RLS policies on the calendar and blog
comments call directly. So the moment a membership is cancelled, access closes,
with no role change involved.

The `member` role row is a **label**: what `/manager/users` and the agent API's
`list_users` report. It used to be granted on a paid activation and never taken
back, so somebody tidied up months ago still read as a member. `syncMemberRole`
in `src/lib/membership.functions.ts` now owns that rule in one place and
reconciles it after every activation, cancellation and deletion. A failed read
leaves the label alone: "the query fell over" must never be answered the same
way as "they hold nothing", because the second one revokes.

**Expiry deliberately does not reconcile the label**, only an explicit cancel
does. That is the same break rule as above: a period ending is not somebody
leaving the club, and a manager cancelling is.

## Closing and clearing up

Three things a manager can do to an existing membership, from either
`/manager/memberships` or the person's own page at `/manager/users/<id>`. Both
screens share `MembershipRowActions`, so the rules cannot drift between them.

**Cancel** works from any state, including `pending`. Cancelling a pending
invoice is the ordinary tidy-up for somebody who said they would join and never
paid, and it used to be impossible: the only button on a non-active row was
Activate, which marks it paid, grants the label and **emails them that their
membership is live**. Cancelling keeps the row, its dates and its credits;
re-activating still works.

**Delete** removes the row outright, for an invoice that should never have
existed. `whyMembershipCannotBeDeleted` (in `src/lib/validation.ts`) refuses it
for three reasons, and reports **all** that apply rather than the first found —
a manager who clears one blocker only to be refused by the next has been sent
round the loop for nothing:

| Blocker    | Why                                                            | What to do instead                  |
| ---------- | -------------------------------------------------------------- | ----------------------------------- |
| `paid`     | `paid_at` set: the club's record of money that actually moved. | Cancel it. Never deletable.         |
| `active`   | It is still running.                                           | Cancel it first, then delete.       |
| `attended` | A class was checked in against it.                             | Move those check-ins first (below). |

`attended` is not bookkeeping fussiness: `session_checkins.membership_id` is
`ON DELETE SET NULL`, so without the guard the delete would succeed and quietly
turn a class somebody trained at into an uncovered one.
`bank_transactions.matched_membership_id` points the same way, but a matched
transaction always implies `paid_at`, so `paid` already covers it.

**Move a check-in to another membership** (`transferCheckInCoverage` in
`src/lib/checkin.functions.ts`) is what clears the `attended` blocker, and the
only way to correct wrong coverage without destroying the record: previously a
manager had to undo the check-in and record it again, which deletes the row and
loses `checked_in_at`, the record of when they were actually on the mat. It
releases the row with a compare-and-swap against the coverage it had, refunds
the old membership's credit only once that release is won, then finishes through
the same `applyCoverage` the door runs — so a target that cannot cover the class
lands it uncovered and warns, rather than being force-fitted. See
`docs/check-in.md`.

## A manager raising somebody's membership

`createMembershipForUser` is the manager's counterpart to a member pressing
"Choose" on `/membership`, and both go through the same `enrolMember`. It lands
a **pending** invoice carrying the payment reference the member would quote on a
transfer, so it reconciles off a bank statement normally. It never activates:
that stays the separate press, because activating emails them and grants the
label.

Two things differ from a member's own purchase, and both follow from a manager
often writing down an enrolment that already happened rather than selling one:

- **Any plan, not just a sellable one.** `startMembership` refuses anything
  outside `sellablePlans`; a manager can pick a past training period, which is
  what backfilling needs. The screen groups those under "No longer on sale" so
  it cannot happen by accident.
- **Insurance is their call.** A member with no current cover cannot decline it
  (see "Buying a dated plan"); a manager can, because an enrolment that really
  did happen without cover is history, not a sale.

`send_email: false` records the invoice without telling anyone about it, so
backfilling last semester does not invoice the whole club for it. The free trial
is still once per person ever, however it is raised.

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

| Manager UI                        | Manager agent actions                            | What it does                                   |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `/manager/membership-plans`       | `list_membership_plans` / `save_membership_plan` | Add, price, date, retire, or duplicate a plan. |
| `/manager/memberships`            | `list_invoices` / `edit_invoice`                 | See and correct invoices.                      |
| both membership screens           | `edit_invoice` (`status`) / `delete_invoice`     | Cancel from any state; delete a junk invoice.  |
| `/manager/users/<id>`             | `create_membership`                              | Raise a membership for a person.               |
| `/manager/users/<id>` (check-ins) | none                                             | Move a check-in to another membership.         |

Moving a check-in is the one row with no agent equivalent: the API has no
check-in actions at all, and adding the first one is a wider decision than this
needed. It means an agent cannot clear an `attended` delete blocker on its own.

Per this repo's standing rule (`docs/manager-agent-api.md`), the agent
actions mirror what a manager can do in the UI — see the skill file for the
full parameter list and worked examples.
