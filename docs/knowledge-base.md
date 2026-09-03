# The knowledge base

Versioned markdown pages the club publishes to its members, which members can
read and annotate, grouped into ordered sections and served at `/kb/<slug>` with
an index at `/kb`. **You have to be signed in to read any of it**, and you get
there from the member area.

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

## It is behind the sign-in, and part of the member area

This is the club's reading for the people who train here, not marketing. So:

- `/kb` and everything under it **requires a login**. A signed-out visitor is
  sent to `/auth` and back afterwards.
- Nothing in the marketing header or footer links to it. The ways in are the
  member area: the sidebar's first item, and a card at the top of `/account`.
- The sidebar's first entry, above the articles, is **"Back to member space"**,
  and the top bar carries the same link. On a phone the drawer is the only
  navigation on screen, so the way out cannot live only in the top bar. Neither
  of them waits on the article list loading.
- The contents has **three** states, not two. "Loading", "there is nothing in
  the knowledge base yet", and "the contents could not be loaded". The third
  one used to be folded into the second: `useKbNav` reported only
  `query.isLoading`, which is false once a query has rejected, so `/kb` sat on
  "Loading..." for good and the sidebar told a member the club had written
  nothing. It now returns `error` and `refetch`, and both `/kb` and the sidebar
  render a failure panel with a retry in place of the empty state.

The gate is enforced twice on purpose, and the two are not the same thing. The
route redirect is a courtesy for a person; `canReadArticle` (`src/lib/kb.ts`)
refuses a signed-out viewer every article, and that is what a saved URL, a stale
tab or a direct call to the server function hits.

Everything under `/kb` renders inside `KbLayout`, not `SiteLayout`. The ten-item
marketing nav and the marketing footer are gone while you are in there; the top
bar carries the logo, the words "Knowledge base", search, and the way back to
the member area.

That is a deliberate trade, not an oversight. Reading the syllabus is not the
moment to be sold a trial class, and a sidebar bolted underneath a full site
header reads as a page with navigation attached rather than a place you are in.

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
- `link_path` accepts **site-relative paths only**, and never `/kb` itself. That
  is a security boundary, not tidiness: an absolute URL would let a caller put
  any destination into the club's own navigation, `//host` would make
  `/kb/<slug>` an open redirect, and a link entry aimed back into the knowledge
  base is a redirect loop that hangs the tab with no in-app way out.
- Turning a link entry back into an article means sending `link_path: ""`
  **together with** `title` and `body_md`. Clearing it on its own is refused: a
  row with neither a link nor a version is invisible in the sidebar, so the entry
  would vanish until somebody remembered to write it.

`/kb/<slug>` for a link entry bounces to the destination. The sidebar already
points straight at it, so that path only fires for a URL somebody saved before
the entry became a link. The bounce, and the sidebar entry itself, are handled
by the router: `link_path` is site-relative by validation, so leaving for
`/first-class` swaps the shell rather than reloading the application.

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

### Linking to a section, in this article or another one

An article can point at one **section** of another, which is what makes the
knowledge base a handbook rather than a stack of pages: the syllabus can send a
reader to the fees part of the grading article without them having to find it.

- **Every heading has an anchor**, and it is the heading's own words, lowercased
  with anything else turned into hyphens. `## How grading works` answers to
  `#how-grading-works`. Two headings with the same words get `-2`, `-3`.
- **Link to one with an ordinary Markdown link.** `[the fees](/kb/belts#fees)`
  from another article, `[the fees](#fees)` inside the same one. There is no
  special syntax, because there does not need to be.
- **Following one does not reload the page.** A link to a path on this site is
  rendered as a router link, so a cross-reference costs a fetch of the next
  article and nothing else. It used to be a plain anchor, which made every
  cross-reference a full page load: blank screen, the whole bundle again, the
  session resolved again, the sidebar fetched again, to move one page. A `#`
  fragment stays a plain anchor, because it names a heading in the article
  already on screen. Anything that is not a same-site path (including
  `//another-host`, which is not one however much it looks like a path) opens in
  a new tab with `rel="noopener noreferrer"`.
