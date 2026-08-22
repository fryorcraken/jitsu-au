# Notifications

One page for everything waiting on somebody, one badge in the sidebar, and email
they can turn off. Schema reference: `docs/database.md`'s "Notifications"
section, which must stay in sync with this document and the migrations, in the
same change.

## What problem this solves

The club had two places where people wrote to each other and nobody found out.
Reply to somebody on the blog and they learned about it by coming back to the
page. Leave feedback on a knowledge base passage and it sat there until a
manager opened `/manager/kb` and picked that exact article. Publish a post and
nobody was told at all.

Managers did have a "Needs attention" card on `/manager`, but it showed one kind
of thing, was recomputed on every load, and had no notion of having been seen.
Adding comment alerts somewhere else would have left managers checking two
screens.

## The model in one paragraph

There are two kinds of thing on `/notifications`, and the difference is the
whole design. An **attention item** is a standing problem, worked out live from
club data every time the page loads, and it goes away by being fixed. It has no
read state, and nothing can dismiss it. An **activity item** is something that
happened, stored as a row in `notifications`, unread until somebody looks at it.
They share one badge, and nothing else. The **email switches**
(`notification_preferences`) govern the inbox only: every activity item is
written whether or not the person wants it emailed.

## Rules

1. **The page is for everybody signed in, not just managers.** A member's
   replies land there, so it sits in the sidebar's "Your account" group next to
   Knowledge base and Account. A manager sees the same page with more on it.
2. **The badge is one number**: open attention items plus unread activity. A
   count of zero renders no badge at all rather than a "0" pill.
3. **Attention items count toward the badge even though they can never be marked
   read.** That is deliberate. A badge that went quiet while the club had no
   sellable training dates would be worse than no badge.
4. **The switches control email, never the page.** Somebody who turns off
   new-post announcements still sees them under Activity. Turning email off must
   never cost somebody the record of what happened.
5. **A private knowledge base note notifies nobody**, managers included. It is
   readable by its author alone (see `docs/knowledge-base.md`), and a
   notification carrying its text would be the leak. `notifyKbAnnotation`
   returns immediately for anything that is not `shared`.
6. **Recipients are re-checked against the article as it stands now.** An
   article that has narrowed from `members` to `managers` since somebody
   commented must not be quoted at them, so a `managers` article only ever
   notifies managers, regardless of who took part when it was wider.
7. **Nobody is notified about their own writing, or about a hidden comment.** A
   reply to a comment a manager has hidden notifies nobody: its author is being
   moderated, and telling them their hidden comment got a reply would undo that
   quietly.
8. **A reply is instant; everything else is a daily summary.** You said
   something and somebody answered, which is worth an interruption. Thread
   activity, announcements and moderation alerts batch, so a busy thread cannot
   produce ten emails in an afternoon.
9. **Announcements are off until somebody opts in.** They are the only kind that
   would reach a person who did nothing to ask for it. Everything else is on by
   default. A NULL column means "never chose", which is why the preference
   columns are nullable: it keeps "unset" distinguishable from "deliberately
   off", so changing a club default later moves the right people.
10. **The link in an email footer opens the switches, not an unsubscribe.**
    Somebody who only wanted fewer announcements should not lose replies too.

## Flows

### Somebody signs up

Signing up is two steps, and until this existed neither of them reached the
notifications page at all. A manager found out by opening `/manager/users` or
`/manager/waivers` on the off chance, or by spotting the best-effort email.

Both are **attention items**, and they are deliberately different shapes:

| Step         | Item                                                | Verb    | Clears when                      |
| ------------ | --------------------------------------------------- | ------- | -------------------------------- |
| **Register** | "Sam registered interest in training"               | Read it | a manager opens `/manager/users` |
| **Waiver**   | "Sam signed the waiver and is waiting for approval" | Approve | the waiver is approved           |

The register step is **news, not work**. Nobody is waiting on anything, so it
carries a reading verb and nothing else, and its copy says so in as many words.
The waiver step is the opposite: somebody has signed and cannot start until a
manager presses the button, which is why it sits at the top of the queue (see
`composeManagerNotifications` for the full ordering and why).

The waiver item's body says what approving leads to before the manager gets
anywhere near the button: it activates the person's account, emails them to say
so, and assigns the free trial (`docs/waivers.md`, rule 6). That is
outward-facing and cannot be taken back quietly, and "anything irreversible gets
a confirm that says what will happen" is the club's own UX rule.

