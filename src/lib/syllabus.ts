// The syllabus: belts, topics, and what each belt asks of each topic.
//
// Pure and side-effect free, like `kb.ts` and `kb-nav.ts`, and for the same
// reason: the member's "up to belt X" page, the belt pages themselves, the
// manager's editor and the agent API all have to agree about what the syllabus
// says and in which order, and an order worked out one way in a component and
// another way in a handler is a syllabus that reads differently depending on
// where you look. Everything here takes plain data and returns plain data.
//
// The one idea worth holding on to: the syllabus is stored as one block of
// markdown per (belt, topic), and a belt's knowledge base page (/kb/green-belt)
// is ASSEMBLED from its blocks by `composeBeltPage`, then published as an
// ordinary article version. That is what keeps comments, reading progress,
// search, previews and offline reading working on belt pages without any of
// them knowing the syllabus exists. See docs/syllabus.md.
import { normalizeBlockText, splitBlocks } from "@/lib/kb";
import type { ArticleVisibility } from "@/lib/kb";
import { extractHeadings, headingSlug } from "@/lib/kb-nav";

/** A belt, as the syllabus needs it. */
export type SyllabusBelt = {
  slug: string;
  name: string;
  /** "7th Kyu". Null for a belt with no grade of its own. */
  grade: string | null;
  /** `#rrggbb`. Shown as a swatch, never as a text colour. */
  colour: string;
  /** Junior first. */
  position: number;
  /** The belt's knowledge base page, or null while it has none. */
  page_slug: string | null;
  /** Who can read that page. Null while there is no page. */
  visibility: ArticleVisibility | null;
};

/** A topic or a sub-topic. */
export type SyllabusTopic = {
  slug: string;
  title: string;
  /** The parent topic's slug. Null for a top-level topic. */
  parent: string | null;
  position: number;
};

/** One belt's block of text for one topic. */
export type SyllabusEntry = {
  belt: string;
  topic: string;
  body_md: string;
};

export type SyllabusData = {
  belts: SyllabusBelt[];
  topics: SyllabusTopic[];
  entries: SyllabusEntry[];
};

/** A top-level topic with its sub-topics, both in order. */
export type SyllabusTopicNode = SyllabusTopic & { children: SyllabusTopic[] };

/** What a belt page says when nothing has been written for that belt yet. */
export const EMPTY_BELT_PAGE = "Nothing has been written for this belt yet.";

/** The URL key of the page that holds a belt's syllabus: `green` -> `green-belt`. */
export function beltPageSlug(beltSlug: string): string {
  return `${beltSlug}-belt`;
}

/** "Dark Blue belt (2nd Kyu)", the title every belt page already had. */
export function beltPageTitle(belt: Pick<SyllabusBelt, "name" | "grade">): string {
  return belt.grade ? `${belt.name} belt (${belt.grade})` : `${belt.name} belt`;
}

/** Belts junior first. Ties break on slug so the order never shuffles. */
export function orderBelts<B extends Pick<SyllabusBelt, "position" | "slug">>(belts: B[]): B[] {
  return [...belts].sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug));
}

const byPosition = (a: SyllabusTopic, b: SyllabusTopic) =>
  a.position - b.position || a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);

/**
 * The topics as a two-level tree, both levels in order.
 *
 * A sub-topic whose parent is missing (it can only happen in data assembled by
 * hand, since the database refuses to delete a topic that still has children)
 * is shown at the top level rather than dropped: a topic that vanishes takes
 * every belt's text for it out of sight with it.
 */
export function topicTree(topics: SyllabusTopic[]): SyllabusTopicNode[] {
  const known = new Set(topics.filter((t) => t.parent === null).map((t) => t.slug));
  const roots: SyllabusTopicNode[] = [];
  const children = new Map<string, SyllabusTopic[]>();
  for (const topic of topics) {
    if (topic.parent !== null && known.has(topic.parent)) {
      const list = children.get(topic.parent);
      if (list) list.push(topic);
      else children.set(topic.parent, [topic]);
    } else {
      roots.push({ ...topic, parent: null, children: [] });
    }
  }
  return roots
    .sort(byPosition)
    .map((root) => ({ ...root, children: (children.get(root.slug) ?? []).sort(byPosition) }));
}

/** Every topic in reading order: each top-level topic followed by its sub-topics. */
export function flattenTopics(tree: SyllabusTopicNode[]): SyllabusTopic[] {
  return tree.flatMap(({ children, ...root }) => [root, ...children]);
}