- **Pin an anchor by ending the heading with `{#your-anchor}`**, the attribute
  syntax Pandoc and Docusaurus use: `## How grading works {#grading}` answers to
  `#grading` for as long as that suffix is there, whatever the heading is
  reworded to. Otherwise the anchor is the wording, so rewriting a heading
  quietly breaks every link aimed at it. Pin the ones other articles point at.
  The suffix never reaches the reader; `remark-kb-anchors` takes it off.
- **The reader gets there.** An article's text is fetched after the page loads,
  so by the time the browser looks for the fragment there is nothing in the
  document with that id yet: `/kb/$slug` scrolls to it once the text is on
  screen, and moves focus there too, so a keyboard or a screen reader carries on
  from the section rather than from the top of the page.
- **A link at a section that is gone says so.** Renamed heading, deleted
  passage: the reader is told which fragment could not be found and pointed at
  "On this page" for what the article has now, rather than being dropped
  silently at the top of a syllabus.
- **Every heading offers its own link.** "Link to this section" sits under the
  heading in the reader (always on a touch screen, on hover or focus on a wide
  one) and copies the whole address, so a member can paste one into a message
  and a manager can paste one into another article.

Two things to know before relying on it. Adding `{#anchor}` to a heading
**changes that block's text**, so comments anchored to the heading itself detach
the same way any other edit to a passage detaches them (they are shown under "On
earlier wording", not lost). And nothing validates a cross-reference at save
time: a link to `/kb/no-such-article#x` is an ordinary broken link until
somebody follows it.

**Markdown tables render.** `| Belt | Time |` is a table, in the reader and in
the manager's preview, and a wide one scrolls inside its own box rather than
scrolling the page sideways on a phone. Alignment markers (`| :-: |`) work, and
so does inline markdown inside a cell.

That is this repo's own `remark-kb-tables` plugin rather than `remark-gfm`,
which would have meant a dependency and a wait for Lovable to re-resolve the
lockfile. The rest of GFM (strikethrough, task lists, footnotes) is still not
there; if the club ever wants it, that is the moment to add the real plugin and
delete ours.

## Reading progress

The knowledge base is a path, so it keeps track of how far along it a member is.

- An article is marked read when the reader reaches **the end of it**, not when
  they open it. "Opened" and "read" are different claims, and a list built on the
  first is one nobody can trust. A short article that fits on one screen counts
  straight away, which is honest; a syllabus counts once somebody has scrolled it.
- The sidebar ticks off what has been read, and the index page shows "3 of 9
  read" with a bar, plus a **"carry on where you left off"** card pointing at the
  first thing in reading order that is unread. Reading order, not "most recently
  opened": somebody who dipped into the syllabus is still handed the thing that
  comes next on the path.
- What is recorded is the VERSION they read. An article rewritten afterwards is
  shown as **"updated since you read it"** rather than staying quietly ticked
  off, and it becomes the next thing the index points at. A tick that claimed
  they had read wording that did not exist when they read it would be the one
  thing that makes the whole feature untrustworthy.
- **Link entries are not counted.** A page on the marketing site cannot report
  back that it was read, so counting one would put a tick nobody can ever earn
  into the total and leave "9 of 10" as the best a member could do.
- The progress panel appears only once there is progress. "0 of 9 read" is a
  scoreboard shown to somebody who has done nothing wrong.

**A member's progress is theirs.** No manager screen and no agent action can read
it, and the table's only policy is owner-scoped. It is the same call the feature
already makes about private notes. It is also decoration: if the read fails or
the write does, the page works and everything shows as unread.

## Who sees what

Everyone reading is signed in, so an article's `visibility` decides which of
them:

| Visibility | Who can read it                     | Typical use            |
| ---------- | ----------------------------------- | ---------------------- |
| `members`  | any signed-in person the club knows | handbooks, house rules |
| `managers` | managers only                       | drafts, internal notes |

`members` is the default for a new article, on purpose: the safe failure for a
mis-set visibility is "every member read the draft" rather than "the manager
could not find the article they wrote".

There is deliberately **no `public` level**. It used to exist, and once the
section needed a login it was a setting a manager could pick that changed
nothing, labelled "anyone, signed in or not" while meaning the opposite. What
the club publishes to the world lives on the marketing pages and the blog.

## Ways in

From the member area: the sidebar's first item, and a card at the top of
`/account`. Managers additionally reach the editor from their own sidebar
("Knowledge base editor"), which is a different entry from the reader above it.

The waiver-confirmation email **mentions** the knowledge base and deliberately
does not link to it. Whoever is reading that email cannot sign in yet: the
account is created locked, and a manager approving the waiver is what opens it
(`docs/waivers.md`, rule 6). Still true for a parent who signed for their child:
the account that opens is theirs, and it is still shut while they are reading
this. A link there would land a brand-new person on a
sign-in screen they have no account for. The **account-activated** email sent at
approval does link it, by which point they can get in.

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

### The name a comment is signed with

A shared comment is visible to every member who can read the article, so on the
member-facing page it is signed with the same privacy-conscious name a blog
comment gets: the commenter's own
`display_name` override, else "preferred/first name + last initial"
(`commentDisplayName` in `src/lib/validation.ts`), never the full legal name.

Both manager-facing views of the same feedback, the "Feedback" panel on
`/manager/kb` and the agent API's `list_kb_comments`, show the full legal name
instead, since a manager needs to identify who wrote a comment for moderation.
That difference from the member-facing view is deliberate. On the panel the
name is a link to the commenter's record, like every name in a manager's list,
which is why that list carries the author's id and the member-facing one
deliberately does not.

A manager can moderate (resolve a thread, delete an abusive comment) but can
never **rewrite** words attributed to somebody else. A comment feature people
cannot trust that way is one they stop using honestly.

Deleting a thread's root deletes its replies with it (`ON DELETE CASCADE`), and
the UI warns before doing so.

### Who gets told

A **shared** comment notifies people: a reply emails its recipient straight
away, everybody else on the thread gets it in the next daily summary, and
managers get a summary of new comments so feedback stops depending on somebody
remembering to open `/manager/kb`.

A **private note notifies nobody**, managers included. That follows from what a
private note is, and it is enforced twice: `createAnnotation` refuses a private
reply, and `notifyKbAnnotation` returns immediately for anything that is not
`shared`, so a private note's text can never reach an inbox.

One rule is specific to this feature: recipients are re-checked against the
article **as it stands now**, not as it stood when they commented. An article a
manager has narrowed from `members` to `managers` only notifies managers, even
about a thread a member took part in while it was wider. Full spec:
`docs/notifications.md`.

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
every article that was once a managers-only draft. A manager drafting a policy at
`managers` visibility and then publishing it to members would, without this,
hand every member every draft they went through. Only a **manager** can read a
specific version, on the manager screen or through the agent API.

## How managers edit the knowledge base

Two ways in, both doing the same thing to the same data.

### On the site: `/manager/kb`

The same shape as the waiver template editor, so there is one editor to learn
and not two: the reading order down the left, the markdown body in the main
window, a live preview underneath, and "Save as new version" publishing what you
wrote.

**The body has a formatting toolbar, and the shortcuts that go with it.** A
manager writing an article is thinking about the sentence they want emphasised,
not about Markdown syntax, so bold, italic, code, heading, both kinds of list,
quote and link are buttons above the textarea, and each one also answers to the
binding it has in every other editor. Bold is `Ctrl+B`, italic `Ctrl+I`, code
`Ctrl+E`, link `Ctrl+K`; the two lists and the quote are `Ctrl+Shift` with `8`,
`7` and the full stop. Each button names its own shortcut. On a Mac they are the
`⌘` versions, because `Ctrl+B` and `Ctrl+E` move the caret in every text field
on that system and taking them would break something a person already relies on
(the shifted ones are read off the physical key, so a non-US layout keeps them
too). What is stored is still plain Markdown, typed by hand where that is
faster.

Three things follow from that, and they are the reason the editor is a component
rather than a bare textarea:

- **Typing a wrapping character over a selection wraps it**, rather than
  deleting it. Highlighting a phrase and reaching for `*`, `_`, `` ` ``, a quote
  mark or a bracket puts it around the phrase, and the phrase stays selected so
  a second press nests it (`*tidy*`, then `**tidy**`).
- **Enter carries a list on**, numbering as it goes, and on an item with nothing
  typed in it takes the marker away instead, which is how a list is left.
- **Undo still works.** Edits are applied through the browser's own editing
  machinery, so Ctrl/⌘ + Z takes the bold off rather than doing nothing or
  jumping back further than anyone meant.

Pressing a button with nothing selected acts on the word the cursor is in, and
pressing it again takes the formatting off.

**The reading order is the navigation for this screen.** It is on the left
because that is what it is for: picking what to edit, and arranging what members
read. Everything that CHANGES a thing (its title, its text, its settings,
deleting it) happens in the main window, so a click in the list can never be
destructive and a manager can always see what they are about to edit.

**Save is disabled until there is something to save.** Opening an article and
pressing Save used to publish an identical version: it bumped the number every
member's comments are pinned against and told readers the article had been
updated when not a word of it had changed. A change note on its own does not
count as an edit, because it describes a save rather than being part of the
article.

What is here that the waiver template does not have:

- **Several articles.** Pick one from the list, or start a new one. A new
  article needs a URL key (`our-history`), proposed from the title.
- **Who can read it**, and whether it accepts comments.
- **Versions.** Every save adds one. Older versions can be **read** before you
  decide, and **restored**, which is how an edit is undone without retyping it.
  Restoring publishes the stored version, not what is in the editor, and the
  screen says so before it does.
- **Feedback.** Open shared threads members left, quoted passage and all.
  Private notes are never listed here. The commenter's name opens their record.
  Replying happens on the article itself.

Widening who can read an article (managers → members) asks first. Narrowing does
not: it takes an article away from people, which is recoverable.

The same distinction decides the ORDER a save writes in, which matters when half
of it fails. Widening writes the new text first and the wider audience second, so
a failure leaves the text live under the old, narrower audience. Narrowing writes
the narrower audience first, so a failure leaves the old text under it rather
than publishing the new text to the audience it was being taken away from. Either
way the failure direction is "fewer people can read it".

**The reading order is arranged here too.** The list is not a flat alphabetical
index next to a separate ordering panel: it IS the sidebar a member sees,
sections and all, and it is rearranged by dragging.

- **Drag an entry by its handle** to move it up or down its section, into
  another section, into a section that is still empty, or into "Everything
  else". Dragging a section heading moves the whole section. It works with a
  mouse, with a finger, and from the keyboard: the handle is a real focusable
  button, and dnd-kit's keyboard sensor is the only way to reorder without a
  pointer now that the arrows are gone.
- **A drop saves immediately.** `moveEntry` renumbers the affected section (both
  of them, on a cross-section move) in tens and returns only the rows that
  actually changed, so a move is two or three placement writes rather than a
  rewrite of the whole structure. The list holds the dropped arrangement until
  the refreshed rows land, so it never snaps back for the length of a round trip.
- **Moving something writes no new version**, so rearranging the knowledge base
  never tells a reader an article was updated. This is why dragging is the only
  way to move one: the old section select applied on Save, which published a new
  version for what was really just a move.
- **There is no section picker in the details view.** Where an entry sits is
  shown by where it sits in the list, and changed by dragging it there.
- **"Everything else" is always shown here**, empty or not, because on this
  screen it is somewhere you can drop something. The reader's sidebar still hides
  it when empty (`buildKbNav`'s `keepEmpty` is manager-only).
- **Clicking a section name opens it in the main window**, where it is renamed
  and deleted. Its URL key is shown but fixed: every article in the section
  refers to it by that key, so changing it would unfile all of them.
- **New section** takes a name; positions are handed out in tens so there is
  always room to slot something between two others. Deleting a section keeps its
  articles, dropping them into "Everything else", and the confirmation says how
  many that is.
- **New link** creates a link entry: a name for the sidebar and a path on this
  site. An existing link entry can be turned back into an article, and the
  editor says the link is only replaced when you save.

**"Link to a section" lists what this article offers.** Every heading in the
body being edited, with the exact link another article should use
(`/kb/belts#fees`), a Copy button on each, and a `Pinned` badge on the ones
written as `## Heading {#anchor}`. It reads off the text in the editor rather
than the saved version, so a heading just typed can be linked to straight away
and a manager can see what renaming one did to its link before publishing it.
That panel is the only place the fragment is discoverable: it comes out of the
heading's wording, which is not something to ask anybody to derive by hand.

Everything here does the same thing to the same data as the agent API, through
the same code (`kb-admin.ts`). Neither is the "real" one.

### From an agent: `/api/manager/agent`

Driven by the `uts-manager-agent` skill, for the case the editor is bad at: an
agent applying a marked-up draft rather than a person typing markdown into a
textarea, and everything to do with the reading order.

Seven actions: `list_kb_sections`, `save_kb_section`, `delete_kb_section`,
`list_kb_articles`, `get_kb_article`, `save_kb_article`, `list_kb_comments`. The
manifest at `GET /api/manager/agent` is the runtime source of truth for their
parameters.

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
- **Cross-references are read off `get_kb_article`, not derived.** Its result
  carries `sections`: every heading in the version read, with its `id`, `text`,
  `depth`, `pinned` flag and a ready-made `url` (`/kb/belts#fees`). Read the
  article being pointed at and use that `url`. An anchor worked out from the
  heading's wording is right until it is not, and a wrong one fails silently.
  Pin any heading being linked to (`## How grading works {#grading}`) so the
  link survives the club rewording it later.
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

## How fast it feels, and why

Every page under `/kb` renders client-side, so there is a real cost to opening
one: the session has to resolve in the browser before anything can be asked for,
and each answer is a round trip through the site's own server to Supabase. Four
things keep that off the reader's path.

- **The contents is fetched once and held.** The sidebar is on every page here
  and its structure changes when a manager publishes, which is a few times a
  year, so it is cached for five minutes rather than refetched on every mount
  and every window focus. Finishing an article still ticks it off immediately:
  recording a read invalidates the contents on purpose.
- **Articles are prefetched on intent.** The sidebar, the index list, the search
  results and the previous/next links all know the slug a reader is about to
  open, so the fetch starts on hover, on keyboard focus, or on the touch that
  precedes a tap. On a warm cache the click lands on an article that is already
  there. An article is held for five minutes too, so moving back and forth
  through a section costs nothing.
- **Nothing waits for anything it does not need.** The article, its comments and
  the reader's identity are three independent lookups, and they now run at the
  same time. The comments used to wait for the article to arrive even though all
  they need is the slug the router already has; on the server, working out who
  is asking (two round trips of its own) used to sit in front of the first query
  rather than beside it. The article page also read the same database row twice
  on every load: once to tell a link entry from a real page, once again inside
  the loader it then called.
- **The contents and the article survive the app being closed.** Both are kept
  on the reader's own device as well as in memory, so opening the installed app
  paints what was there last time instead of a spinner, and a member on the mat
  with no signal can still read an article they have opened before. When the
  refresh behind it fails, the article stays up with a notice saying when it was
  fetched, rather than the page reporting itself unavailable. A week, because
  these are the club's own handbooks and they change a few times a year;
  `docs/pwa.md` has the storage rules and the reasoning.
- **The page keeps its frame while the text is fetched.** The contents already
  knows this article's section and title, so moving between two articles shows
  the breadcrumb and the heading straight away rather than replacing the whole
  page with a spinner.

Everything a reader is cached for is keyed by **who they are**. That is a
security property rather than a nicety: managers-only drafts are readable data
under these keys, and a five-minute cache under a reader-agnostic key would keep
one on screen after a sign-out in another tab. The copies kept on the device
carry the same reader's id on every entry, and signing out wipes them, so a
shared club laptop never hands one person's reading to the next.

**Nothing typed into the editor is lost to a closed app.** An article is Markdown
a manager can sit with for a long time, and it used to live only in React state,
so the installed app being reclaimed in the background took the lot. It is now
kept on the device as it is written and offered back when the editor reopens —
an offer, never a silent restore. A save that fails leaves a panel on screen
rather than a toast that fades. Same two modules as the blog composer
(`src/lib/editor-draft.ts`, `src/hooks/use-editor-draft.ts`); `docs/blog.md` has
the reasoning written out.

**Publishing clears all of it.** The manager screen keeps its own state and
never goes through these queries, so it drops them by hand after every write
(`useInvalidateKbReader`). Without that, a manager who publishes a correction
and opens `/kb/<slug>` to check it reads the version they have just replaced.

## SEO

`/kb` is in `robots.txt`'s disallow list, and every page under it is `noindex`
as well. Both, because they answer different questions: a crawler cannot read a
page that needs a login, so there is nothing to spend crawl budget on, and the
section renders client-side, so a `noindex` tag would never reach a crawler
anyway.

Making an article public is not a matter of dropping the `noindex`: the whole
section is behind the sign-in, so publishing something to the world means writing
it as a marketing page or a blog post instead.

## Where the code lives

| Concern                                     | File                                                |
| ------------------------------------------- | --------------------------------------------------- |
| Block splitting, anchoring, permissions     | `src/lib/kb.ts` (pure, tested)                      |
| Sections, reading order, progress, headings | `src/lib/kb-nav.ts` (pure, tested)                  |
| Editor decisions (dirty, widening, reorder) | `src/lib/kb-editor.ts` (pure, tested)               |
| Toolbar, shortcuts, what a keystroke does   | `src/lib/markdown-editing.ts` (pure, tested)        |
| The body textarea itself                    | `src/components/site/MarkdownEditor.tsx`            |
| Saving, versioning, promotion, sections     | `src/lib/kb-admin.ts`                               |
| Reader/annotation/progress server functions | `src/lib/kb.functions.ts`                           |
| Wire schemas                                | `src/lib/validation.ts`                             |
| Article typography                          | `src/lib/kb-markdown.tsx`                           |
| Markdown tables                             | `src/lib/remark-kb-tables.ts` (pure, tested)        |
| Section anchors (`{#id}` stripping)         | `src/lib/remark-kb-anchors.ts` (pure, tested)       |
| Shell (top bar, sidebar, search, progress)  | `src/components/site/KbLayout.tsx`                  |
| Reader UI                                   | `src/components/site/KbArticleReader.tsx`           |
| Sign-in gate + reader routes                | `src/routes/kb/route.tsx`, `index.tsx`, `$slug.tsx` |
| Contents fetch and its cache                | `src/hooks/useKbNav.ts`                             |
| Article fetch, its cache, prefetching       | `src/hooks/useKbArticle.ts`                         |
| Manager screen                              | `src/routes/_authenticated/manager.kb.tsx`          |
| Manager API actions                         | `src/routes/api/manager/agent.ts`                   |

`src/lib/kb-types.ts` aliases the generated
`src/integrations/supabase/types.ts`, with one narrowing: `visibility` is a text
column with a CHECK rather than an enum, so the generator can only say `string`
and the app's unions are asserted in that one file.
