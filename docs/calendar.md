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
get a **private calendar link** so it stays in sync in their own calendar app,
and replace that link if it ends up somewhere it should not be.

### Fields

| Field          | Required?                   | Notes                                                                          |
| -------------- | --------------------------- | ------------------------------------------------------------------------------ |
| **Title**      | **Yes, the only one**       | "Beginner Gi", "Grading", "End of semester social".                            |
| When           | Yes                         | A one-off start/end, or a weekday + time + length when it repeats.             |
| Repeats        | Yes, defaults to _never_    | _Doesn't repeat_ or _Weekly_.                                                  |
| Instructor     | No                          | Blank is normal for socials and gradings.                                      |
| Location       | No                          | Pre-filled with the club's gym; clearing it leaves the entry with no location. |
| Description    | No                          | Free text.                                                                     |
| Who can see it | Yes, defaults to _Everyone_ | _Everyone_ or _Paid members only_. **Enforced.**                               |
| Invite only    | No                          | A badge and nothing else (see below).                                          |

There is no event "kind" field. It drove a cosmetic badge and nothing else, and a
mandatory free-text title says "Grading" better than a taxonomy that never quite
fits. If grouping is ever genuinely needed (a filter, colour-coding), it should
come back as a deliberate feature rather than a field everyone fills in on the way
past.

### What a new entry starts with

The add form opens with the answers that are right most of the time, so a routine
entry takes a title and a start time and nothing else:

- **Ends** follows **Starts**: pick a start and the end fills in an hour later.
  Correcting the start moves that end with it, so fixing 18:00 to 09:00 gives a
  one-hour entry rather than a nine-hour one. Once the end has been **typed in**,
  it is the manager's answer and is left alone; the only thing that overrides it
  is a start that moves past it, which would make the entry backwards.
- **Location** is pre-filled with the club's gym (ActivateFit Gym, UTS Building 4,
  745 Harris Street, Ultimo NSW 2007), built from the shared venue constants in
  `src/lib/venue.ts` so it is the same address the public pages, the map links
  and the structured data give. Somewhere else, or nowhere booked yet: overwrite
  or clear it.

Both are only defaults on the add form. Editing an existing date shows what that
date actually has, so an entry with no location keeps having none.

## Roles

- **Manager** (club staff, the `manager` role): full control. Every calendar
  write is a manager-only server function that re-checks
  `has_role(..., 'manager')`; the client is never trusted. Managers can see who
  has responded to each date.
- **Signed-in person** (any account, trial visitors included): sees the public
  schedule, **can RSVP**, and can get a private calendar link, and replace it.
- **Paid member** (an active, non-trial, paid-for membership): everything above,
  **plus members-only entries**, on the site and in their calendar link.
- **Public** (not signed in): sees the public schedule only. No members-only
  entries, no RSVP, no calendar link. They are invited to sign in.

## Two settings that are easy to confuse

| Setting                           | What it is                         | Effect                                                                                                                          |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Who can see it** (`visibility`) | **Access.** `public` or `members`. | Enforced. `members` entries are hidden from the public site and from anyone who is not a paid member.                           |
| **Invite only** (`invite_only`)   | **Access, and a badge.**           | Enforced. Only people invited to that date (they have an RSVP row) and managers can see it. Everyone else never sees the entry. |

Invite only is enforced in the database, not just in the interface: the
`calendar_events` read policies hide an invite-only date from the public feed and
from ordinary members. Marking a repeating entry invite only hides every date it
generates the same way, so the series and its dates can never disagree. To let
someone see an invite-only date, a manager creates their RSVP for it.

An entry can be public and invite-only (only invitees see it), members-only and
not invite-only, or any other combination. Both settings apply to repeating
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
7. **Check people in** — who actually turned up, on the `/manager/check-in`
   screen. A check-in belongs to a date on this calendar, and a **cancelled**
   date cannot be checked in to. See `docs/check-in.md`.

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
   member. It is minted on the first visit to `/calendar` and shown in full on
   both `/calendar` and `/account` every visit after that: one link per person,
   with nothing to press to get it. Losing the link is not a failure state,
   since it is always on the page.
4. **Replace the calendar link** — "Replace link", on the same panel in both
   places. It exists because the token can never leave the URL path (a calendar
   app subscribes to an address and has nowhere else to put a credential), so
   minting a new one is the only way a link that ended up somewhere public is
   ever made harmless.

   It **breaks their existing subscription on purpose**, so it asks first, in an
   `AlertDialog` that says the current link stops working straight away and that
   every calendar app holding it stops updating until the new one goes in. The
   new link then replaces the old one on the same panel, still on screen, with
   the copy button and a line saying the old one has stopped. Anyone who opens
   the retired address gets **410 Gone** and a sentence telling them it was
   replaced and where the new one is, rather than a 404 that reads like a typo.

## Rules

1. **Managers write, everyone else reads.** Every mutation is a manager-only
   server function; the route guard alone is not enough, so each function
   re-checks the role and writes through the service-role client.
2. **Cancel, don't delete.** Cancelling keeps the row so subscribers and RSVPs
   survive. Deletion is for mistakes only.
3. **One RSVP per person per date**, owned by that person.
4. **No public calendar feed, and one live link per person.** Only per-person
   links, so a subscriber can never silently miss a members-only entry. A link
   is a secret, but a durable one: like any calendar app's private ICS address
   it is stored and shown to its owner whenever they ask, not shown once and
   then unrecoverable. It lasts until it is **replaced**, which happens for
   exactly two reasons: its owner asked, or it is one of the pre-`20260728180000`
   links the server only ever stored the hash of, which it cannot show and so
   swaps for a fresh one the first time its owner opens the page. Nothing else
   retires a link, and nothing expires one on age. Both paths revoke the old row
   rather than deleting it, and mint a new one alongside, so the old address can
   say what happened instead of reading as a typo. Because the
   secret is in the URL, the feed is served with `Referrer-Policy: no-referrer`
   (see "Security headers" in `CLAUDE.md`). It keeps its own
   `Cache-Control: private, max-age=300`, which is what a polling calendar client
   wants.
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
- **A manager replacing somebody else's calendar link.** Replacing one stops
  that person's calendar updating with no warning, and they are the one who has
  to re-subscribe, so the club asks them to do it rather than doing it to them.
  The case this was weighed against, a member reporting that they pasted their
  link somewhere public, is answered by the member pressing the button
  themselves. If a manager ever genuinely needs to force it (an account the
  person can no longer sign in to), that is a deliberate feature to add, with
  the email that has to go with it.
- **Anything that expires or invalidates a link on its own.** No age limit, no
  "you changed your password so your calendar stopped". The only thing a member
  notices when a calendar link quietly stops working is that they stopped
  hearing about training, which is a worse outcome than the risk it would
  reduce. A link ends because somebody asked it to, bar the one legacy case in
  rule 4.