/**
 * The heading a topic gets on a belt page.
 *
 * The topic's slug is its anchor (/kb/green-belt#breakfalling), and it has to
 * stay the anchor when the topic is renamed, or every link aimed at it breaks.
 * So a heading whose words no longer produce its slug is pinned with the
 * `{#slug}` attribute the reader already understands. One whose words DO
 * produce it is written bare, which is exactly what the pages said before the
 * syllabus was structured, so importing them changes no heading and detaches no
 * comment.
 */
export function topicHeading(topic: Pick<SyllabusTopic, "slug" | "title">, depth: 2 | 3): string {
  const hashes = depth === 2 ? "##" : "###";
  const pin = headingSlug(topic.title) === topic.slug ? "" : ` {#${topic.slug}}`;
  return `${hashes} ${topic.title}${pin}`;
}

/** The entries for one belt, keyed by topic slug. */
function entriesFor(beltSlug: string, entries: SyllabusEntry[]): Map<string, string> {
  return new Map(entries.filter((e) => e.belt === beltSlug).map((e) => [e.topic, e.body_md]));
}

/**
 * A belt's page, put together from its blocks in topic order.
 *
 * A topic the belt has nothing on is left out entirely, heading and all. A
 * parent topic (Techniques) is written when the belt has text on it OR on any of
 * its sub-topics, so Throws never appears without the Techniques heading above
 * it.
 */
export function composeBeltPage(
  beltSlug: string,
  topics: SyllabusTopic[],
  entries: SyllabusEntry[],
): string {
  const text = entriesFor(beltSlug, entries);
  const parts: string[] = [];
  for (const root of topicTree(topics)) {
    const own = text.get(root.slug);
    const kids = root.children.filter((child) => text.has(child.slug));
    if (own === undefined && kids.length === 0) continue;
    parts.push(topicHeading(root, 2));
    if (own !== undefined) parts.push(tidyBlock(own));
    for (const child of kids) {
      parts.push(topicHeading(child, 3));
      parts.push(tidyBlock(text.get(child.slug)!));
    }
  }
  return parts.length ? parts.join("\n\n") : EMPTY_BELT_PAGE;
}

/**
 * Whether two versions of a page say the same thing, block for block.
 *
 * Compared as blocks rather than as raw text because blank lines around a
 * heading change the text without changing the page: the pages imported into
 * the syllabus were written with the list straight under each heading, and
 * `composeBeltPage` puts a blank line there. Republishing every belt page for
 * that alone would tell every member that all seven had been updated when not a
 * word had changed.
 */
export function sameBlocks(a: string, b: string): boolean {
  const left = splitBlocks(a).map((block) => normalizeBlockText(block.markdown));
  const right = splitBlocks(b).map((block) => normalizeBlockText(block.markdown));
  return left.length === right.length && left.every((text, i) => text === right[i]);
}

/**
 * Whether two versions of a page hold exactly the same blocks, in any order.
 *
 * True when the only difference is the ORDER of the topics, which is what
 * moving a topic does. A reader who read the old version has read every word
 * of the new one, so their progress is carried over to it rather than the page
 * telling them it was updated (`republishBeltPages`).
 */
export function sameBlockSet(a: string, b: string): boolean {
  const sorted = (markdown: string) =>
    splitBlocks(markdown)
      .map((block) => normalizeBlockText(block.markdown))
      .sort();
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((text, i) => text === right[i]);
}

/**
 * A block's text with blank lines and trailing space dropped from either end,
 * but NEVER the indentation on its first line. A plain `.trim()` would turn a
 * block that opens with an indented code sample into a paragraph, the same
 * trap `splitBlocks` in kb.ts avoids.
 */
export function tidyBlock(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");
}

/**
 * Why a block of text cannot be saved as it is, or null when it can.
 *
 * A heading inside a block would put a section into the belt page that is not
 * a topic: it would not appear in the "up to belt X" view, and it would split
 * the block in two on the page. The topic is already the heading, so the text
 * under it has to be the content alone.
 */
export function entryProblem(body: string): string | null {
  if (extractHeadings(body).length > 0) {
    return "Leave headings out of the text. The topic is already the heading, so start with the content (a list, a sentence).";
  }
  return null;
}

// ---- The "up to belt X" view ----

/** One belt's text under one topic, in the view. */
export type ViewBeltEntry = { belt: SyllabusBelt; body_md: string };

/** A topic in the view, with only the belts that have something on it. */
export type ViewTopic = {
  slug: string;
  title: string;
  depth: 2 | 3;
  entries: ViewBeltEntry[];
  /** Sub-topics. Always empty on a sub-topic. */
  children: ViewTopic[];
};

