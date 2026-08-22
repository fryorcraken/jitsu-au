# Memberships: plans, prices, and dated training periods

The product spec for how someone joins and pays. `docs/database.md` documents
the schema that backs this (the `## Membership ledger` section) and
`docs/check-in.md` what spends a session once someone is training; keep all
three aligned with the code in the same change.

## The model in one paragraph

A **plan** is what the club sells (free trial, casual class, a dated training
period, yearly insurance), and it carries everything about itself: its price
and how long it runs. A **membership** is one person's enrolment against a
plan. It is **authorised** the moment it is raised — `active`, with its
`starts_at`/`ends_at` window and its credits — and its invoice is outstanding
until somebody records a payment. Those are two separate facts about the same
row, and keeping them apart is what lets a member train while their transfer
clears. A
plan's **kind** decides how it ends, and the manager screen asks for it as a
single plain-language question ("what kind of plan is this?"): a **training
period** runs between fixed dates (everyone who buys it gets exactly those
dates, regardless of when in it they joined), **yearly insurance** runs N days
from the moment it is raised, and a **casual class** or the **free trial**
ends with its session credits instead of on a date. There is no self-serve
sign-up: a membership only exists because someone bought one, because a manager
raised it for them, or because a manager approved a waiver and the club's free
trial was assigned automatically.

## Plans

| Plan               | Kind        | Shown to managers as       | Runs                                | What it buys                                                    |
| ------------------ | ----------- | -------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `trial_2_session`  | `trial`     | Free trial                 | ends with its credits               | Two free classes, ever, no expiry.                              |
| `casual_session`   | `session`   | Casual class or class pack | ends with its credits               | One class, tied to a session date.                              |
| `2026-s2`, …       | `period`    | Training period            | fixed dates (`starts_on`/`ends_on`) | Unlimited classes for that training period.                     |
| `insurance_yearly` | `insurance` | Yearly insurance           | rolling (`duration_days`)           | Club affiliation & insurance, 12 months from when it is raised. |

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

**The free trial is two sessions, used at any point during the semester**, and
that is the most the site may claim. `/first-class` states the terms in full.
`/pricing` sold the same offer as year-round in three places ("all year long",
"every day of the year", "always free") and the footer repeated it site-wide
("all year round"), which promised more than the club honours. Shorter
statements ("first two sessions free", "your first two are on us") are fine:
they state the offer without claiming a window. `free-trial-copy.test.ts`
fails the suite if a year-round claim comes back, and pins the qualifier on
`/pricing` and `/first-class`.

A plan's own `description` is bound by the same rule and is the one place the
guard cannot see, because it is **data**: managers type it on
`/manager/membership-plans` and `/membership` prints it. The trial plan's
seeded description (`20260722000000_memberships.sql`) predates the rule and
still reads "Your first two sessions, free all year round.", so signed-in
members are shown the year-round claim the public pages no longer make.
Correcting it is a manager edit on that screen, not a code change: editing the
applied migration would change nothing live and only cause drift.

That is the club's **offer**, not the membership row. The `trial_2_session`
plan is a credit balance with no expiry (above), so a manager can still check
someone in on a leftover trial session after the semester ends. The two are
allowed to differ: the site promises the smaller thing, and the club can
honour more than it promised.

The pricing page's call to action (`MembershipCta`) reads who is looking before it decides
where to send them, because `/membership` is behind the auth gate and there is
no self-serve sign-up: a login exists only once a manager has approved your
waiver. A signed-in member gets "Manage your membership" straight to
`/membership`. Everyone else gets "Join the club" into `/register-interest`,
plus a sign-in link carrying `redirect=/membership` for a member who happens to
be signed out. That redirect is honoured when they already have a live session
and when they sign in with a password; the emailed magic link still finishes on
`/account`, because `MagicLinkSignIn` hard-codes its `emailRedirectTo` and never
sees the parameter (true of every `?redirect=` link on the site, not just this
one). Until the browser has resolved the session it shows the signed-out
branch, which is what the server renders anyway and is right for almost
everyone reading a public pricing page.

