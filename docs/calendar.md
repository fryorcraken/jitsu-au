# Calendar: schedule, events, and RSVPs

The product spec for the club calendar. `docs/database.md` documents the schema
that backs this (the `## Calendar` section); keep both aligned with the code in
the same change.

## The model in one paragraph

A **manager** owns the schedule. They set up a **regular session** (a weekly
class on a given day and time, with an instructor) that runs from a start date,
either open-ended or until a set end date, and the app puts each week's date on
the calendar. One-off **events** (grading, seminar, social) sit on the same
calendar. A manager can cancel a single date, change the instructor for one date
or the whole session, and choose **who can see** each event. The public
`/calendar` page shows the schedule to everyone, and **anyone signed in can RSVP**
going / maybe / can't make it. Each signed-in person can also get a **private
calendar link** so the schedule stays in sync in their own calendar app.

## Roles

- **Manager** (club staff, the `manager` role): full control. Every calendar
  write is a manager-only server function that re-checks
  `has_role(..., 'manager')`; the client is never trusted. Managers can see who
  has responded to each event.
- **Signed-in person** (any account, trial visitors included): sees the public
  schedule, **can RSVP**, and can get a private calendar link.
- **Paid member** (an active, non-trial, paid-for membership): everything above,
  **plus members-only events**, on the site and in their calendar link.
- **Public** (not signed in): sees the public schedule only. No members-only
  events, no RSVP, no calendar link. They are invited to sign in.

## Two different per-event flags

These are deliberately different in kind and are often confused:

| Flag                              | What it is                         | Effect                                                                                               |
| --------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Who can see it** (`visibility`) | **Access.** `public` or `members`. | Enforced. `members` events are hidden from the public site and from anyone who is not a paid member. |
| **Invite only** (`invite_only`)   | **Display label.**                 | Enforces nothing. It just badges the event "invite only" so people know attendance is by invitation. |

An event can be public _and_ invite-only (visible to all, badged), or
members-only _and_ not invite-only, or any other combination.

## Regular sessions: start and end dates

A regular session is defined once and appears every week:

- **First date** (`starts_on`, required) — the first date it runs. Nothing shows
  before it.
- **Runs until** (`ends_on`, optional):
  - **No end date** — the session keeps recurring. The app keeps a rolling
    horizon of upcoming dates on the calendar and a manager can extend it at any
    time with "Add dates".
  - **Ends on a set date** (e.g. end of semester) — dates stop after it.

Each week's date is its own calendar entry, so a manager can cancel or
re-instructor **one** week without touching the rest. Changing the session's
instructor updates the session and its **future** dates; past ones keep whoever
actually taught them.

## Manager actions

1. **Set up a regular session** — day, time, length, instructor, location, first
   date, and open-ended or a set end date. Its dates are put on the calendar
   straight away.
2. **Add dates** — extend an open-ended session further into the future. Safe to
   repeat: dates that already exist are never duplicated.
3. **Add an event** — grading, seminar, social, or other, with its own date/time,
   instructor and description.
4. **Cancel a date or event** — it stays on the calendar marked _Cancelled_
   (never deleted), so people see the change, it clears from subscribed
   calendars, and RSVPs are kept. Reversible with "Restore".
5. **Change the instructor** — for a single date, or for a session and all its
   future dates.
6. **Choose who can see it** — everyone, or paid members only.
7. **Badge an event "invite only"** — display only (see the table above).
8. **See who's coming** — a going/maybe tally per event, expandable to the list
   of names and emails.

## Member and visitor actions

1. **See the calendar** — `/calendar`. Paid members also see members-only events.
2. **RSVP** — going / maybe / can't make it, one response per person per event,
   changeable any time. Open to **anyone signed in**, so someone on a free trial
   can reply too. Responses to a members-only event are refused for people who
   can't see it, and cancelled events can't be replied to.
3. **Get a calendar link** — a private URL (`/api/calendar/<token>`) to add to a
   phone or laptop calendar. New dates, changes and cancellations then sync on
   their own. It includes members-only events only while that person is a paid
   member. The link is shown once, stored only as a hash, and revocable.

## Rules

1. **Managers write, everyone else reads.** Series/event mutations are
   manager-only server functions; the route guard alone is not enough, so each
   function re-checks the role and writes through the service-role client.
2. **Cancel, don't delete.** Cancelling keeps the row so subscribers and RSVPs
   survive. Deletion is for mistakes only.
3. **One RSVP per person per event**, owned by that person.
4. **No public calendar feed.** Only per-person links, so a subscriber can never
   silently miss a members-only event. Links are secrets: stored hashed, shown
   once, revocable.
5. **"Member" means paid.** Members-only visibility keys off an active, non-trial
   membership with a price above zero (mirroring `deriveLifecycleStatus`), via
   the `has_active_paid_membership` helper used in RLS.
6. **Times.** Session times are local to the club (Australia/Sydney); event
   timestamps are absolute `timestamptz`; the calendar link emits UTC.
