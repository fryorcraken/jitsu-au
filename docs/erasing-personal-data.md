# Erasing a person's data

What the club can destroy today, what it deliberately cannot, and where every
piece of a person actually lives. Opened by issue #55 (live readiness), where
the product decisions behind it are still being made.

**Nothing in here is legal advice.** The retention points below are a reading of
the pre-launch review, not an independent view, and a practitioner should
confirm them alongside the privacy policy. There is no privacy policy page on
the site yet, so no promise has been made that the code has to live up to.

## What exists today

One thing: **a manager can delete an enquiry.**

- `/manager/contact-messages` deletes a single message, with the name, address
  and words on it. `deleteContactMessage`
  (`src/lib/contact-messages.functions.ts`).
- `/manager/users` deletes a **lead**, meaning every interest-form registration
  filed under one address. `deleteLead` / `deleteLeadRegistrations`
  (`src/lib/leads.functions.ts`).

Both go through the service-role client behind the manager gate, so neither
needed a grant, a policy or a migration: `interest_registrations` and
`contact_messages` grant the client roles a bare `INSERT` and nothing else (see
`docs/database.md`).

Three rules hold that path together, and all of them are load-bearing:

- **A lead delete re-checks that the address has no person behind it**, on the
  server, every time. The directory a manager clicked from can be minutes old,
  and a waiver signed in between turns a lead into an applicant with a profile
  and frozen evidence under the same address. Deleting their enquiry then is not
  clearing an untouched form, it is taking a piece out of somebody's record.
  What that closes is the staleness, not a race: the check and the delete are
  separate round trips, so a waiver signed in the sub-second gap between them
  still loses its lead row. The address survives on the waiver as submitted,
  which is the copy that matters.
- **The search is not the decision.** Registrations store the address as typed,
  so one person can hold two rows differing only in capitalisation, and both
  have to go or the lead reappears. The query prefilters with `ilike`, which
  **over**-matches (`_` is a LIKE wildcard and is legal in an email local part,
  so `a_b@example.com` also matches `axb@example.com`), and the exact comparison
  in JS chooses what is deleted. Backwards, that pattern destroys a stranger's
  enquiry. `%` is a wildcard too, and the interest form's validator happens to
  reject it today, which is not something the delete should lean on.
- **The read is capped**, like every other read in that file. One address
  holding more registrations than the cap logs a warning and leaves the
  remainder, so the lead reappears and a second press takes another bite. On a
  delete, doing less than asked is the safe direction to fail.

Everything else about a person is untouched, on purpose. There is no way to
delete a member, a waiver, a PDF or a login, by design rather than by omission.

## Why the rest is not built

Erasure for anyone who has signed something needs two answers the club has not
given yet:

1. **Does "delete me" mean erase or de-identify?** Stripping the person out and
   keeping the skeleton (a waiver was signed on this date against this template;
   a membership ran for these dates at this price) keeps the club's own history
   without holding the person. Full erasure is simpler and leaves the club with
   no evidence anybody consented to train.
2. **What must be retained anyway, and for how long?** A signed waiver is
   evidence of informed consent, and there is likely a period in which a claim
   can still be brought. Minors are the sharp edge: that period commonly starts
   when the person turns 18, so "N years from signing" and "until 18 plus N"
   give very different answers for the same document. An insurer may also ask
   for longer than the law does.

Building either on a guess destroys evidence the club needs or keeps documents
it should not have, which is why the slice above stops where it does.

## Where a person's data actually lives

The map, for whoever builds the rest. Deleting the `auth.users` row by hand
today is worse than doing nothing, because it destroys the record and keeps the
documents. Since dependants exist it may also simply fail, which is the one
case where doing it by hand tells you so (see the box below).

**Cascades from the login** (`ON DELETE CASCADE`, directly or through
`profiles.user_id`): `profiles`, `waivers` (the frozen submission, including the
email as submitted), `session_checkins`, `code_of_conduct_acceptances`,
`kb_annotations`, `kb_article_reads`, `notifications`,
`notification_preferences`, `notification_tokens`, `event_rsvps`,
`calendar_feed_tokens`, `email_verification_tokens`, `blog_comments`,
`blog_comment_upvotes`, `blog_blocked_commenters`, `user_roles`,
`app_user_connections`, `waiver_drive_uploads` (via `waivers`).

