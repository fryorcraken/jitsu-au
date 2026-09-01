# Waivers, the funnel, and member accounts

The product spec for how a person moves from "stranger on the website" to
"member with a login". `docs/database.md` documents the schema that backs this;
keep both aligned with the code in the same change.

## The model in one paragraph

Anyone can sign the training waiver at any time, no login needed, as long as
they give an email. A person is stored once: a **locked login record** carrying
their email (the only place any email lives) plus a **profile** carrying their
person fields. A parent can sign for a child instead of for themselves, and the
child gets a person record of their own with no login and no email address:
everything about them reaches the parent (rule 1). A waiver is a **frozen
submission**: exactly what was typed, the signed PDF, and the signer's IP and
browser context. Nothing becomes official until a **manager approves** a
submission: approval copies its details onto the profile, unlocks the login of
whoever the club writes to about that person, emails them that their account is
active, and assigns the free trial.
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
   profile, login unlocked (account-activated email sent), and the free trial
   assigned automatically on the first approval.
4. **Member** — holds an active paid membership (semester, yearly insurance,
   or a paid casual session).
5. **Lapsed** — their trial or membership ended and nothing is active: the
   people to chase for a renewal.

Derivation precedence: active paid membership → member; something ended with
nothing active → lapsed; approved waiver → visitor; submission(s) pending →
applicant; otherwise lead.

A **dependant** moves through the same five phases as anybody else, because
they are an ordinary person record: their own waiver, their own trial, their own
membership. The only difference is that phase 3 unlocks their guardian's login
rather than one of their own.

⚠️ A **guardian** does not, yet. `has_active_paid_membership` counts a
dependant's membership, so a parent whose child is paid up gets the members-only
calendar, but the phase above and the `member` role still count only a person's
own memberships. So that parent reads as `lead` or `lapsed` on `/manager/users`
and lands in the renewal-chasing list while holding live access. The migration
that created the split recorded this as unreachable "until #105 creates the
first dependant"; #105 is this change, so it is reachable now, and #107
reconciles the two.

**Managers** are club staff with the manager role, orthogonal to the funnel.
Someone browsing the site who has not provided an email is nothing in the
system. (The contact form stores a message, not a person.)

## Rules

1. **A person is identified by their person record. An ACCOUNT HOLDER is
   identified by their email.** Those used to be the same sentence, and the
   difference is what lets a family share one address.

   An account holder is a person the club writes to, and their email is stored
   exactly once, on their login record (Supabase auth), which enforces
   uniqueness. The profile holds the person fields and no email.

   A **dependant** is a person on somebody else's account: a child, most
   obviously. They have a full person record like anyone else, and no login,
   ever. `profiles.guardian_user_id` is the only thing that marks them, and it
   names the account holder everything about them reaches. Their login record
   still carries an address, because auth requires one, but it is a reserved,
   non-deliverable string the server generates, and their login is permanently
   banned. Nothing identifies a person by it.

   **"Never printed, never sent to" is now enforced rather than merely
   intended.** The two questions a person's address answers are split in two
   (`src/lib/household-email.ts`), and the reserved string is never looked up
   at all: every lookup resolves the CONTACT person first and asks
   `user_emails` only about them, so a dependant's own address does not enter
   the process and cannot leak from a field somebody adds later.
   - **Delivery.** Invoices, receipts, the daily digest and the transactional
     emails all resolve the recipient through `deliveryRecipientFor` /
     `deliveryEmailFor`, so a message about a child goes to their guardian,
     greets the guardian, and names the child it is about.
   - **Display.** `/manager/users` and a person's page show the guardian's
     address and say whose it is (`email_belongs_to`), because a bare address
     under a child's name reads as a mailbox somebody can write to. The
     verification pill now reflects the **guardian's** login, not the child's
     unverifiable one, and **Resend verification** is refused for a dependant.

   ⚠️ One gap is left, deliberately: **Change email** (`setClubUserEmail`) still
   acts on the person's own login record, so a manager can point it at a
   dependant. #107 owns that, along with the rest of the manager-side household
   work.

   So two children in one family are two people under one address, which is
   what the club actually has. Before this, the second child's waiver resolved
   to the first child's record and quietly overwrote it (#102).

