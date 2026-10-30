# Erasing a person's data

What the club can destroy, what it deliberately cannot, and where every piece of
a person actually lives. The short version: **a manager can delete an enquiry,
and nothing else about a person is ever erased.** That is a decision, not a gap
waiting to be filled (see "The decision" below).

**Nothing in here is legal advice.** The privacy points below are a reading of
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

An enquiry is the one exception because it is not a person's record: a lead
signed nothing, owes nothing and has nothing hanging off them, and a contact
message is just something somebody wrote to the club. Keep that boundary. A
change that lets the enquiry delete reach anything with a person behind it is
building the thing "The decision" rules out.

## Archiving is not erasure

A manager will be able to mark a person as having **left the club**
(`profiles.archived_at`). Today only the columns exist and nothing reads or
writes them; the screens, the API and the email exclusions are the next change.
It is a reversible bookkeeping mark, and it is the club's answer to "everyone
who ever signed stays on the books", because it destroys nothing:

- Every record, waiver, PDF, membership and check-in will stay exactly as it is.
- The person will still be able to sign in, see their account and pay what they
  owe. It is not a ban.
- What it will change is who the club **contacts**: an archived person is to get
  no club-initiated mass email, while mail that answers something they did or
  owe still reaches them. Until the next change lands, nothing excludes anybody.

So archiving is never a step towards deleting anybody, and nothing should treat
it as consent to delete, or as the start of a retention clock. For somebody who
has left, archiving is the whole answer.

## The decision: people are not erased

The club decided on 2026-10-30 not to build a way to erase or de-identify a
person, and closed issue #55 (the pre-launch review's "there is no way to erase
a person's data") as not planned. So there is no "delete this member" for a
manager, no "delete my account" for a member, and no request flow that ends in
either.

The reasons it was never a small feature, kept so the question is not reopened
without them:

- **A signed waiver is the club's evidence of informed consent**, and there is
  likely a period in which a claim can still be brought. For minors that period
  commonly starts when the person turns 18. Deleting on request would destroy
  exactly the document the club would most want if an old injury surfaced.
- **Copies have already left.** Waiver PDFs exported to a manager's personal
  Google Drive, and the PDF link emailed at signing, cannot be recalled, so any
  promise of deletion would overstate what the club can actually do.

What follows from the decision:

- **The privacy policy must not promise deletion on request.** When one is
  written, it should say what the club keeps and why, and that an enquiry can be
  removed. Worth raising with whoever reviews it: the Australian Privacy
  Principles (APP 11.2) also expect information to be destroyed or de-identified
  once it is no longer needed, which is a separate question from deletion on
  request. Not deleting on request is a choice the club can make; keeping
  everything forever may not be.
- **Do not build a deletion path on the strength of this file's map.** The map
  below is kept because the by-hand case is dangerous and somebody may one day
  be obliged to do it anyway, not as a design for a feature. Reopening this is
  a product decision for the club first.

## Where a person's data actually lives

The map, for the day somebody is asked to remove a person by hand anyway (a
legal obligation, say). Deleting the `auth.users` row by hand is worse than
doing nothing, because it destroys the record and keeps the documents. Since
dependants exist it may also simply fail, which is the one case where doing it
by hand tells you so (see the box below).

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
> ⚠️ **And reconcile the guardian's `member` role afterwards.** Since #107 that
> label counts the memberships of everybody on a person's account, and the only
> thing that reconciles it is a membership event. Deleting a child, or moving
> them to another guardian, changes who is on whose account and fires no such
> event, so the parent keeps a `member` row that describes a household they no
> longer have (and a new guardian does not gain one). The row then contradicts
> the funnel phase beside it, which is derived live and does update.
>
> There is no screen for it. After deleting or re-homing a child, delete any
> stale row by hand -- `DELETE FROM public.user_roles WHERE user_id = '<the
guardian>' AND role = 'member'` -- unless that person still holds, or still
> looks after somebody who holds, an active paid membership. Raising or closing
> any membership on the household puts it right automatically.

> **So deal with the children first.** Whoever is doing the deletion has to
> decide, per child, whether that person is also leaving the club:
>
> - **The child is leaving too.** Delete each child first, as their own
>   deletion. A child who trained has signed a waiver, so this is the hard
>   case, not the easy one, and minors are exactly where the retention question
>   bites (see "The decision" above).
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

**Survives, holding personal data:**

| What                                         | Why                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed waiver PDFs in the `waivers` bucket   | Storage objects have no FK. The row cascades, the file does not. Each is `<waiver_id>.pdf`, and the id is gone with the row, so an orphaned file cannot even be traced back.                                                                                                                                                                        |
| `memberships`                                | `user_id` is `ON DELETE SET NULL`. The row stays, orphaned, still carrying `uts_student_number` and `payment_reference`. `item_invoices` is orphaned the same way but holds nothing personal once it is: its reference is a bare number (`INV0007`) and its lines are what was bought.                                                              |
| `interest_registrations`, `contact_messages` | No user FK at all. Name, email, phone, free text. The one part a manager can delete from the product (see "What exists today").                                                                                                                                                                                                                     |
| `bank_transactions`                          | The club's financial record. A member's name appears incidentally, in text the bank wrote.                                                                                                                                                                                                                                                          |
| Google Drive exports                         | The file lives in a manager's personal Drive, named `<date> - <the name on the waiver>.pdf`. `waiver_drive_uploads` records the Drive file id, so a deletion path COULD remove it, but only while that manager still has Drive connected, and never a copy they moved by hand. `disconnectGoogleDrive` deliberately leaves exported files in place. |
| The signed download link emailed at signing  | Expires, but the PDF may already be saved elsewhere. Not recallable.                                                                                                                                                                                                                                                                                |

**Audit columns blank out silently** (`ON DELETE SET NULL`): `waivers.approved_by`,
`blog_posts.author_id`, `kb_articles.created_by`, `kb_article_versions.created_by`,
`kb_annotations.resolved_by`, `session_checkins.checked_in_by`,
`calendar_series.created_by`, `calendar_events.created_by`,
`waiver_templates.created_by`,
`club_settings.updated_by`, `bank_transactions.matched_by`,
`profiles.media_consent_updated_by`, `profiles.archived_by`, `blog_comments.hidden_by`,
`blog_blocked_commenters.blocked_by`, `manager_api_tokens.created_by`,
`notifications.actor_id`. So deleting a **manager** quietly erases who approved
what. Never do it by hand without the club agreeing to lose that history first.

One thing that does fail safe: a manager API token whose owner is gone is
rejected, because `/api/manager/agent` refuses a token with no `created_by`
(see `docs/manager-agent-api.md`).