**Any other public page linking into `_authenticated` needs the same
treatment**, for the same reason: the gate behind it has nothing a person
without a login can do.

## What an ended membership is called

`memberships.status = 'expired'` is one stored word for two different endings,
and reading it out loud was wrong half the time. A training period or a year of
insurance really does expire: a date passed. A free trial or a casual class does
not — it holds a **number of classes**, and it ends when they are used up. So
the screens name the ending from the plan's **kind**, not from the status:

| The plan ends with | Ended row reads | When                                      |
| ------------------ | --------------- | ----------------------------------------- |
| session credits    | **Used up**     | the row is `expired` AND its balance is 0 |
| session credits    | **Expired**     | `expired` with classes still on the row   |
| a date             | **Expired**     | always                                    |

`isUsedUp` in `src/lib/status-labels.ts` owns that test, and which plans are
sold as classes comes from `endsWithCredits` in `src/lib/validation.ts` (it
reads `creditsRequired` off `PLAN_TYPES`, so the two cannot drift).

**The balance is asked, not inferred from the status**, and that middle row is
why. A credit plan can sit `expired` with classes still in it: undoing a
check-in refunds the credit but reopens the membership only when that same
check-in is the one that closed it (`refundCheckInCredit` in
`src/lib/checkin.functions.ts`), so undoing an EARLIER visit gives the class
back and leaves the row closed. A manager can also expire a never-used trial by
hand through `edit_invoice` or `setMembershipStatus`. "Expired" was vague enough
to survive those; "Used up" is a specific claim, printed next to the balance on
the same row, so it has to agree with it.

The person-level funnel phase has the same problem in miniature. `lapsed` is
derived both for somebody whose paid membership ended and for somebody who came
to their two free classes and stopped, and only the first has lapsed — the
second is the club's warmest lead, with no membership to renew. The phase reads
**Trial used up** when their newest membership is a free trial that **expired**,
and `/membership` tells them "You've used your free trial classes. Pick a plan
below to keep training." instead of offering a renewal. Both halves of that test
matter:

- **newest**: the trial is assigned at waiver approval, so in practice it is a
  person's oldest membership and one that is still their newest means nothing
  followed it. Not an invariant the database enforces: a manager can raise an
  invoice for an applicant before approving their waiver, which makes the trial
  the newer row. It costs nothing when it happens, because such a trial is
  `active` and so is neither `lapsed` nor used up.
- **used up**: `lapsed` is derived from `expired` **or** `cancelled`, and a
  cancelled trial may have both its classes sitting untouched. Being `expired`
  is not proof either, for the reasons above, so the phase asks the same
  `isUsedUp` the row's own label asks: ended, sold as classes, and none left.