2. **The person record starts at the waiver.** A lead is only a lead row;
   signing the waiver is what creates the locked login + profile (seeded with
   name and phone).
3. **A waiver is a frozen submission.** The submitted fields are evidence and
   the source approval copies from, never the live person record. Signatures,
   acknowledgement ticks and the five yes/no health answers exist only inside
   the PDF. What the signer wrote to explain a "yes"
   is a stored field (`medical_notes`), because instructors need it to hand. For legal/forensic
   needs each submission also stores the signer's real IP and signing context
   (browser user agent, language, and the browser-reported timezone, screen and
   platform).
   The form also asks, optionally, for a **gi size** and **previous martial
   arts experience**, and neither is part of the waiver: the gi size is
   equipment sizing and the experience is context for instructors, not
   anything being declared, so no `waivers` column holds either, neither is on
   the PDF, and both go straight onto the profile. Leaving either blank writes
   nothing, so signing again never wipes one already on file, and the gi size
   seeds a belt size only when there is none (the two kids' gi sizes have no
   belt counterpart and take the shortest belt). Gi and belt size are editable
   afterwards on `/account` and by a manager; martial arts experience is not
   (only re-signing the waiver updates it).

   **One acknowledgement is also a column.** The media/photo consent tick
   (`media` — the only acknowledgement id the code reads by name) is copied to
   `waivers.media_consent` at submission, and from there onto the profile at
   approval. Same test as `medical_notes`: an acknowledgement the club has to
   _act_ on, rather than produce as evidence, cannot live only in a PDF —
   nobody opens forty of them before posting a photo. It differs from the gi
   size above in that it IS part of the waiver: the signer agrees to it on the
   document, the tick still renders in the PDF, and that remains the record of
   what was agreed. The column is a derived working copy, never the other way
   round. Every other acknowledgement stays PDF-only, and the template editor
   refuses to delete the `media` item so a routine reword cannot silently stop
   the capture.

4. **Waivers are accepted at any time, without limit.** Resubmitting after a
   mistake is never blocked, before or after approval.
5. **The active waiver is the latest approved one.** Older approved waivers are
   superseded; unapproved ones stay pending. Screens derive this; it is not
   stored.
6. **Approval promotes, unlocks, and assigns the trial.** Approving a waiver
   copies its details onto the profile; on the person's first approval it also
   lifts the ban on **their contact person's** login, emails them to say their
   account is active, and assigns the club's free trial (one per person, ever —
   no membership activation email, the account one covers it).

   **"Their contact person" is the participant themselves, unless they are a
   dependant, in which case it is their guardian.** So approving a child's
   waiver opens the PARENT's login, not the child's: the child has none and
   never will, and unlocking theirs would open an account nobody can reach,
   keyed on an address nothing delivers to, while leaving the parent locked out
   of the club they just joined. The activation email greets the parent and
   names the child, so a parent who never trains can tell what the account is
   for. Everything else stays on the participant: the profile promotion and the
   free trial are theirs, which is what gives each child in a family their own
   record and their own trial. That email carries **no
   sign-in link**: it names the address their login is keyed on and sends them
   to `/auth` to request a link themselves. An unrequested magic link expires
   in an hour, so it is usually dead by the time it is read, while this one
   still works whenever they get to it. Approving a newer waiver later
   refreshes the profile again (no repeat activation email, no second trial).
   Revoking approval only reverts the waiver's status; profile, login and
   trial stay as they are.
   The trial is dated from the day the waiver was **signed**, not the day it
   was approved, so the row records when the entitlement was really earned: a
   form filled in at the gym may not be approved until hours or days later.
   Approving late never costs anyone a session either way — a trial is a
   balance of credits and no date gates it at check-in (`docs/check-in.md`).

   **Rule 6 is where what approval does is written down.** Six other places
   lean on it and cite it rather than own it: `CLAUDE.md` (the `profiles`
   bullet), `docs/database.md` (the schema it writes), `docs/notifications.md`
   (the manager's confirm copy), `docs/knowledge-base.md` (why the waiver email
   carries no knowledge base link), `docs/manager-agent-api.md` and
   `.claude/skills/uts-manager-agent/SKILL.md` (`file_waiver` never approves).
   Change this rule and re-read those six.

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
   live record.

   For a **child's waiver that address is the guardian's**, because it is
   honestly what was typed on the form and it is the only address anybody gave.
   A blank would be worse for whoever reads the record in a year, and the
   child's reserved one would be worse still: it means nothing to a human and
   nothing may be sent to it. There is no self-serve email change; a future manager action
   changes it in the one place it lives.

   A member can keep some of that record current themselves on `/account`: what
   they go by, their kit sizes, and their contact and emergency-contact details.
   That never rewrites a waiver, which keeps what was typed at the time. It does
   mean approval and self-service can both write the contact fields, and
   approval wins whenever it runs, so a manager working through a backlog of
   older waivers can undo a correction a member made since.

