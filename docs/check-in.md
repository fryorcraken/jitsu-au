# Check-in: who was on the mat, and what paid for it

The product spec for check-in at the door. `docs/database.md` documents the
schema that backs this (the `## Check-ins` section) and `docs/calendar.md` the
classes it hangs off; keep all three aligned with the code in the same change.

## The model in one paragraph

A **manager** checks people in at the door, against a **class that is really on
the calendar**. Checking someone in is what **spends a session**: a free trial
credit, then a casual class credit, and only then an unlimited semester
membership, which is never used up. When nothing covers it, the person is
**still checked in** and the check-in lands in a **needs-attention** list to be
attached to a membership once they are sorted out. Every check-in counts toward
a person's **sessions attended**, which is how many classes they have trained,
whatever paid for them.

## Who can be checked in

Anyone with a **waiver on file**, which in practice means anyone the club has a
person record for. There are no guest rows and no free-text names: a walk-in
signs the waiver on their phone and then appears in the list. The database says
the same thing, since a check-in's person is a foreign key to `profiles`.

## What pays for a class

In order, highest first:

| Order | What                                     | Spends a session? |
| ----- | ---------------------------------------- | ----------------- |
| 1     | A **free trial** with sessions left      | Yes               |
| 2     | Any other **credit** membership (casual) | Yes               |
| 3     | An unlimited **period** membership       | No                |
| 4     | Nothing → the check-in is **uncovered**  | No                |

- **Trial first**, because the trial is the club's promise ("your first two
  sessions, free"). If an unlimited pass swallowed one, the member has paid for
  something they were given, and the club loses the number its funnel is judged
  on.
- **Credits before unlimited**, because a credit is a finite prepaid balance
  with its own lifetime and an unlimited membership costs nothing extra to draw
  on. It is the only order in which a casual pass bought before a semester does
  not quietly die unused.
- **Yearly insurance never covers a class.** It buys affiliation and cover, not
  mat time.
- **An unpaid membership still covers a class.** Being authorised is what
  entitles somebody to train, and that happens when the membership is raised, so
  a member training while their transfer clears is covered and the door sees a
  "waiting on payment" flag beside it. Only a **cancelled** or **expired**
  membership covers nothing.
- **No date ever gates a credit.** A free trial or casual pass is a balance, not
  a window: it covers any class at all until its credits run out, including one
  held before the membership row existed. Someone having trained is a fact that
  already happened, and paperwork catching up cannot unmake it — a waiver signed
  at the door after the class began, or filed from paper a week later, still
  pays with the credits it earned. That is also what lets a manager attach an
  old uncovered check-in to a trial granted afterwards.
- A **dated** membership is the one thing dates still apply to, because the
  range of days _is_ what was bought: a training period covers its own dates and
  not classes before or after them.

Between two memberships in the same tier, the one that **runs out soonest** is
used, so nothing expires unspent.

> If it ever feels wrong that someone holding a semester pass still burns a
> leftover trial credit, the alternative is "the most recently bought thing
> wins". That is a one-line change to the precedence in `src/lib/checkin.ts`
> plus a test, and it was left out deliberately rather than missed.

## When the last session goes

The membership **closes itself** (its status becomes finished). The next time
that person is checked in they show as **No cover**, which is the prompt to talk
to them about signing up. Undoing that check-in gives the session back and
reopens the membership, but only the one this check-in closed: a membership a
manager ended by hand stays ended.

A membership whose **end date has passed** does not cover a class either, and is
closed on sight. Nothing else in the app enforces an end date, so a check-in is
where a finished semester finally stops reading as current.

## A casual credit is invoiced when it is spent, not just when it is raised

Every check-in that draws on a **casual credit** (`coverage: "session"` — a
casual class, or any future credit pack) guarantees the member has an invoice
or receipt for it, whichever their credit is currently owed:
`ensureCasualInvoiceEmailed` in `src/lib/membership.functions.ts`, reached from
`applyCoverage` for the door, an attach and a move alike, since all three are
the same act of actually spending the credit.

This exists because the email a casual credit's invoice sends when it is
**raised** (`enrolMember`, see `docs/memberships.md`) is not a guarantee: a
manager can raise it with `send_email: false` (the backfill case), or the send
can simply fail, since every email in this lifecycle is best-effort. Someone
who has already paid before the class, or who bought the credit weeks ago and
is only now spending it, still gets the email a check-in guarantees — the send
is idempotent on the membership id (the same key `enrolMember` and
`recordMembershipPayment` already use), so a credit that was already emailed
just gets a harmless repeat, not a duplicate in anyone's inbox.

It never REFUSES a check-in: like every email in this app, a failed or slow
send is caught and logged, never thrown, so a check-in is never withheld
because an email could not be built or sent (see rule 5 below). It is,
however, awaited before the check-in call returns — the same as
`enrolMember`'s and `recordMembershipPayment`'s own emails — so a slow send
does add a moment to the door's response. That is a deliberate trade, not an
oversight: the production deploy target is Cloudflare, where work not awaited
before the response returns is not guaranteed to run at all, and a
"guarantee" that can silently not happen defeats the point of this existing.

## Which class

The screen opens on the class that is **on now or next**: today's, the closest in
time if several are on today, otherwise the nearest either side of today. "Today"
means today at the club (Australia/Sydney), not in UTC, so a morning class is not
filed under yesterday. **Cancelled classes are never offered** — you cannot check
people in to a class that did not run.

