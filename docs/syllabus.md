# The syllabus

What each belt asks of each topic, kept as structured data, and read two ways:
belt by belt on each belt's knowledge base page (`/kb/green-belt`), and topic by
topic, **everything up to a belt**, at `/kb/syllabus`. Managers write it at
`/manager/syllabus` or through the manager agent API, which do the same things
to the same data.

The schema is in `docs/database.md` ("Syllabus"). The knowledge base the belt
pages live in is `docs/knowledge-base.md`.

## What problem this solves

Each belt's syllabus used to be one free-form article, with the topics
(Breakfalling, Striking, Techniques > Throws, ...) existing only as headings
inside it. So the question a member actually asks before a grading,
"breakfalling for every belt up to green", meant opening seven pages and
scrolling each one. And because a topic was just a heading, a typo in one page
("Self protection" against everybody else's "Self-Protection") quietly split
the topic in two.

The topics are now rows the club manages, and the syllabus is **one block of
markdown per belt per topic**.

## The three things it is made of

- **Belts**: name, grade, a swatch colour and an order, junior first. Seeded
  with the seven kyu belts and white. White has no syllabus page and never
  appears in the syllabus; it is there so that recording which belt each member
  holds, the natural next step, has a "not graded yet" to start from. Dan grades
  are deliberately not belts here: they have a page of their own and no
  syllabus.
- **Topics**: a title and an order, in **two levels**: a topic (Techniques) and
  the sub-topics under it (Throws, Nage no Kata, Locks, Application
  Demonstration, Groundwork, Coaching). Deeper nesting reads badly on a phone.
  A topic's **slug is fixed once made**, because it is the heading's anchor on
  every belt page (`/kb/green-belt#breakfalling`) and the `topic=` in every
  shared link. Renaming a topic changes its title only.
- **Blocks**: one belt's text for one topic. Markdown, so lists, bold, links and
  the link previews they bring all work. **No headings inside a block**: the
  topic is the heading, and a heading inside would put a section on the belt
  page that is not a topic. A belt with no block on a topic has nothing on it,
  and is skipped there.

## Belt pages are assembled, and that is the whole trick

A belt's page is an ordinary knowledge base article. Its text is **put
together from that belt's blocks**, in topic order (`composeBeltPage` in
`src/lib/syllabus.ts`), and published as a new article version whenever a
block, a topic's title or place, or the belt's name or grade changes.

Because it is an ordinary article, everything the knowledge base already does
keeps working on it with no special case: comments, reading progress and
"updated since you read it", search, link previews, offline reading, and the
version history.

Three rules follow, and the code enforces each:

- **A belt page's text comes from the syllabus alone.** The article editor and
  the agent's `save_kb_article` refuse text for a belt page, and the editor
  shows a note pointing at the syllabus screen instead of a body to type into.
  Without that, text typed there would be overwritten, without a word, the next
  time anybody touched that belt's syllabus. Settings still save as normal: who
  can read it, whether it takes comments, the sidebar label.
- **A republish that would say the same thing writes nothing.** Pages are
  compared block by block (`sameBlocks`), not as raw text, so a page that
  differs only in blank lines around its headings is "the same". This is what
  keeps a retry, or a save that changed nothing, from telling every reader the
  page was updated.
- **Each save republishes each belt page it changed once.** Saving all ten of a
  belt's topics in one go is one new version of its page, not ten. The screen
  saves everything changed at once, and the agent API takes any number of
  blocks per call.

An older version of a belt page **cannot be put back live**: it would leave the
page saying one thing and the syllabus another. A manager can still read an
older version, copy what they need, and write it into the syllabus.

A renamed topic keeps its anchor because the page writes the heading with the
`{#slug}` attribute whenever the words no longer produce it
(`## Ukemi {#breakfalling}`). A heading whose words do produce its slug is
written bare, which is exactly how the pages read before the syllabus was
structured.

## The Syllabus section

The belt pages live in one knowledge base section whose **kind** is
`syllabus`, and it holds **belt pages only**:

- they are ordered by belt, not by dragging (the manager editor shows them
  without a drag handle, and the API refuses a `position` for one; move the belt
  instead);
- an ordinary article cannot be filed there, and a belt page cannot be moved
  out;
- the section cannot be deleted, only renamed;
- in the sidebar it opens with a link to the syllabus by topic.

## Reading it by topic: `/kb/syllabus`

**Everything up to and including the belt you pick**, topic by topic. Built for
a phone held in one hand, and for an instructor reading down it while testing
somebody:

- **One column, scrolling down, with the syllabus starting near the top of
  the screen.** The two pickers share one row (belts by name only, "Green"),
  and nothing else stands between them and the first topic. On a phone the
  earlier layout (stacked pickers, a row of belt swatches and a "Jump to" card)
  put the syllabus itself below the fold.
- **A topic row pinned under the top bar** while the page scrolls, marking the
  topic being read and scrolling sideways to keep it in view. It is how an
  instructor reading down the page knows where they are and jumps ahead, and it
  replaced the "Jump to" card and the "Back to the topics" links.