9. **No self-serve sign-up, and not everyone gets a login at all.** Logins are
   created locked by waiver submission and unlocked by approval. The auth page
   only signs people in (password or magic link, with `shouldCreateUser: false`;
   a locked login cannot sign in).

   Two consequences of rule 1 sit here. A **parent** who signs for their child
   and never trains themselves still gets a login, because approving the
   child's waiver unlocks theirs (rule 6): an account can exist with no waiver
   of its own. A **dependant** never gets one, at any age. Their login record
   is created permanently banned and stays that way, so the auth page answers
   for their reserved address exactly as it does for an unknown one.

   That first case reaches the screen. `/account` shows exactly four cards only
   to somebody who has records of their own -- kit sizing, photos and video,
   waivers and the code of conduct -- so a parent-only account keeps everything
   that is still about them (the people on the account, the knowledge base,
   their membership, their own details and contact details, their calendar link
   and their password) and is asked nothing about sizing a gi they will never
   wear. It takes BOTH halves to shrink the page: having somebody else on the
   account AND no waiver of one's own. Somebody with no dependants is an
   ordinary member about to sign their first waiver and needs every card, and a
   household that fails to load leaves the page showing everything, because a
   dropped connection must not hide a member's own records from them.

   The page waits for that answer before drawing any of the four. Keyed on the
   answer alone they would paint while the read was in flight and vanish when
   it landed, which is a page changing its mind about who somebody is.

## Flows

### Lead registers for the free trial

The "Start your free trial" page (`/register-interest`) is step 1: name, email
(**required**), optional phone and a note. The registration is stored as a
lead row (`interest_registrations`) and nothing else happens — a lead is not a
person yet. They then continue to the waiver (step 2) with name/email/phone
carried over. Leads appear in the manager directory (merged in by email) until
they sign the waiver.

### Applicant signs the waiver

Public page (`/waiver`), optionally prefilled from the free-trial flow. The
form is the club's **application form**: participant type (taken from the date
of birth, not asked twice), applicant details, one emergency contact with their
**relationship**, the five health questions answered yes or no, and the
signature.
Anything answered yes has to be explained in the medical details box.

**The first question is who the waiver is for**, before any field, because the
answer changes what the rest of the form asks for. _Myself_, or _my child, or
someone else I look after_. A signed-in parent who already has children on their
account picks one of them by name, or _someone new_; picking a name fills in
their name and date of birth, which is what makes a second waiver for the same
child land on the record they already have instead of creating a second one with
a second free trial. Nobody is asked to log in first: a parent with no account
yet signs for their first child exactly as an adult signs for themselves, and
approving that waiver is what gives them a login (rule 6).

An **email is required either way, but from a different person**. Signing for
yourself it is yours, as it always was. Signing for someone on your account the
participant is not asked for one at all, because a nine-year-old does not have a
mailbox, and the parent or guardian's address below is required instead. That
address is what the club writes to, what `waivers.email` stores, and the login
an approval unlocks. A signed-in person's own address fills whichever of the two
fields applies and is locked, and the server refuses a submission that does not
match it.

The server decides which existing person a child's waiver belongs to by matching
**first name, last name and date of birth within that one household**. Nothing
the form sends identifies the child, which is deliberate: an id on the payload
would be something to guess at. Two children with the same name and the same
birthday on one account would be treated as one person, which is not a case
worth building for and which a manager can untangle afterwards.