export type SyllabusView = {
  /** The belts on the page, junior first. */
  belts: SyllabusBelt[];
  /** Every belt that has a page, for the picker. */
  choices: SyllabusBelt[];
  /** The belt the view stops at. Null when there is nothing to show at all. */
  upTo: SyllabusBelt | null;
  /** The topic being shown on its own, or null for all of them. */
  topic: SyllabusTopic | null;
  /** The topic's parent, when the topic is a sub-topic, for the heading above it. */
  topicParent: SyllabusTopic | null;
  sections: ViewTopic[];
  /** Every topic in order, for the "jump to" list and the topic picker. */
  allTopics: SyllabusTopicNode[];
  /** A `up_to` that names no belt on offer, so the page can say so. */
  unknownUpTo: string | null;
  /** A `topic` that names no topic, so the page can say so. */
  unknownTopic: string | null;
};

/**
 * Everything up to and including one belt, topic by topic.
 *
 * Only belts with a page are on offer. White has no syllabus, and a belt whose
 * page this reader cannot see has already been taken out by the server, so a
 * managers-only belt (one still being written) never reaches a member here.
 *
 * With no `upTo`, or one that names no belt on offer, the view runs to the most
 * senior belt: the whole syllabus. An unknown one is reported rather than
 * silently replaced, because a link from a group chat saying "up to green" that
 * quietly shows everything looks like it worked.
 *
 * A belt with nothing on a topic is skipped under it, and a topic no belt in
 * range has anything on is skipped altogether.
 */
export function syllabusView(
  data: SyllabusData,
  opts: { upTo?: string | null; topic?: string | null } = {},
): SyllabusView {
  const choices = orderBelts(data.belts.filter((b) => b.page_slug !== null));
  const named = opts.upTo ? (choices.find((b) => b.slug === opts.upTo) ?? null) : null;
  const upTo = named ?? choices[choices.length - 1] ?? null;
  const belts = upTo ? choices.filter((b) => b.position <= upTo.position) : [];

  const allTopics = topicTree(data.topics);
  const flat = flattenTopics(allTopics);
  const topic = opts.topic ? (flat.find((t) => t.slug === opts.topic) ?? null) : null;
  const topicParent = topic?.parent ? (flat.find((t) => t.slug === topic.parent) ?? null) : null;

  const text = new Map<string, Map<string, string>>();
  for (const belt of belts) text.set(belt.slug, entriesFor(belt.slug, data.entries));

  const entriesOn = (slug: string): ViewBeltEntry[] =>
    belts.flatMap((belt) => {
      const body = text.get(belt.slug)?.get(slug);
      return body === undefined ? [] : [{ belt, body_md: body }];
    });

  const node = (t: SyllabusTopic, depth: 2 | 3, children: ViewTopic[] = []): ViewTopic => ({
    slug: t.slug,
    title: t.title,
    depth,
    entries: entriesOn(t.slug),
    children,
  });

  let sections: ViewTopic[];
  if (topic && topic.parent !== null && topicParent) {
    sections = [node(topic, 3)];
  } else {
    const roots = topic ? allTopics.filter((r) => r.slug === topic.slug) : allTopics;
    sections = roots.map((root) =>
      node(
        root,
        2,
        root.children.map((child) => node(child, 3)),
      ),
    );
  }
  sections = sections
    .map((s) => ({ ...s, children: s.children.filter((c) => c.entries.length > 0) }))
    .filter((s) => s.entries.length > 0 || s.children.length > 0);

  return {
    belts,
    choices,
    upTo,
    topic,
    topicParent,
    sections,
    allTopics,
    unknownUpTo: opts.upTo && !named ? opts.upTo : null,
    unknownTopic: opts.topic && !topic ? opts.topic : null,
  };
}

/**
 * The view as one markdown document: what the agent API hands back, so an
 * assistant asked "everything up to green" can read it out as the member page
 * shows it rather than reassembling it from rows.
 */
export function syllabusViewMarkdown(view: SyllabusView): string {
  const label = (belt: SyllabusBelt) => beltPageTitle(belt);
  const parts: string[] = [];
  const write = (section: ViewTopic) => {
    parts.push(`${section.depth === 2 ? "##" : "###"} ${section.title}`);
    for (const entry of section.entries) {
      parts.push(`**${label(entry.belt)}**`);
      parts.push(tidyBlock(entry.body_md));
    }
    section.children.forEach(write);
  };
  view.sections.forEach(write);
  return parts.join("\n\n");
}
