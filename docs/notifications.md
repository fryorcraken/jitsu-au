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

The workflow runs on `schedule` and `workflow_dispatch` only, never on
`pull_request`. It holds a credential that makes the live site email its
members, and this repo takes same-repo branches from Lovable and from coding
agents, so pairing that secret with a workflow a PR can rewrite would be a way
to exfiltrate it, or to mail every member, in one line. Same reasoning as
`migration-drift.yml`.

There is no other scheduler available: the Supabase project is Lovable-managed
and `pg_cron` is not in this repo's migrations, and there is no `wrangler.toml`
here because Lovable owns the deploy. `cron: "0 20 * * *"` is 7am in Sydney
during daylight saving and 6am outside it; cron has no notion of DST and an
hour's drift on a club digest is not worth a scheduler of our own.

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

The signed-out page deliberately omits the manager switch. With no session it
cannot tell whether the person holds the role, and offering a manager-only
choice to a member would be a lie about what they can turn on.

## What is deliberately not built

- **Upvotes notify nobody.** Not a conversation.
- **No per-thread mute.** The switches are per kind. If one thread turns noisy,
  the answer today is to turn thread activity off.
- **No in-app bell or toast.** The sidebar badge is the only in-app signal.
- **The attention list keeps the one check it had.** Pending waiver approvals,
  unmatched bank transactions and unpaid invoices are all obvious next entries
  and the shape supports them, but widening the manager queue is separate work.
- **No digest for somebody with nothing.** An empty digest is not sent, and the
  rows are stamped anyway so tomorrow's run is not re-reading them forever.

## Known gap this did not fix

`contact_messages` is **write-only**. The contact form saves a row and nothing
in the app ever reads it: no manager screen, no server function, no email
(unlike the interest form, which does notify managers). Anybody who has used the
contact form has been talking into a void. It is a real bug, it is out of scope
here, and it deserves its own fix.

## Where the code lives

| Concern                      | File                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| The rules (pure, tested)     | `src/lib/notifications.ts`                                             |
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