> [!IMPORTANT]
> **A parent with children on their account does not cascade. It fails.**
>
> `profiles.guardian_user_id` is `ON DELETE RESTRICT`, not `CASCADE`, so
> deleting the `auth.users` row of anybody who still has a dependant on the
> books is refused by Postgres with a raw `23503` foreign-key violation. That
> is the whole list above not happening: nothing is deleted, and the error is
> a constraint name rather than a sentence anyone can act on.
>
> It is the right behaviour. The alternative was a cascade, and a cascade from
> a parent would take every child on the account with them: their waivers,
> their memberships, their attendance. A child is a person in their own right
> here, not a field on their parent's record, and deleting a parent must never
> be a way to delete a child by accident.
>
> **So deal with the children first.** Whoever is doing the deletion has to
> decide, per child, whether that person is also leaving the club:
>
> - **The child is leaving too.** Delete each child first, as their own
>   deletion, with the same questions in "Why the rest is not built" answered
>   for each of them. A child who trained has signed a waiver, so this is the
>   hard case, not the easy one, and minors are exactly where the retention
>   question bites (see below).
> - **The child is staying**, which is realistic: a parent who separates, or
>   who hands the account to another adult. The child has to be moved to a
>   different guardian before the parent can go. There is no screen for that
>   today. It is one `UPDATE` on `profiles.guardian_user_id`, but doing it by
>   hand means picking a guardian who is not themselves a dependant, because
>   the one-level rule is enforced in the application rather than by a trigger
>   (`src/lib/household.ts`).
>
> Only once no `profiles` row points at them may the parent be deleted, and
> only then does the cascade above describe what happens.
>
> Whatever gets built should ask this question out loud rather than letting a
> manager discover it as a `23503`, the same way it should refuse a manager
> outright (see the audit columns below).

**Survives, holding personal data:**

| What                                         | Why                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed waiver PDFs in the `waivers` bucket   | Storage objects have no FK. The row cascades, the file does not. Each is `<waiver_id>.pdf`, and the id is gone with the row, so an orphaned file cannot even be traced back.                                                                                                                                                                        |
| `memberships`                                | `user_id` is `ON DELETE SET NULL`. The row stays, orphaned, still carrying `uts_student_number` and `payment_reference`.                                                                                                                                                                                                                            |
| `interest_registrations`, `contact_messages` | No user FK at all. Name, email, phone, free text. This is the only part the slice above closes.                                                                                                                                                                                                                                                     |
| `bank_transactions`                          | The club's financial record. A member's name appears incidentally, in text the bank wrote.                                                                                                                                                                                                                                                          |
| Google Drive exports                         | The file lives in a manager's personal Drive, named `<date> - <the name on the waiver>.pdf`. `waiver_drive_uploads` records the Drive file id, so a deletion path COULD remove it, but only while that manager still has Drive connected, and never a copy they moved by hand. `disconnectGoogleDrive` deliberately leaves exported files in place. |
| The signed download link emailed at signing  | Expires, but the PDF may already be saved elsewhere. Not recallable.                                                                                                                                                                                                                                                                                |

**Audit columns blank out silently** (`ON DELETE SET NULL`): `waivers.approved_by`,
`blog_posts.author_id`, `kb_articles.created_by`, `kb_article_versions.created_by`,
`kb_annotations.resolved_by`, `session_checkins.checked_in_by`,
`calendar_series.created_by`, `calendar_events.created_by`,
`waiver_templates.created_by`,
`club_settings.updated_by`, `bank_transactions.matched_by`,
`profiles.media_consent_updated_by`, `blog_comments.hidden_by`,
`blog_blocked_commenters.blocked_by`, `manager_api_tokens.created_by`,
`notifications.actor_id`. So deleting a **manager** quietly erases who approved
what. Whatever gets built should refuse a manager outright, or make the club
say so first.

One thing that does fail safe: a manager API token whose owner is gone is
rejected, because `/api/manager/agent` refuses a token with no `created_by`
(see `docs/manager-agent-api.md`).

## What the product would still need

In the order I would build it, once the questions above are answered:

1. Delete an enquiry. **Done.**
2. Delete a person who never signed anything, as one operation. Refused when a
   waiver, a membership or attendance is behind them, and refused with a
   sentence rather than a `23503` when they still have children on their
   account (see the box above). A "move these children to another guardian"
   step is what would unblock the second case, and it is worth building
   whether or not deletion ever is: it is also the answer when a family
   changes shape and nobody is leaving.
3. Delete or de-identify a person who did sign: their record, login, comments,
   notifications, attendance and PDFs, with the waiver either going with them or
   retained for the agreed period and kept out of the day-to-day screens.
4. A member-facing **request**, if the club wants one, landing in the manager
   queue rather than destroying anything on the spot.

Steps 2 and 3 need a migration (a retention stamp at minimum), so
`docs/database-changes.md` applies to both.
