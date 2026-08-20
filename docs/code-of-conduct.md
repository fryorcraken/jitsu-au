# The code of conduct

The club's house rules, and how people come to agree to them. `docs/waivers.md`
covers the waiver and the funnel it sits in; `docs/database.md` documents the
table behind this. Keep all three aligned with the code in the same change.

## The model in one paragraph

The waiver is the document you **must** sign before you train. The code of
conduct is the document the club wants signed **around the time you become a
paying member**, and it never stops anybody training. It is one document for
everybody, published on the public site so it can be read (and linked to) before
anyone signs anything. Agreeing to it records a row: the version, the date, the
name typed to sign, and the signer's address and browser context. Nothing is
approved, nothing expires, and nothing is blocked by its absence.

## Rules

1. **It is never a gate.** No screen, server function, or database constraint
   makes anything conditional on having signed it. If that ever changes, it stops
   being this feature.
2. **The document is in the repo, not the database.** `src/lib/code-of-conduct.ts`
   holds the text and `CODE_OF_CONDUCT_VERSION`. A manager cannot edit it from
   the site, on purpose: house rules change by committee decision, and the review
   that a pull request gives is worth more here than the speed a live editor gives
   the waiver.
3. **A bump asks everybody to read it again.** Raise the version when the wording
   materially changes. Anyone whose latest acceptance is older then shows as out
   of date, which is a prompt on their account page and a line on their manager
   page, never a warning and never a block. Do not bump for a typo, and never
   change a version's text without bumping: an acceptance stores a number, and
   that number has to keep meaning the text people actually read.
4. **Nobody types who they are.** The name and email stored on an acceptance are
   read off the person's profile and login by the server. The form collects two
   things: the tick and the typed signature.
5. **Only an existing person can sign.** Unlike the waiver, signing this never
   creates a person record. Somebody the club does not hold has nothing to attach
   an agreement to, and is told to sign the waiver first.
6. **Re-signing is always allowed** and only ever adds a row. The state shown is
   the **highest version** agreed to, not the most recent row, so re-signing an
   older version is not a downgrade.

## Who can sign, and how they are identified

Two ways, and the first wins whenever both are present:

- **A session.** A signed-in member signs for themselves, exactly as on the
  waiver. Someone who opens a friend's link while logged in signs their own
  agreement, not their friend's.
- **The emailed link.** The moment the club most wants this signed is right after
  the waiver, and at that moment the person is an **applicant**: their login is
  banned until a manager approves them, so they cannot sign in at all. The link
  therefore carries an unguessable token (`?t=`), which is how the page knows who
  is signing.

> [!IMPORTANT]
> **This token identifies a signer. It does NOT verify their email**, and it is
> the one token in the product that does not — every other one is proof of the
> mailbox it was sent to.
>
> The reason is the success screen above: `submitWaiverWithPdf` returns this
> token **in its HTTP response** so the button works before any email arrives.
> Waiver signing is public and unauthenticated, so anyone can post any address
> and be handed a live token for it without reading a single email. A value we
> give to whoever asked proves nothing about who reads that inbox.
>
> So the token is scoped: `mailboxProvingPurposes` in `src/lib/email-verification.ts`
> excludes `code_of_conduct`, and the three paths that stamp
> `auth.users.email_confirmed_at` — the public `/api/verify-email/<token>`
> redemption, the waiver's own `?vt=` proof, and this page's acceptance — all ask
> that question first. Signing the code of conduct therefore records the
> agreement and nothing else.
>
> Nothing is lost: the waiver confirmation email carries its own "confirm your
> email address" button, which only ever exists inside that email. See
> `docs/waivers.md` > Email verification.

A visitor with neither can still **read** the whole document. They are shown how
to sign (open the link from the email, or sign in) and nothing about whether any
particular address is on file, so the page cannot be used to probe who the club
holds. An expired token, a link for an address a manager has since corrected, and
a plain visit all look identical.

## Flows

### Straight after signing the waiver

The waiver's success screen offers the code of conduct under the PDF download:
one paragraph saying what it is, that they can train before doing it, and a
button. The button carries the token, so it works even though they cannot log in.

### From the confirmation email

The waiver confirmation email carries the same link, for the very likely case
that they close the tab. If the token could not be minted the email still goes
out, without that button: an unsigned code of conduct blocks nothing, and a link
that lands on a page they cannot sign from would be worse than no link.

### From the member's account page

`/account` shows a Code of conduct card: agreed to version N on a date, agreed to
an older version, or not yet. It links to the document. Signing always happens on
`/code-of-conduct`, because agreeing to a document you cannot see on the same
screen is not agreement.

### What a manager sees

The person page (`/manager/users/:userId`) shows one read-only block: signed (with
version, date and the name signed with), out of date, or not signed. It is
deliberately read-only. A manager cannot tick it on somebody's behalf, for the
same reason there is no "mark as verified" button anywhere: an agreement a
manager recorded would only mean "a manager believed this".

It sits above Memberships because that is when it matters. The club's intent is
that this gets signed as somebody joins as a paying member, so the state is in
front of the manager at exactly the moment they are setting that up.

## The public page

`/code-of-conduct` is indexable and in the sitemap. A club that publishes the
rules it trains by is worth finding, and there is nothing private on the page:
the signing form appears only for someone the site can already identify. It is
also linked from the site footer.

## Out of scope today

- A manager-editable version of the document (see rule 2).
- Any expiry or forced re-signing beyond the version prompt.
- Signing on paper, or a manager recording an agreement on someone's behalf.
- A PDF copy. The text of every version is in git, permanently.
