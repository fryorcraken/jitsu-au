# The knowledge base

Versioned markdown pages the club publishes to its members, which members can
read and annotate, grouped into ordered sections and served at `/kb/<slug>` with
an index at `/kb`.

The schema reference is `docs/database.md` ("Knowledge base"); this document is
the product spec.

## What problem this solves

Two of them, in order.

The club kept its documents twice: markdown in git, and a hand-maintained Google
Doc mirror that existed only so people could leave comments. The two drifted, and
commenting meant a second Google account that had nothing to do with the club
login. That is what the underlying versioned-pages-plus-annotations feature
replaced.

But it shipped as a flat alphabetical list nothing on the site linked to, which
made it useless at the thing it should be best at: **handing a new member a path
through everything they need to know, in the order they need it.** "Your first
session" sat below "The full syllabus" for no reason a reader would recognise,
and once you were inside a page there was no way to reach the next one. Sections,
an explicit order, and a shell of its own are what fixed that.

## It is its own section of the site

Everything under `/kb` renders inside `KbLayout`, not `SiteLayout`. The ten-item
marketing nav and the marketing footer are gone while you are in there; the top
bar carries the logo, the words "Knowledge base", search, your account, and one
link back to the club site.

That is a deliberate trade, not an oversight. Reading the syllabus is not the
moment to be sold a trial class, and a sidebar bolted underneath a full site
header reads as a page with navigation attached rather than a place you are in.
Getting to Pricing costs one extra click.

## The reading order is the product

A manager files each article into a **section** and gives it a **position**;
sections have positions of their own. That single ordering drives three things at
once, so there is one thing to maintain rather than three:

- the sidebar,
- the `/kb` index page, and its "start here" pointer at the first entry,
- the previous/next links at the foot of every article.

Prev/next walks the **whole** order, across section boundaries. Reaching the end
of "Start here" hands the reader the first article of the next section rather
than a dead end, which is what makes it an onboarding path instead of a
within-section shuffle.

Positions are seeded in tens (10, 20, 30) so a manager can slot something between
two others without renumbering everything.

An article in no section is **not hidden**. It lands in an "Everything else"
group at the bottom. An article a manager forgot to file is still one a member
can find, and "it vanished from the sidebar" is a much worse failure than "it is
in the wrong place". Same reason an article naming a section that no longer
exists lands there rather than disappearing.

A section with nothing in it is not shown at all: a heading with no articles
under it is noise to a member and tells them nothing.

## Link entries: pointing at the rest of the site

Some of what a new member needs is already answered on the public site, written
for somebody deciding whether to come. `/first-class` and `/faq` are the two.

Re-telling either inside the knowledge base would leave the club with two
versions to keep in step, so instead a sidebar entry can be a **link**: it has a
label, a position, and a `link_path`, and clicking it leaves for that page. It
takes part in the reading order like anything else, so Next hands a reader to
`/first-class` in the place the manager put it.

Three consequences worth knowing:

- A link entry has **no text stored here**, so it has no versions and takes no
  comments. There is nothing on this site to anchor a comment to.
- It needs a `nav_title`, since there is no article title to fall back on.
- `link_path` accepts **site-relative paths only**. That is a security boundary,
  not tidiness: an absolute URL would let a caller put any destination into the
  club's own navigation, and `//host` would make `/kb/<slug>` an open redirect.

`/kb/<slug>` for a link entry bounces to the destination. The sidebar already
points straight at it, so that path only fires for a URL somebody saved before
the entry became a link.

## Reading an article

- **Breadcrumbs** above the title: Knowledge base › Start here › Your first belt.
- **"On this page"**, a collapsible list of the article's own headings, shown
  once an article has three or more. It exists for the syllabus, which is the
  one page long enough that scrolling to find a belt is real work. Heading ids
  come from `extractHeadings`, and the reader hangs the same id on the block that
  opens the heading, so the anchor and the link cannot disagree.
- **Search** in the top bar, over titles and article text, showing the line that
  matched. Visibility is applied to the article list before any body is
  searched, so a managers-only draft cannot surface a snippet of itself to a
  member through a lucky search term.
