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
anywhere near the button: it activates an account, emails somebody to say so,
and assigns the free trial (`docs/waivers.md`, rule 6). "Somebody" rather than
"the person" since #105: for a child's waiver the account that opens and the
inbox that hears about it are the **parent's**, not the participant's. That is
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
day. `private.run_notification_digest()` reads a bearer token out of Supabase
Vault and calls out with pg_net to a literal `jitsu.au` URL; the schedule itself
never holds the token, since anyone who can read `cron.job` can read a command
string. The endpoint reads the SAME token back out of Vault, through a
service-role RPC, and compares it against whatever the request sent. The
endpoint then groups every row with no `emailed_at` by person, drops the kinds
they have switched off, and sends one email to whoever has anything left.

This ran as a GitHub Actions workflow first, and moving it was a correction, not
a preference. Scheduling production work from CI put a credential that makes the
site email its members into a repo that takes same-repo branches from Lovable and
from coding agents, and it made the club's schedule depend on GitHub, which
delays and disables scheduled workflows on quiet repos. The original reasoning
for using Actions ("pg_cron is not available") was never checked: it was inferred
from the extension being absent from this repo's migrations, which says nothing
about what the project offers. `pg_available_extensions` lists pg_cron 1.6.4.

**One token, one home, checked here on 2026-08-21 against the live project: it
was never set.** The first design after moving off GitHub Actions asked for the
SAME random string in two different places — a server env var
(`NOTIFICATION_DIGEST_KEY`, read by the endpoint) and a Supabase Vault secret
(read by pg_cron) — and required them to match forever. The club owner could not
find the Lovable screen that sets a server env var (it is not where the docs
said, on a Pro plan), so it was never set. Both Vault secrets stayed absent too,
the job fired nightly and raised, and five nights (then several more) of
`cron.job_run_details` recorded a failure nobody was looking at. 34 notifications
sat unemailed from 2026-08-10 to 2026-08-20 before anyone noticed.

**As of `20260822120041_68ab3908-faf6-49d1-8037-aaa3e39639aa.sql` there is
nothing left to type in twice.** The migration mints the one Vault secret itself
— a random value nobody ever sees, types, or copies — and the endpoint reads it
back through `public.notification_digest_key()`, the same service-role RPC
`private.run_notification_digest()` reads for the scheduler's side. There is no
server env var for this any more; see "Arming the digest" below for what setup
now actually takes. The destination URL is a literal in the function body for
the same reason: it used to be a second Vault secret
(`notification_digest_url`), which meant it was possible to set it to the
published `*.lovable.app` host by mistake — that one 302s to `jitsu.au`, and
pg_net does not follow redirects. That mistake can no longer happen.

One trap that still fails silently every morning rather than loudly once: read
`vault.decrypted_secrets.decrypted_secret`, never `vault.secrets.secret`. The
latter is the ciphertext, and using it sends an `Authorization` header of
base64 noise that earns a 401 — which is now true on both sides of the
comparison, since the endpoint reads the same view.

Two things about the stamping are worth knowing, because they are what keep it
honest:

- **Every row considered is stamped, including the suppressed ones.** A
  preference is forward-looking. Without this, switching a kind back on would
  release weeks of backlog into somebody's inbox.
- **A row is stamped only after a successful send**, so a failed run retries
  tomorrow rather than silently dropping a day. The one exception is a missing
  `LOVABLE_API_KEY`, where nothing is stamped at all: those notifications are
  still owed.

`0 22 * * *` is 9am in Sydney during daylight saving and 8am outside it
(`20260823000000_notification_digest_morning_schedule.sql`; it was `0 20 * * *`,
so 7am and 6am, until the club owner saw the first real run land at 6am). pg_cron
schedules are UTC and have no notion of DST, and an hour's drift on a club digest
is not worth a scheduler of our own.

#### Knowing whether it actually ran ⚠️

**This is the weak point of the current setup, and it is a real regression
against the GitHub Action it replaced.** The Action used `curl --fail-with-body`,
so any non-2xx turned the job red and GitHub emailed the repo owner. pg_net is
fire and forget: it queues the request, `PERFORM` discards the request id, and
the function returns successfully no matter what the site answered. So
`cron.job_run_details` records **succeeded** for every one of these:

- the Vault secret missing, so the endpoint answers 503 forever
- the Vault secret rotated after the endpoint last cached it (it caches in
  module scope after the first successful read, so a rotation needs a
  redeploy to take effect there — see "Rotating the key" below), giving 401
  until the next deploy
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
means the digest has stopped, whatever the scheduler thinks.

#### What now watches it

Two changes, and the split between them is the point. One makes the scheduler
stop lying; the other stops relying on the scheduler at all.

