# Calendar: what's on, and who's coming

The product spec for the club calendar. `docs/database.md` documents the schema
that backs this (the `## Calendar` section); keep both aligned with the code in
the same change.

## The model in one paragraph

There is **one kind of thing on the calendar**: an entry. It has a title, a time,
and some optional detail, and it either happens once or **repeats weekly**.
Repeating is a property of the entry, not a different type of entry, so a weekly
class and a one-off grading are created from the same form and can carry the same
settings, including members-only and invite-only. A **manager** owns the calendar:
they add entries, edit them, cancel a single date or a whole run, and choose **who
can see** each one. The public `/calendar` page shows the schedule, and **anyone
signed in can RSVP** going / maybe / can't make it. Each signed-in person can also
get a **private calendar link** so it stays in sync in their own calendar app.

### Fields

| Field          | Required?                   | Notes                                                                 |
| -------------- | --------------------------- | --------------------------------------------------------------------- |
| **Title**      | **Yes, the only one**       | "Beginner Gi", "Grading", "End of semester social".                   |
| When           | Yes                         | A one-off start/end, or a weekday + time + length when it repeats.    |
| Repeats        | Yes, defaults to _never_    | _Doesn't repeat_ or _Weekly_.                                         |
| Instructor     | No                          | Blank is normal for socials and gradings.                             |
| Location       | No                          | No default venue: an entry with nowhere booked yet shows no location. |
| Description    | No                          | Free text.                                                            |
| Who can see it | Yes, defaults to _Everyone_ | _Everyone_ or _Paid members only_. **Enforced.**                      |
| Invite only    | No                          | A badge and nothing else (see below).                                 |

There is no event "kind" field. It drove a cosmetic badge and nothing else, and a
mandatory free-text title says "Grading" better than a taxonomy that never quite
fits. If grouping is ever genuinely needed (a filter, colour-coding), it should
come back as a deliberate feature rather than a field everyone fills in on the way
past.

## Roles

- **Manager** (club staff, the `manager` role): full control. Every calendar
  write is a manager-only server function that re-checks
  `has_role(..., 'manager')`; the client is never trusted. Managers can see who
  has responded to each date.
- **Signed-in person** (any account, trial visitors included): sees the public
  schedule, **can RSVP**, and can get a private calendar link.
- **Paid member** (an active, non-trial, paid-for membership): everything above,
  **plus members-only entries**, on the site and in their calendar link.
- **Public** (not signed in): sees the public schedule only. No members-only
  entries, no RSVP, no calendar link. They are invited to sign in.

## Two settings that are easy to confuse

| Setting                           | What it is                         | Effect                                                                                                |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Who can see it** (`visibility`) | **Access.** `public` or `members`. | Enforced. `members` entries are hidden from the public site and from anyone who is not a paid member. |
| **Invite only** (`invite_only`)   | **Display label.**                 | Enforces nothing. It just badges the entry "invite only" so people know attendance is by invitation.  |

An entry can be public _and_ invite-only (visible to all, badged), or members-only
_and_ not invite-only, or any other combination. Both settings apply to repeating
entries too, which is what the old two-form design made impossible: every date a
repeat generated was forced to be public.

## Repeating: start and end dates

A weekly entry runs from a first date, either forever or until a set date:

- **First date** (`starts_on`, required) — the first date it runs. Nothing shows
  before it.
- **Runs until** (`ends_on`, optional):
  - **No end date** — it keeps recurring.
  - **Ends on a set date** (e.g. end of semester) — dates stop after it.

Each week's date is **its own entry on the calendar**, which is what makes it
possible to cancel one week, or change one week's instructor, without touching the
rest.

**Nobody has to press anything to keep future dates appearing.** The app keeps a
rolling horizon of upcoming dates topped up whenever the calendar is read. There
is no "Add dates" button; that was an implementation detail leaking into the UI.

## Manager actions

1. **Add something to the calendar** — one form. Type a title, set when, choose
   whether it repeats, and optionally fill in instructor, location, description,
   who can see it, and the invite-only badge. Its dates appear straight away.
2. **See what's on** — a single list of upcoming dates. A repeating one is marked
   _Weekly_ and shows who can see it.
3. **Edit** — for a repeating entry, editing asks the question Google Calendar
   asks: **this date only**, or **this and all future dates**? "All future" is
   measured from the date you clicked, not from today, and dates before it are
   never rewritten; they record what actually happened. The day and time of a
   repeat are deliberately not editable, because dates already on the calendar
   would become wrong: stop it repeating and add it again.
4. **Cancel** — the same scope question. A cancelled date stays on the calendar,
   struck through and marked _Cancelled_ (never deleted), so people see the change,
   it clears from subscribed calendars, and RSVPs are kept. Reversible with
   "Restore".
5. **Stop repeating** — ends future dates and deactivates the rule. Past dates are
   untouched, because they happened.
6. **See who's coming** — a going/maybe tally per date, expandable to the list of
   names and emails.

Deleting an entry outright exists for mistakes only, and only for one-off
entries: deleting a single date of a repeat would just be regenerated at the next
top-up, so a repeat offers "Stop repeating" instead. Cancel keeps the record.

## Member and visitor actions

1. **See the calendar** — `/calendar`. Paid members also see members-only entries.
2. **RSVP** — going / maybe / can't make it, one response per person per date,
   changeable any time. Open to **anyone signed in**, so someone on a free trial
   can reply too. Responses to a members-only entry are refused for people who
   can't see it, and cancelled or finished dates can't be replied to.
3. **Get a calendar link** — a private URL (`/api/calendar/<token>`) to add to a
   phone or laptop calendar. New dates, changes and cancellations then sync on
   their own. It includes members-only entries only while that person is a paid
   member. It is minted on the first visit to `/calendar` and shown there every
   visit after that: one permanent link per person, with nothing to press and no
   replace or turn-off buttons. Losing the link is not a failure state, since it
   is always on the page.

## Rules

1. **Managers write, everyone else reads.** Every mutation is a manager-only
   server function; the route guard alone is not enough, so each function
   re-checks the role and writes through the service-role client.
2. **Cancel, don't delete.** Cancelling keeps the row so subscribers and RSVPs
   survive. Deletion is for mistakes only.
3. **One RSVP per person per date**, owned by that person.
4. **No public calendar feed.** Only per-person links, so a subscriber can never
   silently miss a members-only entry. A link is a secret, but a durable one:
   like any calendar app's private ICS address it is stored and shown to its
   owner whenever they ask, not shown once and then unrecoverable.
5. **"Member" means paid.** Members-only visibility keys off an active, non-trial
   membership with a price above zero (mirroring `deriveLifecycleStatus`), via the
   `has_active_paid_membership` helper used in RLS.
6. **A generated date is a copy of the entry**, including who can see it and the
   invite-only badge. Nothing about a repeat is hardcoded.
7. **Times.** A repeat's time of day is local to the club (Australia/Sydney); every
   dated row stores an absolute `timestamptz`; the calendar link emits UTC. The
   manager form reads its date/time inputs as club time, not the browser's zone.

## Not built, on purpose

- **All-day entries.** No form ever exposed the column, and a full-day grading
  reads fine as "9am, 8 hours", so it was dropped rather than wired up.
- **Moving a repeat's day or time.** Dates already on the calendar would become
  wrong, and people may have already replied to them. Stop the repeat and add a
  new one.
