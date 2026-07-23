# Waivers, visitor profiles, and member accounts

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
profile, unlocks the login, and emails the person a sign-in link. The **active
waiver** is the latest approved one; everything else is history.

## People involved

- **Visitor**: someone who has given the club their email, by registering for
  the free trial or by signing the waiver. That is the moment a person starts
  existing in the system: a **locked** login record (their email, no way to
  sign in) plus a visitor profile (name, phone). Someone browsing the site who
  has not provided an email is nothing in the system. (The contact form is the
  deliberate exception: it stores a message, not a person.)
- **Member**: a person whose waiver was approved; their login is unlocked.
- **Manager**: club staff with the manager role.

## Rules

1. **A person is identified by their email, stored exactly once** — on their
   login record (Supabase auth), which enforces uniqueness. No email, no
   record: nothing is stored about anyone until they provide an email. The
   profile holds the person fields and no email.
2. **A person starts as a visitor**: a locked login (banned, no credentials,
   cannot sign in) plus a profile that may hold just a name and phone. They may
   have waivers attached, or none.
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
6. **Approval promotes and unlocks.** Approving a waiver copies its details
   onto the profile and, on the person's first approval, lifts the ban on their
   login and emails them a sign-in link to set up access. Approving a newer
   waiver later refreshes the profile again (no repeat sign-in email).
   Unapprove only reverts the waiver's status; profile and login stay as they
   are.
7. **Full name is never stored**; it is composed from first/middle/last.
8. **No duplicate live data.** The profile is the only record of the person
   fields, and the login record is the only place any email lives. The email
   captured on a waiver is part of that frozen submission (evidence), not a
   live record. There is no self-serve email change; a future manager action
   changes it in the one place it lives.
9. **No self-serve sign-up.** Logins are created locked by waiver submission
   and unlocked by approval. The auth page only signs people in (password or
   magic link, with `shouldCreateUser: false`; a locked login cannot sign in).

## Flows

### Visitor registers for the free trial

The "Start your free trial" page (`/register-interest`) is step 1: name, email
(**required**), optional phone and a note. On submit:

- the registration is stored as a lead row (`interest_registrations`, kept
  as-is for the club's records), and
- for a new email, the person starts existing: a locked login record plus a
  visitor profile seeded from the form (name split into parts, phone, and
  SMS/WhatsApp consent implied by providing a phone number). An existing
  person is left untouched. Person creation is best-effort: a hiccup there
  never loses the lead.

They then continue to the waiver (step 2) with name/email/phone carried over.
Trial registrants appear in the manager directory as prospects.

### Visitor signs the waiver

Public page (`/waiver`), optionally prefilled from the free-trial flow. Email
is required. On submit the visitor immediately gets the signed PDF and a copy
by email; managers are notified. Behind the scenes, for a new email: a locked
login record is created (their email, no way to sign in) and their profile is
seeded with name + phone. An existing person is left untouched. Either way the
waiver row stores the full submission.

### Mistake or changed details

Submit again with the same email. Always accepted, whether that email belongs
to a visitor or a member: a resubmission attaches to the existing person and
never modifies them. Managers decide which submission to approve.

### Email edge cases

- **Signed-in people sign for themselves.** The form locks the email field to
  their login email, and the server rejects a submission whose email does not
  match it (prevents a typo or someone else's address attaching the waiver to
  the wrong person, or creating a duplicate person). To sign for someone else,
  log out first.
- **An unregistrable email** (rejected by the auth system) fails with a clear
  "check it for typos" message, never a raw database error.
- **Signing in with a visitor's email** does nothing special: the auth page
  responds identically for unknown, locked, and active emails, so nothing is
  leaked about who exists.

### Manager reviews and approves

The manager waivers screen lists submissions newest first with the submitted
name/email, date, template version, status badge (pending / active /
superseded), the PDF, and Approve / Unapprove. Approve = promote + unlock
(see rule 6).

### Member uses the member area

Login exists only via approval (sign-in link email; magic link or password
thereafter). Members see: the waiver form prefilled from their profile, their
waiver history with the active one marked and PDFs downloadable, and
memberships.

### Manager looks at people

One row per person from profiles: composed name, email, phone, roles,
lifecycle, whether they have an **active** (approved) waiver, student number,
memberships/invoices. Feeds the manager screens and the manager agent API.

## Future features (out of scope today)

- Members self-editing their profile (changes flow through a new approved
  waiver, or a manager).
- A manager action to change a person's email (one update, on the login
  record — the only place it lives).
- Contact-form senders becoming visitors (today a contact message is just a
  message).
- Waiver expiry / forced re-signing on template changes.