- **An unarmed run is now recorded as failed**
  (`20260821000000_notification_digest_fails_loudly.sql`). The fail-closed branch
  raises instead of returning, naming whichever Vault secret is missing, so
  `cron.job_run_details` says `failed` for a job that emailed nobody. This is
  narrow on purpose: it only catches the half of the problem the database can
  see. An armed job still records success no matter what the site answered.
- **A stalled digest is an attention item on `/notifications`.** Any notification
  row that has sat unemailed for more than `DIGEST_STALL_HOURS` (36) raises "The
  daily email summary has stopped going out", with the backlog size and the date
  of the oldest row. This asserts on the **outcome**, not the mechanism, which is
  the only check that survives pg_net being fire and forget: Vault secret
  missing, a rotation the endpoint has not picked up yet, site down, DNS or TLS
  failing, request timing out. All of them look identical from here, which is
  exactly what makes the check cheap and total.

36 hours rather than 24: the run is daily, so anything younger is waiting for
tonight, and a run that is a few hours late is not news. Two missed mornings is.

Three things about that item are deliberate and will look like bugs otherwise:

- **It has no button.** The fix lives outside this repo, in Supabase Vault, so
  every destination the page could offer would be one that cannot help.
  `ManagerNotification` carries `href` and `actionLabel` as an all-or-nothing
  pair for this reason.
- **It cannot be dismissed**, like every attention item, and unlike the others it
  can stay up for weeks. It clears when the digest actually sends, or when
  somebody stamps the backlog as emailed. That is the correct behaviour while
  members are silently getting no email.
- **It fires while the digest has simply never been armed**, which is the state
  the club is in today. That is not a false positive: the rows are owed and
  nobody has had them.

Still not built: a second job that reads `net._http_response` back and raises on
a non-2xx, so an ARMED failure lands in `cron.job_run_details` the same night
rather than a day and a half later on the notifications page. It needs somewhere
durable to keep the verdict, since pg_net garbage-collects that table after
`pg_net.ttl` (6 hours by default). The backlog check covers the same failures
more slowly, which is why this is worth doing and not urgent.

### Arming the digest: the runbook

Both of the steps this used to describe have now been done, on **2026-08-22**.
What follows is the record of what was actually run, so the next person can tell
what state the club is in rather than guessing from a set of instructions.

**The state before, checked read-only through Lovable on 2026-08-21.**
`NOTIFICATION_DIGEST_KEY` was not set (the project had three secrets and this was
not one of them), neither Vault secret existed, and no digest email had ever been
sent. pg_cron was installed with job `notification-digest` active on `0 20 * * *`
(since moved to `0 22 * * *`, see above);
pg_net was installed with its extension home in `extensions` and its functions in
`net`, which is what the migration asserts. The five runs from 17 to 21 August all
recorded **succeeded** having done nothing. The backlog stood at **34 rows**, from
2026-08-10 12:53 UTC to 2026-08-20 03:09 UTC.

**1. The backlog was cleared, before the migration was applied.** The digest
sweeps every row with a NULL `emailed_at` and no age limit, so the first armed run
would have released the whole backlog at once, as one email per person. Old
announcements arriving in a burst is the kind of send that gets a domain marked as
spam, and the club depends on that domain for magic links and account activation.
So the club owner chose to stamp it rather than send it:

```sql
-- Run 2026-08-22. 34 rows updated; 0 left unemailed afterwards.
UPDATE public.notifications
   SET emailed_at = now()
 WHERE emailed_at IS NULL
   AND created_at < now() - interval '36 hours';
```

Nothing was lost. Every one of those notifications is still on its owner's
`/notifications` page: `emailed_at` governs the inbox only, never the page. The
36-hour bound was deliberate, so that anything genuinely recent would still be
emailed normally on the first working run. On the day, all 34 were older than
that, so it made no practical difference.

**2. The migration was applied, under `docs/database-changes.md`'s gate** (the
owner approved it, then the SQL ran against the live database, then the ledger was
recorded and PostgREST reloaded). Confirmed afterwards: `vault.secrets` holds one
`notification_digest_key` row, `public.notification_digest_key()` exists owned by
`postgres` with `prosecdef` true and an ACL of `postgres=X/postgres` plus
`service_role=X/postgres` (so `anon` and `authenticated` hold no EXECUTE), and the
Supabase advisors reported nothing new.

> [!NOTE]
> **The `SECURITY DEFINER`-reads-Vault question is settled, and not by assumption.**
> Whether a function owned by `postgres` may read `vault.decrypted_secrets` on this
> project could not be tested directly: Lovable's SQL channel runs as a restricted
> role that holds no EXECUTE on either function, which is the grant working rather
> than a Vault failure. The proof is in `cron.job_run_details` instead. The original
> function body (`20260807000000`) ran both of its `SELECT ... FROM
vault.decrypted_secrets` statements **before** its missing-secret guard, and every
> nightly run recorded `succeeded`. A permission failure would have raised `42501`
> and recorded `failed`. So the read has been permitted all along.