## Manager actions

1. **Check someone in** — search by name or email, see what will pay for it
   before pressing the button, press it. Their sessions left goes down.
2. **Undo** — removes the check-in and gives the session back.
3. **Attach** — give an uncovered check-in its cover, from the needs-attention
   list or from the person's own page. By default it re-runs the same rules the
   door would have applied, which is the right answer once a late bank transfer
   has been reconciled; a manager can override and name the membership instead.
4. **Move** — take a check-in that IS covered and put it on a different
   membership, from the person's page. The mirror of Attach, for cover that
   landed on the wrong membership rather than nowhere. Naming the target is
   required here, not optional: re-running the door's rules would pick the same
   membership again. It is also what frees a membership up to be **deleted**,
   since a membership with classes checked in against it cannot be
   (`docs/memberships.md`).

   Until this existed the only correction was Undo followed by a fresh check-in,
   which deletes the row and loses `checked_in_at` — the record of when they were
   actually on the mat.

   The order is the same guard Undo uses. The row is **released first**, with a
   compare-and-swap against the coverage it held, and the old membership's credit
   is refunded only once that release is won: exactly one caller can win, so
   exactly one refund is attempted. Refunding first would let two managers moving
   the same check-in hand back two credits for one class. The move then finishes
   through the ordinary `applyCoverage`, so if the chosen membership cannot
   actually cover the class (wrong dates, no credits left) the check-in lands
   **uncovered** and says so, rather than being force-fitted. The credit comes
   off the old membership either way — that is what the manager asked for — and
   the needs-attention list already knows how to deal with the result.

## Rules

1. **Managers write, nobody else.** Every check-in is a manager-only server
   function that re-checks the role and writes through the service-role client.
   The client roles hold no privilege on the table at all.
2. **A check-in belongs to a class on the calendar.** Enforced as a foreign key,
   not a convention.
3. **One check-in per person per class**, enforced by a unique constraint. That
   constraint is also half the concurrency guard: two managers tapping the same
   name race there and exactly one wins. It only guards _creating_ a check-in,
   though, so **attaching** cover claims the existing row instead, and a manager
   who loses that race has the credit handed straight back rather than spent.
4. **The row is written before the credit moves.** If anything fails in between,
   the result is an uncovered check-in that the needs-attention list already
   knows how to fix. The other order fails as a spent credit with no attendance
   record, which nobody ever notices.
5. **Never refuse someone at the door.** No cover is a flag, not a rejection.
6. **Coverage is resolved against the class's start time**, not the current time,
   so a manager checking people in ten minutes late (or fixing yesterday's roster
   this morning) gets the same answer they would have got at the door.
   **Attendance is a fact, not a claim to be validated.** No check-in is ever
   refused (rule 5), and no credit is ever withheld because of when the
   paperwork landed: the club records what happened and pays for it out of what
   the person is entitled to. Dates only decide what a **dated** membership
   bought.
7. **Being authorised is what covers a class, not having paid.** A membership is
   `active` from the moment it is raised, so a member can train while their
   transfer clears. The door is told: `payment_pending` fires on an unpaid
   invoice (`paid_at` null, priced, not cancelled) — from ANY membership the
   person holds, not just whichever one is actually covering the class — and it
   is a flag next to a covered check-in, never a refusal — see rule 5. An amber
   "Unpaid invoice" badge sits right next to the coverage pill itself, both
   before checking someone in (the roster search) and after (Here now), so it
   cannot be missed behind a green "covered" pill — the exact case a status
   check would hide it in. It used to key on `status = 'pending'`, which meant
   the same thing only while raising a membership left it waiting for money; on
   the current model that would warn about nobody at all.
8. **No cover always says why.** "Nothing covers this class" is a dead end;
   "a membership starts after this class" or "waiting on a payment" is something
   a manager can act on. Every reason coverage resolution knows is surfaced on
   the roster and in the attach list, rather than logged and swallowed.
9. **Sessions attended is not credits used.** It counts classes trained,
   including uncovered ones. How many credits a membership has left is a separate
   number and lives on the membership.

## Where the count shows

- **Manager directory** (`/manager/users`) — a Sessions column, sortable.
- **A person's page** — the total plus their check-in history, the attach
  control for anything uncovered, and the move control for anything covered.
- **A member's own Membership page** — "You have trained N times." Members are
  deliberately not shown the coverage bookkeeping: "no cover" against a class
  they attended reads as an accusation.
- **The manager agent API** — `list_users` returns `sessions_attended`.

## Not built, on purpose

- **Self check-in, QR codes, kiosk mode.** A manager checks people in.
- **Back-dating to a class that never existed.** Put it on the calendar first.
- **Attendance reports and exports.** The counts are on the screens that need
  them; a reporting surface is its own feature.
- **A check-in action on the manager agent API.** A check-in is a
  physical-presence act that spends real money's worth of credit, so it should
  not happen on the strength of a text prompt — the same reason `edit_invoice`
  refuses to activate an invoice.
- **An expiry job.** Check-in closes memberships it finds past their end date,
  but nothing sweeps the whole table on a schedule. That is a separate change.
  It never closes the membership the same check-in just drew on, because
  back-filling an older roster can legitimately spend a pass that has since run
  out of days.
- **Deleting a class people attended.** Delete is for a class nobody turned up
  to; once there are check-ins it is refused, because deleting would take their
  sessions with it and never give them back. Cancel keeps the record.