- The comment rail sits on the right from `xl` and drops under the article below
  that, because the sidebar already owns the left from `lg` and three columns on
  a 1024px laptop leaves a reading column too narrow for a syllabus.

## Who sees what

Each article carries a `visibility`:

| Visibility | Who can read it                     | Typical use            |
| ---------- | ----------------------------------- | ---------------------- |
| `public`   | anyone, signed in or not            | a published policy     |
| `members`  | any signed-in person the club knows | handbooks, house rules |
| `managers` | managers only                       | drafts, internal notes |

`members` is the default for a new article, on purpose: the safe failure for a
mis-set visibility is "a member had to sign in", not "a draft policy was public".

**Annotating always requires a login**, even on a public article, because every
annotation belongs to a person. A signed-out reader sees the article and a
prompt to sign in.

## Ways in

The knowledge base is reachable from the site header, the footer's Explore
column, the member area sidebar (its first item), a card at the top of
`/account`, and the waiver-confirmation email, which points a brand-new person at
it while they wait for approval. Managers reach the editor from their own sidebar
("Knowledge base editor"), which is a different entry from the reader above it.

That list exists because the feature previously had **none** of them: nothing on
the site linked to `/docs` at all, so the only ways in were typing the URL or a
manager pasting a link.

## Private notes and shared threads

A reader picks which they are writing **before** they write it, and the composer's
placeholder changes with the choice, so nobody types a private thought into a
public box.

- A **private note** is readable only by its author. Not by other members, and
  **not by managers** — that is what makes it usable for "things I want to
  remember about this policy". Neither the manager screen nor the agent API can
  read private notes.
- A **shared comment** starts a thread everyone who can read the article sees.
  Replies are one level deep: you reply to a comment, not to a reply. A reply is
  always shared, and a request to post a private one is refused rather than
  quietly published: a private note is not a conversation.

Either can hang off a **passage** (pick a paragraph) or off the **article** as a
whole.

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

## Versioning, and what happens to comments when an article changes

Every save that carries text writes a **new version** and publishes it. Nothing
is edited in place, and old versions are kept. This is the `waiver_templates`
model, for the same reason: an annotation records which version it was written
against, and rewriting a version underneath it would make that reference a lie.

A save that carries **no** text (moving an article between sections, renaming its
sidebar label) writes no version at all. Otherwise every reordering would tell
every reader the article had been updated.

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
`change_note`, which is shown alongside the article's last-updated date.

Commenting on an older version is allowed: unlike the waiver, which **refuses** a
signature against stale text because a signature is evidence of what was read, a
comment on older wording is a perfectly good comment.

**Readers always get the live version.** There is no way for a member to open an
older one, and that is deliberate rather than a missing feature: visibility is a
property of the article, not of each version, so serving an older version to
whoever the _current_ visibility admits would publish the drafting history of
every article that was once managers-only. A manager drafting a policy at
`managers` visibility and then publishing it to members would, without this,
hand every member every draft they went through. Only a **manager** can read a
specific version, on the manager screen or through the agent API.

## How managers edit the knowledge base

Two ways in, both doing the same thing to the same data.

### On the site: `/manager/kb`

The same shape as the waiver template editor, so there is one editor to learn
and not two: articles down the side, the markdown body in the middle, a live
preview underneath, and "Save as new version" publishing what you wrote.

What is here that the waiver template does not have:

- **Several articles.** Pick one from the list, or start a new one. A new
  article needs a URL key (`our-history`), proposed from the title.
- **Who can read it**, and whether it accepts comments.
- **Versions.** Every save adds one. Older versions can be **read** before you
  decide, and **restored**, which is how an edit is undone without retyping it.
  Restoring publishes the stored version, not what is in the editor, and the
  screen says so before it does.
- **Feedback.** Open shared threads members left, quoted passage and all.
  Private notes are never listed here. Replying happens on the article itself.

Widening who can read an article (managers → members, members → public) asks
first. Narrowing does not: it takes an article away from people, which is
recoverable.

The same distinction decides the ORDER a save writes in, which matters when half
of it fails. Widening writes the new text first and the wider audience second, so
a failure leaves the text live under the old, narrower audience. Narrowing writes
the narrower audience first, so a failure leaves the old text under it rather
than publishing the new text to the audience it was being taken away from. Either
way the failure direction is "fewer people can read it".