To confirm the secret is there at any later date:

```sql
SELECT name, created_at FROM vault.secrets WHERE name = 'notification_digest_key';
```

One row is the secret existing; there is nothing to compare it against, since
there is no second copy any more.

**What is still outstanding: the first real send has not been proved yet.** The
code that reads the key from Vault had not been deployed at the time the migration
was applied, so the endpoint was still answering 503 from the old env-var path.
Steps 3 and 4 below are the remaining verification, and they need a deploy of the
merged code first.

**3. Prove it works, without waiting for the scheduled run.** Run the job by hand and
read the response back inside pg_net's 6-hour TTL:

```sql
SELECT private.run_notification_digest();          -- raises if the secret is missing
SELECT id, status_code, content, error_msg, created
  FROM net._http_response ORDER BY created DESC LIMIT 1;
```

`status_code` 200 with a body like `{"ok":true,"considered":N,...}` is the
answer you want. **401 here means the endpoint's cached copy is stale** — it
reads Vault once and holds the value in memory for the life of the server
process, so a secret minted after the last deploy needs a redeploy (Publish →
Update) before the endpoint will see it; a fresh `jitsu.au` build reads Vault
again on its first request. 503 means the secret genuinely is not in Vault. A
row with `error_msg` and no status is a network or TLS failure.

**4. Confirm the next scheduled run.** The morning after:

```sql
SELECT status, return_message, start_time FROM cron.job_run_details
 WHERE jobname = 'notification-digest' ORDER BY start_time DESC LIMIT 3;
SELECT count(*) FROM public.notifications WHERE emailed_at IS NULL;
```

`succeeded` with a backlog that is not climbing is a working digest. The
notifications page is the standing version of that second query: the "daily email
summary has stopped" item disappears once the backlog is cleared and stays away
while it is being kept clear.

#### Rotating the key

`SELECT vault.update_secret(id, '<new value>') FROM vault.secrets WHERE name =
'notification_digest_key';` changes the one copy that exists. pg_cron reads it
fresh on every run, so the scheduler side is immediate. The endpoint side is
not: it caches the value in module scope after its first read, so **rotating
without a redeploy leaves the deployed site checking against the old value**
until the next publish. Rotate, then publish, in that order — the reverse gives
a window where every run 401s.

**Publishing shrinks that window, it does not close it.** The cache is
per-worker-isolate, and Cloudflare gives no guarantee that every edge isolate
picks up a new deploy at the same instant: an already-warm isolate can keep
answering with the OLD key until it happens to cycle, independent of when the
publish finished. So an old key can still be accepted for a while after
"rotate, then publish" — this is why rotating at all is worth doing (new
requests move to the new key as isolates cycle), not a claim that the old one
stops working the moment you publish.

That matters most for the reason anyone rotates a shared secret outside routine
hygiene: it leaked. Say what this credential actually buys somebody who still
has the old value during that tail: one POST that triggers a mail send, gated
by the same per-person-per-day idempotency key everyone else's runs use, and
nothing else — no read access to member data, no write path. Small blast
radius, but the docs should not imply the old key stops working the instant you
publish, because it does not.

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
`/email-settings` for somebody who clicked the link at the bottom of an email.
Both render `NotificationSwitches`, so the two can never offer different
choices.

**The emailed link is not the page.** It points at
`/email-settings/<token>`, which is a server handler with no screen of its own:
it puts the token in a short-lived cookie, redirects to a plain
`/email-settings`, and that is where the switches are. So the credential is
never in the address bar, never in the back button, and never in anything
anybody pastes. The token rides in the URL for that one hop because an email
client cannot send an `Authorization` header, the same constraint as
`/api/calendar/<token>` and `/api/verify-email/<token>`. Those two keep it on
screen: a calendar app subscribes to a URL and has nowhere else to put it, and
the verification link is single use and dead within the hour.

The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` on https, scoped to `/` and
good for **six hours**. Every one of those choices, including why `Lax`
rather than `Strict` and why `/` rather than a narrower path, is written down in
`src/lib/email-settings-session.ts`. Four consequences worth knowing:

- **Nothing expires the emailed link itself.** It stays exchangeable for as long
  as the row lives in `notification_tokens`, so an old email still works. What
  runs out is the six-hour session it hands you.
- **Those six hours are the browser's, not ours.** The cookie carries the same
  token the link does and nothing checks its age server-side, so a wholesale
  copy of a cookie jar keeps working until the token is rotated. Enforcing an
  age would mean signing an issued-at, which means a server secret to configure
  and rotate. The on-screen wording promises a page that stops saving, not a
  credential that expires, and that is why.
- **The exchange can be pointed at somebody.** A cross-site link to
  `/email-settings/<somebody else's token>` replaces the settings session this
  browser held, so the next person to open the page edits the linker's
  preferences rather than their own. Nothing leaks the other way. Closing it
  costs a "yes, this is my link" click on every legitimate visit, which is the
  same trade `/api/verify-email/<token>` declined.
