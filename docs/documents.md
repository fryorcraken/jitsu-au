# Club documents

Versioned markdown pages the club publishes to its members, which members can
read and annotate. Served at `/docs/<slug>`, listed at `/docs`.

The schema reference is `docs/database.md` ("Club documents"); this document is
the product spec.

## What problem this solves

The club kept its documents twice: markdown in git, and a hand-maintained Google
Doc mirror that existed only so people could leave comments. The two drifted, and
commenting meant a second Google account that had nothing to do with the club
login.

This replaces the mirror. The document lives in the database, managers edit it
through the manager agent API, and members annotate it on the site under the
login they already have.

## Who sees what

Each document carries a `visibility`:

| Visibility | Who can read it                     | Typical use            |
| ---------- | ----------------------------------- | ---------------------- |
| `public`   | anyone, signed in or not            | a published policy     |
| `members`  | any signed-in person the club knows | handbooks, house rules |
| `managers` | managers only                       | drafts, internal notes |

`members` is the default for a new document, on purpose: the safe failure for a
mis-set visibility is "a member had to sign in", not "a draft policy was public".

**Annotating always requires a login**, even on a public document, because every
annotation belongs to a person. A signed-out reader sees the document and a
prompt to sign in.

## Private notes and shared threads

A reader picks which they are writing **before** they write it, and the composer's
placeholder changes with the choice, so nobody types a private thought into a
public box.

- A **private note** is readable only by its author. Not by other members, and
  **not by managers** — that is what makes it usable for "things I want to
  remember about this policy". The manager agent API cannot read private notes
  either.
- A **shared comment** starts a thread everyone who can read the document sees.
  Replies are one level deep: you reply to a comment, not to a reply. A reply is
  always shared, and a request to post a private one is refused rather than
  quietly published: a private note is not a conversation.

Either can hang off a **passage** (pick a paragraph) or off the **document as a
whole**.

### Who can do what

| Action                    | Author | Manager | Anyone else |
| ------------------------- | ------ | ------- | ----------- |
| Edit an annotation's text | yes    | no      | no          |
| Delete a private note     | yes    | no      | no          |
| Delete a shared comment   | yes    | yes     | no          |
| Resolve/reopen a thread   | yes    | yes     | no          |

A manager can moderate (resolve a thread, delete an abusive comment) but can
never **rewrite** words attributed to somebody else. A comment feature people
cannot trust that way is one they stop using honestly.

Deleting a thread's root deletes its replies with it (`ON DELETE CASCADE`), and
the UI warns before doing so.

## Versioning, and what happens to comments when a document changes

Every save writes a **new version** and publishes it. Nothing is edited in place,
and old versions are kept. This is the `waiver_templates` model, for the same
reason: an annotation records which version it was written against, and rewriting
a version underneath it would make that reference a lie.

Comments are anchored to a **block** (a paragraph, heading, list, or code fence),
by a hash of that block's own **text** rather than its position. The consequences
are what a reader actually notices:

- Inserting or deleting a paragraph elsewhere leaves every other comment exactly
  where it was.
- Re-wrapping a paragraph (same words, different line breaks) keeps its comments.
- **Editing the words of a passage detaches its comments**, which are then shown
  in an "On earlier wording" panel with the old text struck through, rather than
  being deleted or silently re-pointed at a paragraph nobody commented on.

That last one is the deliberate trade. A comment on a clause that was rewritten
is usually the most interesting comment on the page, so it is surfaced, not
swallowed. A manager who wants readers to understand a change writes a
`change_note`, which is shown alongside the document's last-updated date.

Commenting on an older version is allowed: unlike the waiver, which **refuses** a
signature against stale text because a signature is evidence of what was read, a
comment on older wording is a perfectly good comment.

**Readers always get the live version.** There is no way for a member to open an
older one, and that is deliberate rather than a missing feature: visibility is a
property of the document, not of each version, so serving an older version to
whoever the _current_ visibility admits would publish the drafting history of
every document that was once managers-only. A manager drafting a policy at
`managers` visibility and then publishing it to members would, without this,
hand every member every draft they went through. Only the manager agent API can
read a specific version.

## How managers edit documents

Through the **manager agent API** (`/api/manager/agent`), driven by the
`uts-manager-agent` skill. There is no web editor for documents today; the waiver
template has one (`/manager/waiver-template`) and this deliberately does not,
because the editing here is expected to be an agent applying a marked-up draft
rather than a person typing markdown into a textarea.

Four actions: `list_documents`, `get_document`, `save_document`,
`list_document_annotations`. The manifest at `GET /api/manager/agent` is the
runtime source of truth for their parameters.

Three things that bite:

- **`save_document` replaces the whole body.** It is not a patch. Read the
  current version with `get_document` and edit what comes back, or everything not
  included is dropped from the new version.
- **An unknown slug creates a new document** at a new URL, so a typo makes a
  second one. `list_documents` first if unsure.
- **Omitting `visibility` leaves it alone.** That is what stops an agent editing
  the text of a managers-only draft from publishing it to the world by not
  mentioning a field.

## SEO

`/docs` and `/docs/<slug>` are `noindex`. Most of what they serve is
members-only, so they are not marketing pages, and an index would advertise the
slug of every managers-only draft to a crawler that cannot read any of them.

Making a genuinely public document indexable is a deliberate change: drop the
`noindex`, give the page a real canonical, and add it to `PUBLIC_PAGES` in
`src/lib/seo.ts`. `src/lib/seo.test.ts` enforces that pairing, so a page cannot
be indexable and missing from the sitemap.

## Where the code lives

| Concern                                 | File                                          |
| --------------------------------------- | --------------------------------------------- |
| Block splitting, anchoring, permissions | `src/lib/documents.ts` (pure, tested)         |
| Saving, versioning, promotion           | `src/lib/document-admin.ts`                   |
| Reader/annotation server functions      | `src/lib/documents.functions.ts`              |
| Wire schemas                            | `src/lib/validation.ts`                       |
| Reader UI                               | `src/components/site/DocumentReader.tsx`      |
| Routes                                  | `src/routes/docs.index.tsx`, `docs.$slug.tsx` |
| Manager API actions                     | `src/routes/api/manager/agent.ts`             |

`src/lib/document-types.ts` holds **provisional hand-written row types**, which
must be replaced with aliases into the generated
`src/integrations/supabase/types.ts` once `20260731140000_documents.sql` has been
applied and the types regenerated. That file says so at the top.