For a participant under 18, **or anyone on somebody else's account whatever
their age**, the form adds a **parent or legal guardian** block:
the person who consents, signs and carries the liability. They are asked for by
name and relationship, plus their own **address, mobile and email** — each of
those three optional, meaning "the same as the participant's", so a family at
one address types nothing. What is stored is the resolved value, never the
blank, so nobody reading the record a year later has to work out what an empty
field meant (`resolveWaiverContacts` in `src/lib/waiver-contacts.ts` is the one
place that resolves it, shared by the live preview, the "you still have to fill
this in" checklist and the server).

The guardian and the emergency contact are **two people who may be the same
person, not one person by definition**. A tick above the emergency contact
("the parent or guardian above is who we should call in an emergency") is on by
default and hides those three fields, so the common case is asked for once,
exactly as it was before the split; unticking it asks for the other person.
The guardian signs at the end. On submit the signer immediately gets the signed PDF and a copy
by email; managers are notified. Behind the scenes, for a new email: a locked
login record is created (their email, no way to sign in) and their profile is
seeded with name + phone. An existing person is left untouched. Either way the
waiver row stores the full submission, and the person is now an applicant.

**For a child's waiver that happens twice over.** The address resolves to the
guardian, creating their locked person record if this is their first child, and
seeding it from the guardian block rather than the child's name. The participant
is then matched or created inside that household, with a reserved address and a
permanent ban. The confirmation email goes to the guardian and greets them, and
names the child to the managers as the person who signed up.

One thing a child's waiver does **not** get is the code-of-conduct link on the
success screen and in the confirmation email. That link carries a token, and a
token identifies its holder by proving an address, so one minted for a child
could never be opened by the parent it was posted to. A parent signs the code of
conduct for their child from the member area instead, where there is a live
session. Nothing is lost by waiting: the code of conduct gates nothing.

### When something is missing

Pressing "Sign and download waiver" with anything outstanding always does the
same two things, whatever was left out:

- **A summary appears at the top of the form**, naming every outstanding field
  at once and counting them ("3 things are missing before you can sign"). Each
  line is a link to the field it is about. It stays on screen and re-counts
  itself as they work down the list, so a field drops off the moment it is
  filled in rather than waiting for another press.
- **The page goes to the first one**, in the form's own reading order, top to
  bottom, and focuses it. That field, and every other one on the list, is
  outlined and carries a line saying what it needs, because the jump can leave
  the summary off screen.

Nothing is marked before the first press: a half-filled form is somebody
part-way through, not a form full of errors.

The rule is one list, in `src/lib/waiver-required-fields.ts`, computed from the
form's state. The form is `noValidate`, deliberately: the browser's own
`required` handling would stop at its first blank text input with a bubble that
fades, and would say nothing at all about the health answers, the
acknowledgement ticks or the signature, which is how the page used to answer in
two different voices depending on what you had missed. Email format is checked
there too, since dropping native validation makes that ours to report.

It is a courtesy, not the gate: `waiverSubmitSchema` on the server still decides
whether a waiver may be filed. This is what lets the signer hear it in their own
words before a round trip, instead of as a Zod issue dump.

### Signing on a bad connection

The waiver is the one form where "it silently did not go through" is expensive:
twenty fields, five health answers and a hand-drawn signature, filled in on a
phone, often at the gym. The page is built so that ends in a definite answer.

- **It retries.** Up to five attempts, each with a 45s timeout (the handler
  creates an auth user, renders a PDF, uploads it and sends emails, so it is
  genuinely slow), spaced by a backoff of 1s, 2s, 5s and 10s. A worst case where
  every attempt times out therefore runs about four minutes before giving up.
  Being offline does not spend an attempt: it waits for the connection and sends
  itself when it returns, up to a minute, after which it tries anyway rather
  than sitting there.
- **It asks instead of guessing.** Aborting a request client-side does not stop
  the server, so a timeout never means "it did not happen". After any dropped
  attempt the page calls `checkWaiverSubmission` with its submission id. If the
  waiver landed, the signer goes straight to the confirmation, even though the
  original reply was lost.
- **Retrying is safe** because every attempt carries the same
  `client_submission_id`, which the server looks up before doing any work. One
  signed waiver, one set of emails, however many times it is sent.
- **Saved and "copy ready" are separate facts.** `submitWaiverWithPdf` returns
  `{ ok, waiver_id, pdf_url, pdf_ready }`. Nothing after the waiver row is
  inserted throws: a pdf-lib or storage failure comes back as `pdf_ready: false`
  and the signer is told their waiver is signed and the copy will be emailed.
  Reporting that as a failure is what used to make people sign a second time.
- **Nothing typed is lost.** The half-filled form, signature included, is kept in
  `sessionStorage` (`lib/waiver-draft.ts`) and put back after a reload or a
  crashed tab. It carries the submission id, so a reload mid-submit checks
  whether that one landed rather than sending another. It is cleared on success,
  and it is session-scoped so health answers and a signature do not linger on a
  shared machine.
- **A hard failure stays on screen**, as a panel with "Try again" rather than a
  toast that fades, and it points out they can also sign at the gym.

### Someone fills the form on paper

Not everyone signs on a screen. A person can fill the form on paper at the door,
and a manager files the scan from `/manager/waivers` ("Upload a paper waiver").
Managers only: nobody else can create a waiver on another person's behalf.

The same filing runs through the manager agent API too (`file_waiver`,
docs/manager-agent-api.md), so a manager's own AI agent can file one from a script — the case
this is for is migrating a backlog of paper records the club already holds, not
a member filing their own. It is the identical function behind both entry
points, so an agent-filed waiver and one uploaded through the form are the same
in every respect below, including landing pending and never being approved,
emailed, or verified automatically.

The scan **is** the signed document. Signatures, ticked acknowledgements and the
five yes/no health answers stay on it and are never retyped, exactly as they
live only inside the PDF of an online submission (rule 3). What the manager does
type is what the club needs as data rather than as evidence: the person fields
(which approval promotes onto the profile), anything an instructor needs to hand
(the medical details box), media consent, the date written on the paper, and
which version of the form it is when they can tell.

Media consent is the one tick a filing manager reads off the paper, because it
is a column on both sides (rule 3). It is three-state and defaults to **the form
did not ask**, which is what most paper on file will be: a manager must never be
made to choose a yes or a no on behalf of somebody who was never asked, and a
`false` recorded that way would read as a refusal the club never received.

Attach a PDF, or a photo of each page, or any mix of the two: several files are
joined into one document in the order shown, so the waiver has the single PDF
every screen already expects. Up to 10 MB in total.

A paper form **can** be filed for a child, by answering the same "who is this
for" question the online form asks. The manager names the parent or guardian and
gives their address, and the record that comes out is identical to one signed
online: the child gets their own person record, the waiver is filed under the
guardian's address, and approving it unlocks the guardian's login.

⚠️ **Today that is reachable only through the manager agent API**
(`docs/manager-agent-api.md`, `file_waiver`), not from "Upload a paper waiver"
on the site. The filing function and its validation take the question; the
screen does not ask it yet, so a form uploaded there is still filed as being
for the person whose email was typed. **The consequence is the bug this whole
change exists to fix, still live on that one screen**: two siblings uploaded
under one parent's address land on the same person, and approving the second
overwrites the first. #107 adds the question to the screen. Until then, a
child's paper waiver goes through the agent API, or the parent signs it on the
site.

From there it is an ordinary submission. It attaches to the email's existing
person, or creates a locked applicant if that email is new, and it lands
**pending** like any other. Approving it does the same three things as always
(rule 6), which is why filing is not approving: a scan reaching the club is not
the same event as a manager deciding it is good.

Two things it deliberately does not do:

- **It emails nobody.** Nobody just pressed submit, so there is no signer waiting
  for their copy and no manager to notify about their own filing.
- **It never verifies the email.** Verified means someone opened a link the club
  sent to that address. A manager holding a piece of paper is not that, however
  legible the handwriting.

One thing to know when filing a backlog: the date on the paper is the club's
record of when they signed and what the lists order by, but it does **not**
decide which waiver is active. That is still the most recently **approved** one
(rule 5), so approving an old paper form today makes it that person's active
waiver even if they signed a newer one online. The upload form says so.

**Filing the same paper twice stops for a look.** Signing is unlimited, but if
the person already has a waiver signed on that date, filing another one pauses
and shows what it collided with. "The person" means the **participant**, so two
children in one family filed for the same day never collide with each other, and
two scans of one child's form still do. That is the realistic accident here: an upload
a manager could not tell had gone through, or an import batch that ran twice.
Every extra copy is another pending waiver somebody could approve, and since the
active one is the last **approved**, which copy got approved is what the club's
insurance record ends up saying. It is a pause, not a block. A corrected re-scan
of one signing date is a real second document, so "File it anyway" is right
there (the agent API's equivalent is `confirm_duplicate`). What it is not for is
pushing a retried batch through: work out how much of it already landed instead.

Because the record is otherwise identical to an online one, it says how it
arrived: a **Paper** badge on the waivers list and on the person's page, and a
**Filing record** (who filed it, when, from which files) where an online waiver
shows its signing IP and browser context. There is no signing IP on a paper
waiver, and the panel says so by leaving it out rather than showing it empty.

### Applicant is offered the code of conduct

The waiver is the document that has to be signed before training. The club's
house rules are a second document, and they are **not** a gate: the success
screen offers them straight after the waiver, and the confirmation email carries
the same link so it can be done later. The link holds a token, because an
applicant cannot sign in yet. Full spec: `docs/code-of-conduct.md`.

### Mistake or changed details

Submit again with the same email. Always accepted, whatever phase that email's
person is in: a resubmission attaches to the existing person and never
modifies them. Managers decide which submission to approve. (A deliberate
resubmission is a fresh form fill with a fresh submission id, so it is a new
waiver; only a **retry of the same fill** is deduplicated.)

### Email verification

The email **is** the person here, and it is typed by hand into a public form, so
a typo produces a person record attached to a mailbox nobody reads. Verification
makes that visible.

**Verified means: someone opened a link the club sent to that address.** Proof of
mailbox control, nothing more. It is stored once, on
`auth.users.email_confirmed_at`, and can never be asserted by hand — there is no
"mark as verified" anywhere in the product, because a badge a manager could set
would only mean "a manager believed this".

It gates **nothing**. An unverified person can sign, be approved, be assigned a
membership, and train. The badge exists so a manager can see the risk at the
moment it matters (approval emails their account details to that address, and
it is the address they sign in with), not to put a
wall at the door.

How people get verified, in descending order of how many it catches:

- **Signing in with a login link.** Supabase stamps the confirmation natively, so
  nearly everyone who becomes an active member is verified without anyone doing
  anything. Same for password resets. The activation email no longer carries a
  link, so this now happens on the link they request themselves at `/auth`,
  one step later and just as reliably.
- **The waiver link in their interest confirmation email.** That link carries an
  unguessable token (`?vt=`); the name/email params alone prove nothing, since
  the in-app success screen builds the same URL. Opening it verifies them, and
  because a lead has no person record yet, the proof is held on the token and
  applied at submission — so they are **created already verified**.
- **The "confirm your email address" button** in the waiver confirmation email,
  shown only to a signer whose address is still unproven. The only place the
  product asks a member to verify anything.
- **A resend**, from the manager's person page or the member's own account page.

Where it shows: a green/amber pill beside the email on `/manager/users` and on
the person detail page (with the date), and on the member's account page.

**Changing an address always drops it back to unverified** — see below.

### Email edge cases

- **An account that already works has to sign in before adding somebody to
  it.** Signing stays public and unlimited for everyone else, including a
  parent with no account signing for their first child, and one whose own
  waiver is still pending. But filing for a dependant writes a new person into
  a household, before any approval and with no screen that removes one, so an
  address that can already sign in is asked to. The refusal names the address
  and says to sign in first. Known cost: it is the one answer on the site that
  distinguishes an address with an account from an unknown one, which the auth
  page below deliberately does not, and it does so silently (nothing is filed
  and no manager sees it). It sits behind a complete valid waiver rather than a
  cheap probe, and the alternative is letting a stranger put people on a
  member's account.
- **Signed-in people sign on their own account.** The form locks the email
  field to their login email, and the server rejects a submission whose email
  does not match it (prevents a typo or someone else's address attaching the
  waiver to the wrong person, or creating a duplicate person). Which field is
  locked follows the first question: their own address signing for themselves,
  and the **parent or guardian's** address signing for someone on their
  account. Either way the address on the waiver has to be the account holder's,
  and the participant is either them or one of their dependants. To sign for
  somebody who is not on your account, log out first.
- **An unregistrable email** (rejected by the auth system) fails with a clear
  "check it for typos" message, never a raw database error.
- **Signing in with an applicant's email** does nothing special: the auth page
  responds identically for unknown, locked, and active emails, so nothing is
  leaked about who exists.
- **A manager can correct an address** from the person's detail page. It is the
  only email-editing path in the product (there is still no self-serve version:
  the address is the identity, so moving it moves the login too). Changing it
  always drops the person to unverified, revokes every live link sent to the old
  address, and sends a fresh confirmation to the new one. Refused if the new
  address already belongs to another person — merging two people is a separate
  problem. Re-saving the same address is a no-op, so nobody loses a badge to a
  stray click.
- **Signed waivers keep the address as submitted.** They are frozen evidence of
  what was signed, so after a correction the person's live email and their
  waiver's email legitimately differ. The detail page says so rather than
  looking broken. A **dependant's** waiver differs the same way permanently and
  for a different reason: it holds the guardian's address, which is what was
  typed, while the person's own login carries the reserved one.

### Manager reviews and approves

Both steps of signing up now reach the manager on `/notifications`: a read-only
item for the registration, and one carrying **Approve** for every waiver still
`pending`. Neither replaces the emails that already go out at the moment each
step happens. See `docs/notifications.md` for the two items and how each clears.

The manager waivers screen lists submissions newest first with the submitted
name/email, date, template version, status badge (pending / active /
superseded), the PDF, and Approve / Revoke approval. Approve = promote + unlock +
assign the trial (see rule 6). The applicant becomes a visitor.

Approve asks first, in the app's own dialog (`useConfirm`), naming the three
things a first approval does that nothing here can take back: the email, the
login, the trial. The wording is `approvalConfirmation` in
`src/lib/waiver-approval.ts`, so both approval screens ask in the same words.
Revoking is not gated: it flips the row back to pending and re-approving
restores it, which is why the button no longer says "Unapprove". It never
undid the email, the login or the trial, and the old label promised it did.

For one person there is a user page (`/manager/users/:userId`, reached from the
directory), which is where a review normally happens: the profile (the club's
current record), their memberships, and every submission they ever made, newest
first. Each submission is a collapsible panel holding the frozen submission in
full, the signing record (IP + browser context), when it was approved and by
whom, Approve / Revoke approval, and the signed PDF embedded inline. The approver is
shown by name, or by their login address if they have no profile of their own;
an approval recorded before the club started keeping that (or one whose
approver's account is gone) reads as unknown rather than as nobody. The submissions themselves load with the page; the
PDFs do not, since each needs a short-lived signed URL, so one is signed when a
panel is opened or its PDF button is used, and re-signed once it goes stale.
Exactly one panel opens by itself: the newest
submission, and only while it is still pending, because that is the one waiting
on a decision. Older submissions and approved ones (active or superseded) start
collapsed; a manager can open any of them by hand.

### Media consent

The person page carries a **Media consent** card between the profile and the
code of conduct: a green Yes, a red No, or an amber **Not asked**, with a line
saying what that means for using a photo. It answers the question an instructor
with a camera actually has, without opening a single PDF. The card is
**read-only** there: a manager can see the club's current answer and where it
came from, but cannot set or change it from this page.

Not asked is its own state, not a quiet no. Everyone who signed before the media
question existed is in it, and folding them into "No" would both invent a
refusal and hide the fact that they still need asking.

**The member owns this one.** A photo consent only somebody else could withdraw
would be the wrong way round, so `/account` carries a **Photos and video** card
of its own, and changing it there takes effect the moment they save. The only
other way it moves is automatic: approving a waiver that asks about photos
copies over what was ticked on it (subject to a chronology guard — an older
submission approved out of order can never overwrite a withdrawal the member
made more recently on `/account`; see `docs/database.md`). If someone tells an
instructor in the hall that they want their photo taken down, the answer is to
point them at `/account`, not to change it on their behalf: nothing on the
person page writes it, which is different from kit sizes, the one field a
manager still corrects there directly. The rest of that card grid is read-only
for the same underlying reason: it arrives solely by approving a waiver, on the
same principle as the code of conduct below it, a detail a manager retyped
would only be the club's word for what somebody else wrote.

Nobody, member or manager, can put a record back to **not asked** once it has
an answer. That state exists only for someone the club genuinely has never
asked, whether because they signed before the question existed or have never
touched the `/account` card.

That makes provenance part of the answer, and the card states it: a value from
an approved waiver says so, one the member set on their own account says so,
and one a manager recorded before this page stopped allowing that says who and
when. Three different facts wear the same "No" — one ticked on a signed
document, one the member chose later, one a manager recorded on their behalf,
historically — and the page never blurs them. Approving a newer waiver that
asks about photos replaces whatever is set here with what was ticked on it, and
clears any existing attribution with it. Approving one that never asked changes
nothing — a consent already on file is not erased by an older form.

### Manager changes the waiver text

`/manager/waiver-template` is the club's waiver document, versioned. The screen
lists every version newest first, marks the one that is **live** (the single
`waiver_templates.is_current = true` row, the only thing `/waiver` serves), and
opens on it. Each other version is marked **Previous** (older than the live one,
so possibly signed against) or **Draft** (never been live). Selecting one loads
it into the editor to read or work from; an unsaved edit is confirmed before it
is discarded.

There are two ways a version becomes live:

- **Save as new version** — writes the edited text as version N+1 and makes it
  live. This is the everyday path.
- **Make version N live** — promotes a version that already exists. This is the
  path for a template that arrived any other way: a migration that seeded a
  draft, or an older version the club wants back. Without it a seeded draft is
  unreachable, which is exactly what happened to the application form. It
  publishes the **stored** text, so unsaved edits in the editor are not part of
  what goes live and the screen says so before it proceeds.

**A manager's agent can do all of this too.** `list_waiver_templates`,
`get_waiver_template`, `save_waiver_template` and `publish_waiver_template` on
the manager agent API (`docs/manager-agent-api.md`) are the same two paths
through the same functions, keyed on the version number instead of the row id.
Saving publishes there as well, because it does here — the API cannot offer a
draft state the screen does not have. The one thing an agent gets that the
screen does not need is the carry-over: an omitted field keeps what the version
it started from says, so an acknowledgement can be reworded without a caller
resending the whole legal text from memory.

Promoting never touches waivers already signed. Each one records the
`template_version` it was signed against and its PDF carries that version's full
text, so the evidence is fixed at signing time and does not depend on this table.

**Someone mid-signature is protected too.** The signing page keeps the version it
loaded for the life of the tab, so a promotion during that time would otherwise
file their signature against text they never saw — and where the new version
asks for fewer acknowledgements, silently. The form submits the version it
showed, and the server refuses a mismatch, asking them to reload and read the
current version before signing.

Old versions are normally kept, but they are not sacred: the signed PDF is the
record (rule 3). The narrow exception is a waiver whose PDF failed to generate,
which has only its `template_version` to go on. The short pre-application-form
waiver (version 1) was deleted outright on 2026-07-29, before launch, when no
signature yet mattered; the migration that did it refuses to run if any waiver
without a PDF still points at the version being removed.

One consequence worth knowing: after that deletion there is a single version, so
"an older version the club wants back" has nothing to act on until a second one
exists. The button stays because the next seeded draft needs it.

### Visitor or member uses the member area

Login exists only via approval (account-activated email, then a magic link they
request at `/auth`, or a password they set). They see: the waiver form prefilled from their profile, their
waiver history with the active one marked and PDFs downloadable, and
memberships (buying a paid plan makes a visitor a member).

**A guardian sees the same for each person on their account**, from
`/account/<id>`: that child's waiver history, their PDFs, their details and
their code of conduct. `getWaiverPdfUrl` allows three readers, and asks in this
order: the waiver's owner, a manager, then the owner's guardian through
`mayActFor`. All three refusals say "Waiver PDF not found.", the same sentence
it gives for a waiver that does not exist, because it takes a bare uuid from
anybody signed in and two different answers would let somebody enumerate real
waiver ids.

The `storage.objects` policies say the same thing (`docs/database.md`), but they
are not what enforces it: the signed URL is minted with the service role, which
bypasses storage RLS. They are the versioned statement of the access model for
the direct-from-client path, kept in step so the next person to add one inherits
the right answer.

Every emailed auth link and code lasts as long as Supabase Auth's "Email OTP
Expiration" setting, currently its 3600 second default. The emails say so, from
the single `AUTH_LINK_VALIDITY_MINUTES` constant in
`src/lib/email-templates/link-validity.ts`. That setting lives in the dashboard,
not in this repo, so changing it means changing the constant in the same breath.

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