Counted from `waivers.approval_status = 'pending'`, which is the stored fact.
The waivers screen's third state, `superseded`, is derived from a person's other
**approved** waivers, so it can never hide work from this count.

> [!WARNING]
> **A pending waiver has exactly one exit, and it is approval.** `approval_status`
> is `pending | approved` with no reject, and approving one row leaves any other
> pending row of that person's alone. So a second submission nobody wants
> approved (a bogus public signing, or a paper form filed for somebody who then
> signed online outside the same-day duplicate probe) keeps this item and the
> badge up for good. Clearing it means approving a duplicate, and for a stranger's
> submission that activates an account, emails them and grants a trial. Nothing
> counted pending waivers before this, which is why it never surfaced. The fix is
> a real dismissal state on `waivers`, which is a schema change and a product
> decision of its own, so it is not in this change.
>
> The count is also unbounded while `listWaivers` caps at 500 rows, newest
> `signed_at` first. Past 500 waivers the club could have a pending one that
> `/manager/waivers` does not list, and the item would point at a screen without
> the row on it. Not reachable at the club's current size, and the fix when it is
> would be paging that screen, the same answer `docs/database.md` gives for the
> contact inbox.

#### The registration watermark

Interest registrations have no per-row read state to hang a badge on:
`interest_registrations` grants `anon` INSERT and deliberately nothing else. So
"new" means everything created after one club-wide watermark,
`club_settings.interest_registrations_seen_at`, exactly as unanswered contact
messages work. `src/lib/seen-markers.ts` owns both.

Two things about it differ from the contact inbox, and both are on purpose:

- **Opening `/manager/users` at all clears it**, not opening some leads-only
  view. That screen is the whole funnel, one row per person, and it is where a
  registration ends up whether or not that person is still a lead.
- **The watermark is stamped from the newest registration in the database**,
  not from a boundary the browser hands back. The users screen aggregates one
  row per person, so a lead who has since signed a waiver appears there as an
  applicant and the rendered rows cannot supply "the newest registration". The
  cost is a registration landing in the gap between that screen loading and the
  stamp: it is marked seen without ever being badged. Nothing is lost when that
  happens, which is the difference that makes it acceptable. A registration is a
  person, and that person stays on the users list for good, whereas a contact
  message exists nowhere else and its watermark is therefore stricter.

Two more things follow from the watermark being a bare "everything after this":

- **Acknowledging hands the addresses back**, and the users table pills those
  rows **new**. Clearing the badge otherwise destroys the only record of what it
  was about: that screen is one row per person for the whole club, sorted by
  name, with nothing marking an arrival. `manager.contact-messages.tsx` keeps its
  unread ids for the same reason, and this is the same move one layer down.
- **Every query is bounded at both ends**, newer than the watermark AND not in
  the future. `interest_registrations` grants `anon` a bare INSERT and its RLS
  `WITH CHECK` constrains only the person fields, so the publishable key in the
  browser bundle is enough to file a row stamped 2099. Since the watermark is
  clamped to the present, such a row could never be brought under it: it would
  count as new for good, pinning an item that by design has no read state and no
  way to be dismissed. Bounded, a future row is simply not news yet. The same
  hole is still open on `contact_messages`, which has the identical grant and
  the identical clamp; closing it is a one-line change in
  `countUnreadContactMessages` and belongs in its own PR.

### Somebody replies to you

`postComment` (`src/lib/blog-comments.functions.ts`) and `createAnnotation`
(`src/lib/kb.functions.ts`) call into
`src/lib/notification-events.server.ts` after the write succeeds, fire and
forget. Three audiences come out of one comment: the person replied to, everyone
else on the thread, and the managers. Only the first is emailed immediately.

Every part of this is best-effort and swallows its own failures. A comment is
saved, and must never fail because telling somebody about it did.

### The daily summary

A **pg_cron job in the database** POSTs to `/api/notifications/digest` once a
day. `private.run_notification_digest()` reads the site URL and the bearer token
out of Supabase Vault and calls out with pg_net; the schedule itself never holds
the token, since anyone who can read `cron.job` can read a command string. The
endpoint groups every row with no `emailed_at` by person, drops the kinds they
have switched off, and sends one email to whoever has anything left.

