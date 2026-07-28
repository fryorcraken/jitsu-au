# Waivers, the funnel, and member accounts

The product spec for how a person moves from "stranger on the website" to
"member with a login". `docs/database.md` documents the schema that backs this;
keep both aligned with the code in the same change.

## The model in one paragraph

Anyone can sign the training waiver at any time, no login needed, as long as
they give an email. A person is stored once: a **locked login record** carrying
their email (the only place any email lives) plus a **profile** carrying their
person fields. A waiver is a **frozen submission**: exactly what was typed, the
signed PDF, and the signer's IP and browser context. Nothing becomes official
until a **manager approves** a submission: approval copies its details onto the
profile, unlocks the login, emails a sign-in link, and assigns the free trial.
The **active waiver** is the latest approved one; everything else is history.

## The funnel

A person moves through these phases. The phase is always derived from their
records, never stored.

1. **Lead** — registered for the free trial ("Start your free trial" form).
   Just a lead row; no person record, no login, nothing else exists.
2. **Applicant** — signed the waiver. Now a person exists: a **locked** login
   record (their email, no way to sign in) plus a profile, with the
   submission(s) pending a manager's review.
3. **Visitor** — a manager approved their waiver: details promoted onto the
   profile, login unlocked (sign-in link emailed), and the free trial assigned
   automatically on the first approval.
4. **Member** — holds an active paid membership (semester, yearly insurance,
   or a paid casual session).
5. **Lapsed** — their trial or membership ended and nothing is active: the
   people to chase for a renewal.

Derivation precedence: active paid membership → member; something ended with
nothing active → lapsed; approved waiver → visitor; submission(s) pending →
applicant; otherwise lead.

**Managers** are club staff with the manager role, orthogonal to the funnel.
Someone browsing the site who has not provided an email is nothing in the
system. (The contact form stores a message, not a person.)

## Rules

1. **A person is identified by their email, stored exactly once** — on their
   login record (Supabase auth), which enforces uniqueness. The profile holds
   the person fields and no email.
2. **The person record starts at the waiver.** A lead is only a lead row;
   signing the waiver is what creates the locked login + profile (seeded with
   name and phone).
3. **A waiver is a frozen submission.** The submitted fields are evidence and
   the source approval copies from, never the live person record. Signatures
   and acknowledgement ticks exist only inside the PDF. For legal/forensic
   needs each submission also stores the signer's real IP and signing context
   (browser user agent, language, and the browser-reported timezone, screen and
   platform).
4. **Waivers are accepted at any time, without limit.** Resubmitting after a
   mistake is never blocked, before or after approval.
5. **The active waiver is the latest approved one.** Older approved waivers are
   superseded; unapproved ones stay pending. Screens derive this; it is not
   stored.
6. **Approval promotes, unlocks, and assigns the trial.** Approving a waiver
   copies its details onto the profile; on the person's first approval it also
   lifts the ban on their login, emails them a sign-in link, and assigns the
   club's free trial (one per person, ever — no activation email, they already
   got the sign-in one). Approving a newer waiver later refreshes the profile
   again (no repeat sign-in email, no second trial). Unapprove only reverts
   the waiver's status; profile, login and trial stay as they are.
7. **Full name is never stored**; it is composed from first/middle/last. The
   optional **preferred name** is stored separately (on the submission and, once
   approved, on the profile). One rule governs it everywhere: **address a person
   by their preferred name, else their first name** (`greetingName`). That is
   what the waiver and membership emails greet them with, and what the
   `{{preferred_name}}` template token renders. It never replaces the legal name
   on the signed document, and manager-facing lists show the legal name with the
   preferred name quoted in, e.g. `Ada "Addy" Lovelace` (`nameWithPreferred`),
   so staff can see both.
8. **No duplicate live data.** The profile is the only record of the person
   fields, and the login record is the only place any email lives. The email
   captured on a waiver is part of that frozen submission (evidence), not a
   live record. There is no self-serve email change; a future manager action
   changes it in the one place it lives.
9. **No self-serve sign-up.** Logins are created locked by waiver submission
   and unlocked by approval. The auth page only signs people in (password or
   magic link, with `shouldCreateUser: false`; a locked login cannot sign in).

## Flows

### Lead registers for the free trial

The "Start your free trial" page (`/register-interest`) is step 1: name, email
(**required**), optional phone and a note. The registration is stored as a
lead row (`interest_registrations`) and nothing else happens — a lead is not a
person yet. They then continue to the waiver (step 2) with name/email/phone
carried over. Leads appear in the manager directory (merged in by email) until
they sign the waiver.

### Applicant signs the waiver

Public page (`/waiver`), optionally prefilled from the free-trial flow. Email
is required. On submit the signer immediately gets the signed PDF and a copy
by email; managers are notified. Behind the scenes, for a new email: a locked
login record is created (their email, no way to sign in) and their profile is
seeded with name + phone. An existing person is left untouched. Either way the
waiver row stores the full submission, and the person is now an applicant.

### Mistake or changed details

Submit again with the same email. Always accepted, whatever phase that email's
person is in: a resubmission attaches to the existing person and never
modifies them. Managers decide which submission to approve.

### Email edge cases

- **Signed-in people sign for themselves.** The form locks the email field to
  their login email, and the server rejects a submission whose email does not
  match it (prevents a typo or someone else's address attaching the waiver to
  the wrong person, or creating a duplicate person). To sign for someone else,
  log out first.
- **An unregistrable email** (rejected by the auth system) fails with a clear
  "check it for typos" message, never a raw database error.
- **Signing in with an applicant's email** does nothing special: the auth page
  responds identically for unknown, locked, and active emails, so nothing is
  leaked about who exists.

### Manager reviews and approves

The manager waivers screen lists submissions newest first with the submitted
name/email, date, template version, status badge (pending / active /
superseded), the PDF, and Approve / Unapprove. Approve = promote + unlock +
assign the trial (see rule 6). The applicant becomes a visitor.

For one person there is a user page (`/manager/users/:userId`, reached from the
directory), which is where a review normally happens: the profile (the club's
current record), their memberships, and every submission they ever made, newest
first. Each submission is a collapsible panel holding the frozen submission in
full, the signing record (IP + browser context), Approve / Unapprove, and the
signed PDF embedded inline. The submissions themselves load with the page; the
PDFs do not, since each needs a short-lived signed URL, so one is signed when a
panel is opened or its PDF button is used, and re-signed once it goes stale.
Exactly one panel opens by itself: the newest
submission, and only while it is still pending, because that is the one waiting
on a decision. Older submissions and approved ones (active or superseded) start
collapsed; a manager can open any of them by hand.

### Visitor or member uses the member area

Login exists only via approval (sign-in link email, valid for 10 minutes and
stated as such in the email; magic link or password thereafter). They see: the
waiver form prefilled from their profile, their waiver history with the active
one marked and PDFs downloadable, and memberships (buying a paid plan makes a
visitor a member).

### Manager looks at the funnel

One row per person: composed name, email, phone, roles, funnel phase, whether
they have an active (approved) waiver, student number, memberships/invoices.
Leads are merged in by email and drop out of the lead phase the moment they
sign the waiver. Feeds the manager screens and the manager agent API
(`lifecycle_status`: `lead | applicant | visitor | member | lapsed`). Each
person links through to their user page; a lead has no person record yet, so
there is nothing to open.

## Future features (out of scope today)

- Members self-editing their profile (changes flow through a new approved
  waiver, or a manager).
- A manager action to change a person's email (one update, on the login
  record — the only place it lives).
- Contact-form senders becoming leads.
- Waiver expiry / forced re-signing on template changes.