- **Each belt is a strip in its colour down the left**, with its name and grade
  and a link to that topic on its own page, rather than a boxed card: on a phone
  a card per belt per topic was mostly border and padding. Text is at reading
  size (16px). The colour is decoration; the name is always there.
- **Pick a belt and, optionally, one topic.** Picking a topic with sub-topics
  shows all of them; picking a sub-topic shows it alone and says which topic it
  is part of.
- **A belt with nothing on a topic is skipped**, and a topic nobody in range has
  anything on is left out.
- **The choice is in the address** (`/kb/syllabus?up_to=green&topic=breakfalling`),
  so a view can be sent to a group before a grading. A link naming a belt or
  topic that does not exist **says so** and shows everything, rather than
  quietly showing everything as if that were what was asked.
- **Keep screen on**: an optional button, off until pressed (it costs battery,
  and a member looking one thing up does not want it), shown only where the
  browser supports the Screen Wake Lock API. It takes the lock again when the
  tab comes back to the front, since the browser drops it when it is hidden.
- **It works offline** once opened: the whole syllabus is a few dozen short
  blocks, fetched in one go and kept on the device like the rest of the
  knowledge base (`docs/pwa.md`), with the stale notice when a refresh fails.
  Changing the belt or topic needs no network at all.

Every topic heading on a belt page links here too: "Breakfalling, every belt up
to Green", which is the next thing somebody preparing for that grading wants.

## Who sees what

**A member sees a belt only once they can open its page.** The view is filtered
on the server to belts whose page the reader may read (`canReadArticle`), text
and all, so a belt still being written at `managers` visibility never reaches a
member through the view either. A manager sees those belts, marked Draft.

**A belt's first block makes its page, as a managers-only draft**, in the
Syllabus section. Publishing a belt's syllabus to the members being graded on
it the moment it has one line would be the wrong default. A manager opens it
when it is ready: the Belts tab's "Open the page to members", behind a confirm
that says every member will be able to read it, or
`save_kb_article { slug, visibility: "members" }` from an agent.

## How managers edit it

### On the site: `/manager/syllabus`

- **Write**: one belt's every topic, or one topic across every belt, as a column
  of boxes. The second is how a progression is kept coherent: breakfalling from
  yellow to brown, on one screen. Each box has the knowledge base's formatting
  toolbar and shortcuts. Boxes that changed are marked, a heading typed into one
  is flagged before saving, and "Save N changes" sends only those. A change note
  is optional and shown on each republished page.
  - What is typed is **kept on the device** and offered back if the app is
    closed (`useEditorDraft`), a failed save **stays on screen** with a retry
    (`SaveFailure`), and switching to another belt or topic over unsaved work
    asks first.
- **Belts**: rename, regrade, recolour, reorder, add, delete one made by
  mistake (refused for a belt with a page or any text), and open a draft page to
  members.
- **Topics**: rename, move up or down, file under another topic, add, and delete
  one nobody has written under (refused otherwise, naming the belts). A move is
  one save where the numbering allows it, so each belt page gets one new version
  per move rather than two.

Last save wins, as with an article: two managers editing the same block at the
same moment each overwrite the other. Every republish is a kept version of the
belt page, so nothing written is lost for good.

### From an agent

`list_belts`, `save_belt`, `delete_belt`, `list_syllabus_topics`,
`save_syllabus_topic`, `delete_syllabus_topic`, `get_syllabus` and
`save_syllabus_entries`. The contract is in `docs/manager-agent-api.md`, and
the agent-facing guide in the `uts-manager-agent` skill. `get_syllabus` is the
same view as `/kb/syllabus` (the same `syllabusView`), also returned as one
markdown document.

## How it was imported

`20261108000000_syllabus.sql` read each belt page's live version and filed the
text under each `##` and `###` heading as that belt's block for that topic. It
refuses, naming the page and the heading, anything it cannot place (a heading
that is not a topic, a sub-topic under the wrong topic, text before the first
heading), so nothing was dropped silently. Reassembling the imported pages
gives back every block the originals had, so no comment came loose.

The pages keep the version they had until somebody next edits the syllabus. Two
of them (Light Blue and Brown) were written in a different topic order from the
others, so the first edit puts them in the club's order; nothing else about
them changes.

## Where the code lives

| Concern                                    | File                                             |
| ------------------------------------------ | ------------------------------------------------ |
| Topic order, assembly, the view (pure)     | `src/lib/syllabus.ts`                            |
| Editor decisions (pure)                    | `src/lib/syllabus-editor.ts`                     |
| Reads, writes, republishing belt pages     | `src/lib/syllabus-admin.ts`                      |
| Server functions (reader + manager screen) | `src/lib/syllabus.functions.ts`                  |
| Wire schemas                               | `src/lib/validation.ts` ("Syllabus")             |
| The belt-page guards on article saves      | `src/lib/kb-admin.ts` (`refuseBeltPageEdits`)    |
| Member view                                | `src/routes/kb/syllabus.tsx`                     |
| Its data, kept on the device               | `src/hooks/useSyllabus.ts`                       |
| Manager screen                             | `src/routes/_authenticated/manager.syllabus.tsx` |
| Agent API actions                          | `src/lib/manager-agent-actions.ts`               |
