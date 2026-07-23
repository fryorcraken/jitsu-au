# Waivers, visitor profiles, and member accounts

The product spec for how a person moves from "stranger on the website" to
"member with a login". `docs/database.md` documents the schema that backs this;
keep both aligned with the code in the same change.

## The model in one paragraph

Anyone can sign the training waiver at any time, no account needed, as long as
they give an email. The club keeps one lightweight **profile per email**. A
waiver is a **frozen submission**: exactly what was typed, the signed PDF, and
the signer's IP. Nothing becomes official until a **manager approves** a
submission: approval copies its details onto the person's profile and, if they
have no login yet, creates their account and emails them an invite. The
**active waiver** is the latest approved one; everything else is history.

## People involved

- **Visitor**: someone who has given the club their email. That is the moment a
  person starts existing in the system, as a visitor profile. Someone browsing
  the site who has not provided an email is nothing in the system.
- **Member**: a person whose waiver was approved; they have a login.
- **Manager**: club staff with the manager role.

## Rules

1. **A person is identified by their email.** One profile per email
   (lowercased/trimmed). No email, no record: nothing is stored about anyone
   until they provide an email.
2. **A profile starts as a visitor profile**: possibly just an email, usually
   also a name and phone. It may have waivers attached, or none. No login yet.
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
6. **Approval promotes and provisions.** Approving a waiver copies its details
   onto the profile (created as a visitor profile at submission time) and, if
   the person has no login, creates their account and sends an invite email.
   Approving a newer waiver later refreshes the profile again. Unapprove only
   reverts the waiver's status; profile and account stay as they are.
7. **Full name is never stored**; it is composed from first/middle/last.
8. **No duplicate live data.** The profile is the only current record, and
   `profiles.email` is the only email the app reads. The login (Supabase auth)
   necessarily also holds an email as the credential, but it is write-once:
   copied from the profile at provisioning and never edited on its own. There
   is no self-serve email change; changing a person's email means updating the
   profile and the login together, which is a manager/support action.
9. **No self-serve sign-up.** Accounts exist because a manager approved a
   waiver. The auth page only signs people in (password or magic link, with
   `shouldCreateUser: false`).

## Flows

### Visitor signs the waiver

Public page (`/waiver`), optionally prefilled from the free-trial flow. Email
is required. On submit the visitor immediately gets the signed PDF and a copy
by email; managers are notified. Behind the scenes: a visitor profile is
created for a new email (name + phone only; an existing profile is left
untouched), and the waiver row stores the full submission.

### Mistake or changed details

Submit again with the same email. Always accepted. Managers decide which
submission to approve.

### Manager reviews and approves

The manager waivers screen lists submissions newest first with the submitted
name/email, date, template version, status badge (pending / active /
superseded), the PDF, and Approve / Unapprove. Approve = promote + provision
(see rule 6).

### Member uses the member area

Login exists only via approval (invite email; magic link or password
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
- A manager action to change a person's email (updates the profile and the
  login credential together).
- Interest-form registrations creating visitor profiles.
- Waiver expiry / forced re-signing on template changes.