- **`SameSite=Lax` is what makes the save safe.** The two server functions are
  POSTs authenticated by that cookie, and a cross-site POST does not carry a Lax
  cookie, so a page on another origin cannot flip somebody's switches for them.

The response is **uniform** at both hops. A token that never existed, one that
has been rotated, a malformed one and no cookie at all all end up on the same
screen. Anything else would make this a way to probe which links the club has
issued. The exchange endpoint touches no database at all, so a stream of guesses
costs a redirect and nothing more.

`/email-settings/` still carries `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`, because the exchange hop still has a token in its
path. The `no-store` matters more than it used to: a cached redirect would hand
one person's `Set-Cookie` to the next. That is set for every token path at once;
see "Security headers" in `CLAUDE.md`.

The signed-out page deliberately omits the manager switch. With no session it
cannot tell whether the person holds the role, and offering a manager-only
choice to a member would be a lie about what they can turn on.

It renders five states, not one: loading, the switches, "this link is no longer
live" (arrived with nothing usable), "this page has been open too long" (the
session ran out while they sat on it), and a `LoadFailure` panel with a retry
for a read that never landed. That last one is the distinction worth keeping:
the **uniform** answer above is about the token and only the token, and dressing
a dropped connection up as a dead link sends somebody on bad reception hunting
for a newer email that will fail the same way.

Saving goes through `useResilientSubmit` and `SubmitStatus`, like every other
writing form on the site, so a bad connection gets the timeout, the retries and
a failure panel that stays on screen. It needs no `client_submission_id`: a save
sets one named switch to one named value, so sending it twice lands on the same
row with the same value and there is nothing a duplicate could create. What the
panel does **not** claim is that nothing was saved, because a reply lost on the
way back means we genuinely do not know.

## What is deliberately not built

- **Upvotes notify nobody.** Not a conversation.
- **No per-thread mute.** The switches are per kind. If one thread turns noisy,
  the answer today is to turn thread activity off.
- **No in-app bell or toast.** The sidebar badge is the only in-app signal.
- **The attention list has five checks**: waivers waiting for approval, unanswered
  contact messages, a stalled daily digest, new interest registrations, and the
  club's training dates running out. Unmatched bank transactions and unpaid
  invoices are the obvious next entries and the shape supports them, but widening
  the manager queue further is separate work.
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

| Concern                      | File                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| The rules (pure, tested)     | `src/lib/notifications.ts`                                                    |
| The attention list           | `src/lib/manager-notifications.functions.ts`                                  |
| Contact messages             | `src/lib/contact-messages.functions.ts`, `contact-email.server.ts`            |
| Interest registrations       | `src/lib/leads.functions.ts`                                                  |
| Waivers waiting on a manager | `countWaiversAwaitingApproval` in `src/lib/waiver.functions.ts`               |
| The club-wide watermarks     | `src/lib/seen-markers.ts`                                                     |
| Who hears about what         | `src/lib/notification-events.server.ts`                                       |
| Sending, and the digest run  | `src/lib/notification-email.server.ts`                                        |
| Page and settings server fns | `src/lib/notifications.functions.ts`                                          |
| The shared query             | `src/hooks/useNotifications.ts`                                               |
| The page                     | `src/routes/_authenticated/notifications.tsx`                                 |
| The signed-out settings      | `src/routes/email-settings/index.tsx`                                         |
| The link exchange            | `src/routes/email-settings/$token.ts`                                         |
| The settings cookie          | `src/lib/email-settings-session.ts`                                           |
| The switches                 | `src/components/site/NotificationSwitches.tsx`                                |
| The sidebar badge            | `src/components/site/MemberLayout.tsx`                                        |
| The digest endpoint          | `src/routes/api/notifications/digest.ts`                                      |
| The schedule                 | `supabase/migrations/20260807000000_notification_digest_cron.sql`             |
| Failing loudly when unarmed  | `supabase/migrations/20260821000000_notification_digest_fails_loudly.sql`     |
| One key, minted once         | `supabase/migrations/20260822120041_68ab3908-faf6-49d1-8037-aaa3e39639aa.sql` |
| The key's typed RPC wrapper  | `notificationDigestKey` in `src/lib/supabase-rpc.ts`                          |
| The stalled-digest item      | `digestStalledNotifications` in `src/lib/validation.ts`                       |
| Email templates              | `src/lib/email-templates/comment-reply.tsx`, `notification-digest.tsx`        |