This ran as a GitHub Actions workflow first, and moving it was a correction, not
a preference. Scheduling production work from CI put a credential that makes the
site email its members into a repo that takes same-repo branches from Lovable and
from coding agents, and it made the club's schedule depend on GitHub, which
delays and disables scheduled workflows on quiet repos. The original reasoning
for using Actions ("pg_cron is not available") was never checked: it was inferred
from the extension being absent from this repo's migrations, which says nothing
about what the project offers. `pg_available_extensions` lists pg_cron 1.6.4.

**It is not armed by the migration.** The job fires nightly and returns
immediately, with a warning in the Postgres log, until both Vault secrets exist:

```sql
SELECT vault.create_secret(
  'https://jitsu.au/api/notifications/digest', 'notification_digest_url');
SELECT vault.create_secret('<same value as NOTIFICATION_DIGEST_KEY>',
  'notification_digest_key');
```

Two traps worth stating, because both fail silently every morning rather than
loudly once:

- Read `vault.decrypted_secrets.decrypted_secret`, never `vault.secrets.secret`.
  The latter is the ciphertext, and using it sends an `Authorization` header of
  base64 noise that earns a 401.
- Use the `jitsu.au` origin, not the published `*.lovable.app` host. That one
  302s to `jitsu.au`, and pg_net does not follow redirects.

Two things about the stamping are worth knowing, because they are what keep it
honest:

- **Every row considered is stamped, including the suppressed ones.** A
  preference is forward-looking. Without this, switching a kind back on would
  release weeks of backlog into somebody's inbox.
- **A row is stamped only after a successful send**, so a failed run retries
  tomorrow rather than silently dropping a day. The one exception is a missing
  `LOVABLE_API_KEY`, where nothing is stamped at all: those notifications are
  still owed.

`0 20 * * *` is 7am in Sydney during daylight saving and 6am outside it. pg_cron
schedules are UTC and have no notion of DST, and an hour's drift on a club digest
is not worth a scheduler of our own.

#### Knowing whether it actually ran ⚠️

**This is the weak point of the current setup, and it is a real regression
against the GitHub Action it replaced.** The Action used `curl --fail-with-body`,
so any non-2xx turned the job red and GitHub emailed the repo owner. pg_net is
fire and forget: it queues the request, `PERFORM` discards the request id, and
the function returns successfully no matter what the site answered. So
`cron.job_run_details` records **succeeded** for every one of these:

- `NOTIFICATION_DIGEST_KEY` unset or rotated server-side, so the endpoint answers
  503 or 401 forever
- the Vault secret drifting from the env var, giving 401 every morning
- the site being down, DNS or TLS failing, or the request timing out

In all of them nobody is emailed, `emailed_at` stays NULL, the backlog grows, and
nothing anywhere says so. The only evidence is `net._http_response`, which
pg_net garbage-collects after `pg_net.ttl` (6 hours by default), so it is
usually gone before anyone thinks to ask.

To check by hand:

```sql
SELECT * FROM cron.job_run_details
 WHERE jobname = 'notification-digest' ORDER BY start_time DESC LIMIT 7;   -- did it fire
SELECT id, status_code, error_msg, created
  FROM net._http_response ORDER BY created DESC LIMIT 5;                   -- what came back
SELECT count(*) FROM public.notifications WHERE emailed_at IS NULL;        -- backlog, the real symptom
```

That last query is the one worth watching: a number that climbs day over day
means the digest has stopped, whatever the scheduler thinks. Closing this
properly wants a second job that reads back the response and raises on a non-2xx
so the failure lands in `cron.job_run_details`. Not built yet.

### A post goes live

`createBlogPost` and `updateBlogPost` announce on the transition **into**
`published`, fanned out to everybody with a `profiles` row. Editing a published
post announces nothing: a typo fix is not news.

An unpublish and republish round trip announces the post exactly once, because
the unique index on `(user_id, kind, subject_id)` absorbs the repeat. That is
also why `blog_posts` needs no `announced_at` column: `published_at` is
deliberately never cleared (`resolvePublishedAt` in `src/lib/blog.functions.ts`)
so it could not have carried "has this been announced".

### Turning email off

The switches are on `/notifications` for somebody signed in, and at
`/email-settings/<token>` for somebody who clicked the link at the bottom of an
email. Both render `NotificationSwitches`, so the two can never offer different
choices.