> [!NOTE]
> **Sections, order and link entries are agent-only for now.** The screen edits
> an article's text and who can read it; it does not yet set `section`,
> `position`, `nav_title` or `link_path`, so the reading order a member walks is
> still shaped through the agent API. That is a gap, not a decision.

### From an agent: `/api/manager/agent`

Driven by the `uts-manager-agent` skill, for the case the editor is bad at: an
agent applying a marked-up draft rather than a person typing markdown into a
textarea, and everything to do with the reading order.

Six actions: `list_kb_sections`, `save_kb_section`, `list_kb_articles`,
`get_kb_article`, `save_kb_article`, `list_kb_comments`. The manifest at
`GET /api/manager/agent` is the runtime source of truth for their parameters.

Four things that bite:

- **`save_kb_article` replaces the whole body.** It is not a patch. Read the
  current version with `get_kb_article` and edit what comes back, or everything
  not included is dropped from the new version.
- **An unknown slug creates a new article** at a new URL, so a typo makes a
  second one. `list_kb_articles` first if unsure, and pass `expect_new: true`
  when creating: the save is then refused if the slug is taken, rather than
  adding a version to an existing article and patching its visibility to yours.
- **Omitting a field leaves it alone.** That is what stops an agent editing the
  text of a managers-only draft from publishing it to the world, or moving it to
  the top of the sidebar, by not mentioning a field.
- **An unknown `section` is refused**, unlike everything else. Accepting it would
  drop the article into "Everything else", and a typo there is invisible until
  somebody notices an article has gone missing from its group. Send an empty
  string to unfile one on purpose.

## The starting structure

The migration seeds three sections and the two link entries, so the knowledge
base is navigable the moment it ships rather than being an empty shell:

| Section           | Entries                                                             |
| ----------------- | ------------------------------------------------------------------- |
| Start here        | Your first session (→ `/first-class`) · Common questions (→ `/faq`) |
| Belts and grading | empty until written                                                 |
| About the club    | empty until written                                                 |

Every row is ordinary data a manager can rename, reorder or delete through the
agent API; nothing in the code depends on those slugs existing. The articles
themselves (your first belt, how to train off the mat, our belt system, the full
syllabus, our history, how to contribute) are content, written through the skill.

## SEO

`/kb` and `/kb/<slug>` are `noindex`. Most of what they serve is members-only, so
they are not marketing pages, and an index would advertise the slug of every
managers-only draft to a crawler that cannot read any of them.

Making a genuinely public article indexable is a deliberate change: drop the
`noindex`, give the page a real canonical, and add it to `PUBLIC_PAGES` in
`src/lib/seo.ts`. `src/lib/seo.test.ts` enforces that pairing, so a page cannot
be indexable and missing from the sitemap.

## Where the code lives

| Concern                                  | File                                                |
| ---------------------------------------- | --------------------------------------------------- |
| Block splitting, anchoring, permissions  | `src/lib/kb.ts` (pure, tested)                      |
| Sections, reading order, headings        | `src/lib/kb-nav.ts` (pure, tested)                  |
| Editor decisions (dirty, widening, slug) | `src/lib/kb-editor.ts` (pure, tested)               |
| Saving, versioning, promotion, sections  | `src/lib/kb-admin.ts`                               |
| Reader/annotation server functions       | `src/lib/kb.functions.ts`                           |
| Wire schemas                             | `src/lib/validation.ts`                             |
| Article typography                       | `src/lib/kb-markdown.tsx`                           |
| Shell (top bar, sidebar, search)         | `src/components/site/KbLayout.tsx`                  |
| Reader UI                                | `src/components/site/KbArticleReader.tsx`           |
| Reader routes                            | `src/routes/kb/route.tsx`, `index.tsx`, `$slug.tsx` |
| Manager screen                           | `src/routes/_authenticated/manager.kb.tsx`          |
| Manager API actions                      | `src/routes/api/manager/agent.ts`                   |

`src/lib/kb-types.ts` holds **provisional hand-written row types**, which must be
replaced with aliases into the generated `src/integrations/supabase/types.ts`
once `20260802100000_knowledge_base.sql` has been applied and the types
regenerated. That file says so at the top.