`isTrialUsedUp` owns that test, and both `lifecycleLabel` (the manager's pill)
and `/membership` (the member's card) call it rather than re-deciding, so the
two cannot disagree about the same person. Only the blurb is the member page's
own.

**The stored vocabulary is deliberately untouched.** `expired` and `lapsed` are
still what the database, `deriveLifecycleStatus`, the `/manager/users` filter and
the manager agent API speak; only the words a human reads change. The label maps
live in `src/lib/status-labels.ts`, the naming counterpart to
`src/lib/status-colours.ts`, and both are keyed by their status unions so a new
status fails the typecheck until it has been given a word and a colour. Labels
come out sentence-cased, so callers pass `preserveCase` to `<Pill>`.

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

That helper's **name is now a leftover**: it never read `paid_at`, and since
`active` means authorised rather than paid, what it actually asks is "do they
hold a real membership". Members-only areas therefore open when a membership is
raised, not when its invoice is settled — deliberately, and the same rule
`deriveLifecycleStatus` and `syncMemberRole` use. Renaming a function that RLS
policies call would mean a migration and a production apply gate for a cosmetic
gain, so it keeps the name.

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

What a manager can do to an existing membership, from either
`/manager/memberships` or the person's own page at `/manager/users/<id>`. Both
screens share `MembershipRowActions`, so the rules cannot drift between them.

**Mark as paid** records the money and is the manual counterpart to bank
reconciliation, for cash at the door or anything else that never touches the club
account. It writes `paid_at` through `recordMembershipPayment` — the only writer
of that column — emails a receipt, and is idempotent, so a second press records
nothing and re-sends nothing. There is no **Activate** button any more, because
there is nothing left for it to do: a membership is authorised from the moment it
is raised. **Reopen** is the narrow leftover, putting a cancelled or expired
membership back into service, and it says nothing about money either way.

**Cancel** works from any state and is the ordinary tidy-up for somebody who said
they would join and never paid. It keeps the row, its dates and its credits;
reopening still works.

**Delete** removes the row outright, for an invoice that should never have
existed. `whyMembershipCannotBeDeleted` (in `src/lib/validation.ts`) refuses it
for two reasons, and reports **both** when both apply rather than the first found
— a manager who clears one blocker only to be refused by the next has been sent
round the loop for nothing:

| Blocker    | Why                                                            | What to do instead                  |
| ---------- | -------------------------------------------------------------- | ----------------------------------- |
| `paid`     | `paid_at` set: the club's record of money that actually moved. | Cancel it. Never deletable.         |
| `attended` | A class was checked in against it.                             | Move those check-ins first (below). |

**Being active is deliberately not a blocker.** Every membership is active from
the moment it exists, so refusing on it would make every delete a two-step
cancel-first. And `paid_at` needed no propping up with `price_cents > 0` once
authorising stopped writing it: it had been stamped on every activation, free
trials included, which is what made a hand-authorised membership permanently
undeletable and refused it with a reason the club knew to be false.

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
"Choose" on `/membership`, and both go through the same `enrolMember`. The
membership is authorised immediately whatever the plan costs, carrying the
payment reference the member would quote on a transfer, so its invoice reconciles
off a bank statement normally. Recording the money stays a separate act, because
that is what emails a receipt and makes the row permanent.

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

That suppression is only ever about the RAISING email, though. If a casual
credit raised with `send_email: false` is later actually spent — checked in at
the door, or attached to an old uncovered check-in — the check-in itself
guarantees an invoice or receipt for it regardless, on the reasoning that
someone who really trained on a credit should not be the one left with no
record of what they owe or paid. See "A casual credit is invoiced when it is
spent, not just when it is raised" in `docs/check-in.md`.

## Reconciliation and invoices

An "invoice" is a `memberships` row: its `price_cents`, `payment_reference`
and `status` **are** the invoice. A member buying a dated plan pending payment
gets a reference tagged to that plan's start date (so buying next period while
an invoice for this period is still sitting pending reconciles to the right
one — different periods are different `plan_id`s, so this falls out on its
own), and reconciliation, activation and cancellation follow the same
`edit_invoice` / bank-reconciliation flow as any other plan — see
`.claude/skills/uts-manager-agent/SKILL.md` and `/manager/reconciliation`.

### Reading the statement CSV

The file a manager drops on `/manager/reconciliation` is parsed by
`src/lib/bank-statement-csv.ts` (in `src/lib/`, not in the route, so every case
below is a unit test in `bank-statement-csv.test.ts`). It handles quoted fields
with commas in them, doubled `""` inside a quoted field, `\r\n` and lone `\r`
endings, a leading BOM, blank lines, and a last row with no newline after it.
Dates are read day-first (`01/08/2026` is 1 August) or as ISO, with any time
after them ignored. Amounts go through `parseMoneyToCents`, so `$1,234.50` is
fine.

Four things are decided rather than obvious:

- **The header row is the first row of the file**, and the import **refuses a
  file whose Date, Amount or Description column it cannot find**, naming the
  ones it could not. Every one of those is resolved by substring
  (`transaction date` matches `date`), and a missing one used to import zero
  rows and say "no credit transactions found", which reads exactly like a quiet
  month. A bank that prints its account summary above the headings is the same
  failure, so the message says to delete anything above them.
- **A credit or deposit column wins over a plain amount column, and nothing
  naming a debit, a withdrawal, a limit or a balance is ever the amount.** An
  export with `Debit Amount` beside `Credit Amount` otherwise resolved to the
  debit one, and every card purchase in the statement imported as money coming
  in. The same rule keeps a `Debit/Credit` indicator column (which holds `DR` /
  `CR`, not a sum) and a `Credit Limit` out of it. A credit header only wins
  when the rest of it agrees it is a money column, so `Credit Card Surcharge`
  is a fee and loses to a plain `Amount`.
- **When the direction lives in its own DR/CR column, that column is read.**
  Some exports leave the amount unsigned and put `DR` / `CR` beside it. Rows
  marked as going out are dropped; a cell we do not recognise leaves its row
  alone, because dropping a credit is the more expensive mistake.
- **A date that is not a real calendar date is dropped, not passed on.** A
  US-formatted export reads `08/13/2026` as day 8 of month 13, which clears the
  row schema's regex and then kills the entire import at insert time on a raw
  Postgres range error. The row keeps its amount and description and shows no
  date, which is the same as any other date we cannot read. That means a wholly
  US-formatted export imports dateless rather than being refused: worth
  revisiting if one ever turns up.
- **Only positive amounts are kept**, because only an incoming credit can pay a
  membership. Reference is optional. The description is taken from the first of
  `description`, `narrative`, `details`, `memo`, `reference` that the file has,
  in that order rather than in column order, so a file carrying both a bare
  reference and a human-readable narrative shows the narrative to the manager.

## Paying an invoice

The member sees everything they need to pay on `/membership` itself: a **How to
pay** panel above the plan list carrying the amount, the payment reference, and
the club's bank account. Any signed-in person can read the club's account, not
only someone who owes money.

The panel appears only while something is unpaid, and it counts **transfers, not
rows**: a plan bought with yearly insurance is two pending memberships behind one
reference, so it shows as one payment with the split underneath, matching the
single combined amount the email quotes. The memberships table above it stays the
per-row record.

**The invoice email is a second copy of the same details, not a replacement**, so
a member who deleted the email is not stuck, and it links back to the page.

### The club's account is fields, not prose

The account is eight named values under the `club_settings` key
`invoice_payment_details` (a JSON blob), edited on `/manager/settings`, and
**every one of them has its own copy button** on the page. That is the whole
reason it is structured: a member is in a banking app on a phone, and a block of
prose gives them one thing to select by hand.

- **Account name, BSB, account number, bank** are required **together**. A
  half-filled account never parses, because it looks payable: somebody copies the
  BSB, finds no account number, and guesses. An incomplete set is treated exactly
  like nothing published.
- **SWIFT/BIC, bank address, account holder address** are each optional and sit
  behind a "Paying from overseas?" disclosure, hidden entirely when all three are
  blank. Australia has no IBAN, so the BIC (the same thing as a SWIFT code, 8 or
  11 characters) plus the BSB and account number is what a sending bank abroad
  asks for.
- **The note** is the one free-text field left, markdown, with no copy button.

The BSB is stored as six bare digits and displayed **and copied** as `062-000`,
formatted in one place (`clubPaymentFieldValue`) so what is on screen and what
lands on the clipboard cannot disagree. `CLUB_ACCOUNT_FIELDS` /
`CLUB_INTERNATIONAL_FIELDS` in `src/lib/validation.ts` are the single ordered
list both the page and the email walk, which is what stops the two drifting.

**An overseas transfer often arrives short**, because a bank in the middle took a
cut. Reconciliation matches on the reference _and the exact amount_
(`matchesMembershipReference`), so a short payment does not activate anything and
waits for a manager. The overseas block says so before anyone pays.

### Before the club has published an account

The page and the email both say the club has not published its details yet and to
get in touch, rather than rendering an empty block. `/manager/settings` leads with
a warning while that is true, and shows whatever free text is left in the old
`invoice_payment_instructions` row read-only, so the values can be copied across.
Nothing member-facing reads that legacy row any more; it is deleted in a later
change.

A failed **read** of the settings is kept apart from a club that never published
anything (`readClubPaymentDetails` returns `ok`), because the two say different
things to somebody about to transfer money.

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
