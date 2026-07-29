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
- A **pending** membership never covers anything: the money has not landed.

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

## Rules

1. **Managers write, nobody else.** Every check-in is a manager-only server
   function that re-checks the role and writes through the service-role client.
   The client roles hold no privilege on the table at all.
2. **A check-in belongs to a class on the calendar.** Enforced as a foreign key,
   not a convention.
3. **One check-in per person per class**, enforced by a unique constraint. That
   constraint is also the concurrency guard: two managers tapping the same name
   race there, and exactly one wins, so a credit can never be spent twice for one
   class.
4. **The row is written before the credit moves.** If anything fails in between,
   the result is an uncovered check-in that the needs-attention list already
   knows how to fix. The other order fails as a spent credit with no attendance
   record, which nobody ever notices.
5. **Never refuse someone at the door.** No cover is a flag, not a rejection.
6. **Coverage is resolved against the class's start time**, not the current time,
   so a manager checking people in ten minutes late (or fixing yesterday's roster
   this morning) gets the same answer they would have got at the door.
7. **Sessions attended is not credits used.** It counts classes trained,
   including uncovered ones. How many credits a membership has left is a separate
   number and lives on the membership.

## Where the count shows

- **Manager directory** (`/manager/users`) — a Sessions column, sortable.
- **A person's page** — the total plus their check-in history, and the attach
  control for anything uncovered.
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
