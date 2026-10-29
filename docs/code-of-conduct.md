# The code of conduct

The club's house rules, and how people come to agree to them. `docs/waivers.md`
covers the waiver and the funnel it sits in; `docs/database.md` documents the
table behind this. Keep all three aligned with the code in the same change.

## The model in one paragraph

The waiver is the document you **must** sign before you train. The code of
conduct is the document the club wants signed **around the time you become a
paying member**, and it never stops anybody training. It is one document for
everybody, published on the public site so it can be read (and linked to) before
anyone signs anything. Managers edit it, in numbered versions with one live.
Agreeing to it records a row: the version, the date, the name typed to sign, and
the signer's address and browser context. Nothing is approved, nothing expires,
and nothing is blocked by its absence.

## Rules

1. **It is never a gate.** No screen, server function, or database constraint
   makes anything conditional on having signed it. If that ever changes, it stops
   being this feature.
2. **Managers edit it, in numbered versions.** The text lives in
   `code_of_conduct_versions`, with exactly one version live, and a manager
   edits it at `/manager/code-of-conduct` or through the manager agent API
   (`docs/manager-agent-api.md`), the same way the waiver template works. Every
   save writes a **new** version and publishes it; no version's text is ever
   changed in place, because an acceptance stores a number and that number has
   to keep meaning the text people actually read. Any earlier version can be
   made live again. (Before this the text lived in the app and was
   changed by pull request; version 1 is that text, byte for byte.)
3. **A version only asks everybody to read it again when the manager says so.**
   Publishing carries a choice, "Ask everyone to agree again", **off by
   default** and stored on the version (`asks_reagreement`). Each version also
   records, when it is written, its **required version**: itself if it asked,
   otherwise whatever the live version required at the time (or, if a failed
   publish left nothing live, the newest version's). Anyone whose
   highest agreement is older than the live version's required version shows as
   out of date, which is a prompt on their account page and a line on their manager
   page, never a warning and never a block. So:
   - a typo fix or a clearer sentence is saved with it off, and nobody is
     re-prompted, although the live version number moves;
   - a change to the rules themselves is saved with it on, and the editor says
     how many people that re-prompts **before** the click, then asks again in a
     confirm;
   - rolling back below a version that asked undoes the ask along with the
     text, and it stays undone: a correction saved after the rollback inherits
     the rolled-back-to version's requirement, not the abandoned one.
4. **Nobody types who they are.** The name and email stored on an acceptance are
   read off the person's profile and login by the server. The form collects one
   thing: the typed signature. There is no tick box: the undertaking ("I have
   read ... and I agree to follow both", or "... and I agree that Bea will
   follow both" for a child) is printed above the signature field, and typing a
   name and submitting is agreeing to it. That wording stays in code
   (`src/lib/code-of-conduct.ts`), not in the editor: it names who is bound,
   which is part of how signing works rather than house rules.
   The page sends the version whose text it showed, and the server refuses it
   once that version is no longer live, so an agreement is never filed against
   words the person did not see.
5. **Only an existing person can sign.** Unlike the waiver, signing this never
   creates a person record. Somebody the club does not hold has nothing to attach
   an agreement to, and is told to sign the waiver first.
6. **Re-signing is always allowed** and only ever adds a row. The state shown is
   the **highest version** agreed to, not the most recent row, so re-signing an
   older version is not a downgrade.
7. **A parent may agree on behalf of a child, and only from a live session.** A
   dependant has no login, ever, so somebody has to. `?for=<user id>` on
   `/code-of-conduct` names them, and `codeOfConductSubject` gates it: reaching
   past yourself needs a session, never an emailed link, because a token proves
   an address and must never prove the right to read or write a household.
   The row is filed under the CHILD (`user_id`), while `full_name`, `email` and
   `signature_name` record the PARENT who actually agreed. That is the honest
   record of an act somebody performed, and the same reading
   `media_consent_updated_by` takes. `signer_meta.on_behalf_of` carries the
   child's id so the two are never ambiguous.

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

The same card appears on `/account/<child id>`, and its button carries
`?for=<child id>` so the agreement is filed against the child rather than
quietly re-recording the parent's own. The page then says "Agreeing on behalf of
Bea Lovelace, signed by you as Ada Lovelace" rather than "Signing as", because
the two are different people and a parent needs to see which child they are
agreeing for.

**This is the only route by which a child's agreement can be taken, and that is
deliberate.** A child's waiver mints no code-of-conduct link: the token
identifies its holder by proving an address, `resolveSigner` re-checks that the
token's person still has that address, and a dependant's is the reserved one, so
a token minted for a child could never be opened by the parent it was posted to.
Minting it against the parent instead would have them agree for themselves while
the child never does. Teaching the token to reach a dependant through their
guardian is the change that was ruled out. Nothing is lost by the wait: the code
of conduct gates nothing.

### What a manager edits

`/manager/code-of-conduct` (Manager navigation, "Code of conduct"). Title and
text, with a preview rendered by the same component the public page uses. The
text is a small markdown subset, stated above the field: `#` and `##` headings,
`- ` bullets, `**bold**`, bare `https://` links, and a blank line between
paragraphs. It keeps its own small renderer (`parseCodeOfConductBlocks`) rather
than the knowledge base's, so version 1 renders exactly as members read it.

Saving writes a new version and makes it live. The "Ask everyone to agree
again" choice sits right above the button and says in words what it will do
("3 people who agreed to an earlier version will be asked to agree again", or
that everybody stays up to date when it is off). The count is for the save as
it stands, box ticked or not: with nothing live, even a correction can
re-prompt people (rule 3), and the screen says so rather than promising
otherwise. Any save that re-prompts somebody goes through a confirm saying the
same; one that re-prompts nobody just happens, because it can be rolled back.
The versions list shows which asked, and any version can be made live again,
with a confirm saying who that re-prompts. A version that has been live is
labelled "Previous" from then on, even when a rollback leaves it newer than the
live one. Unsaved work is kept on the device, and a save is safe to retry: a
retry never makes a version live behind somebody else's back.

### What a manager sees

The person page (`/manager/users/:userId`) shows one read-only block: signed (with
version, date and the name signed with), out of date, or not signed. It is
deliberately read-only. A manager cannot tick it on somebody's behalf, for the
same reason there is no "mark as verified" button anywhere: an agreement a
manager recorded would only mean "a manager believed this".

The manager agent API reports the same block, from the same rule
(`codeOfConductSummary`): on every `list_users` row and in `get_user`, which is
the person page's own read. It is read-only there too.

It sits above Memberships because that is when it matters. The club's intent is
that this gets signed as somebody joins as a paying member, so the state is in
front of the manager at exactly the moment they are setting that up.

## The public page

`/code-of-conduct` is indexable and in the sitemap. It renders the live version,
read during server rendering so the page arrives with the rules in it. If that
read fails, the page says so with a retry in place of the document, and shows no
signing form under a document that is not there. A club that publishes the
rules it trains by is worth finding, and there is nothing private on the page:
the signing form appears only for someone the site can already identify. It is
also linked from the site footer.

## Out of scope today

- Editing the undertaking printed above the signature (see rule 4).
- Emailing anybody when a version asks everyone to agree again. They see the
  prompt the next time they open their account or membership page.
- Any expiry or forced re-signing beyond the re-agreement prompt.
- Signing on paper, or a manager recording an agreement on someone's behalf.
- A PDF copy. Every version's text is kept in `code_of_conduct_versions` and
  never edited in place.