The token rides in the URL path because an email client cannot send an
`Authorization` header, the same as `/api/calendar/<token>` and
`/api/verify-email/<token>`. The response is **uniform**: a token that never
existed, one that has been rotated, and a malformed one all render the same
page. Anything else would make the endpoint a way to probe which links the club
has issued.

Because the token is in the URL, the page is served with
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the link never
travels in a `Referer` header (the footer has outbound links) and never lands in
a shared or on-disk cache. That is set for every token path at once; see
"Security headers" in `CLAUDE.md`.

The signed-out page deliberately omits the manager switch. With no session it
cannot tell whether the person holds the role, and offering a manager-only
choice to a member would be a lie about what they can turn on.

## What is deliberately not built

- **Upvotes notify nobody.** Not a conversation.
- **No per-thread mute.** The switches are per kind. If one thread turns noisy,
  the answer today is to turn thread activity off.
- **No in-app bell or toast.** The sidebar badge is the only in-app signal.
- **The attention list has four checks**: waivers waiting for approval, unanswered
  contact messages, new interest registrations, and the club's training dates
  running out. Unmatched bank transactions and unpaid invoices are the obvious
  next entries and the shape supports them, but widening the manager queue
  further is separate work.
- **Signing up notifies managers by email at the moment it happens** (a new-lead
  email on registration, a copy of the waiver on signing), and none of that is
  changed by the attention items. Neither item claims a copy was emailed: those
  sends are best-effort, and on the day this shipped the club's whole existing
  backlog counted as new without anybody having been emailed about it.
- **Neither sign-up item is per person.** Ten registrations are one line saying
  ten, not ten lines. The page points at the screen that lists them.
- **No digest for somebody with nothing.** An empty digest is not sent, and the
  rows are stamped anyway so tomorrow's run is not re-reading them forever.

## The gap this left, since closed

`contact_messages` used to be **write-only**: the form saved a row and nothing in
the app ever read it, so anybody who used the contact form was talking into a
void. That is fixed. Submitting now emails the sender an acknowledgement and
every manager the message itself, `/manager/contact-messages` lists the history,
and unanswered messages are an **attention item** here.

Attention, not activity, and the distinction is the one this page rests on: they
are derived live from a club-wide marker
(`club_settings.contact_messages_seen_at`) rather than stored per person, and
they clear by a manager opening the inbox rather than by anyone marking a row
read. See `docs/database.md` under `contact_messages`.

Two consequences worth knowing:

- **The marker is club-wide.** Whichever manager opens the inbox clears the item
  for all of them. A per-manager count would need a table of its own.
- **It was the first attention item with its own verb.** `ManagerNotification`
  carries an `actionLabel` because "Fix it" is right for unset training dates and
  wrong for a message, where nothing is broken and somebody is waiting on a
  reply.

## Where the code lives

| Concern                      | File                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| The rules (pure, tested)     | `src/lib/notifications.ts`                                             |
| The attention list           | `src/lib/manager-notifications.functions.ts`                           |
| Contact messages             | `src/lib/contact-messages.functions.ts`, `contact-email.server.ts`     |
| Interest registrations       | `src/lib/leads.functions.ts`                                           |
| Waivers waiting on a manager | `countWaiversAwaitingApproval` in `src/lib/waiver.functions.ts`        |
| The club-wide watermarks     | `src/lib/seen-markers.ts`                                              |
| Who hears about what         | `src/lib/notification-events.server.ts`                                |
| Sending, and the digest run  | `src/lib/notification-email.server.ts`                                 |
| Page and settings server fns | `src/lib/notifications.functions.ts`                                   |
| The shared query             | `src/hooks/useNotifications.ts`                                        |
| The page                     | `src/routes/_authenticated/notifications.tsx`                          |
| The signed-out settings      | `src/routes/email-settings/$token.tsx`                                 |
| The switches                 | `src/components/site/NotificationSwitches.tsx`                         |
| The sidebar badge            | `src/components/site/MemberLayout.tsx`                                 |
| The digest endpoint          | `src/routes/api/notifications/digest.ts`                               |
| The schedule                 | `supabase/migrations/20260807000000_notification_digest_cron.sql`      |
| Email templates              | `src/lib/email-templates/comment-reply.tsx`, `notification-digest.tsx` |
