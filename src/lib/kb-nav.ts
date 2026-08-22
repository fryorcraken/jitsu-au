// The shape of the knowledge base: which sections exist, what order the articles
// read in, and what a long article's own headings are.
//
// Pure and side-effect free, no server imports and no React, for the same reason
// `kb.ts` and `validation.ts` are: the sidebar, the index page and the prev/next
// links all have to agree about the order, and an ordering computed one way in a
// component and another way in a handler is a reading order that quietly differs
// from the one a manager set.
import { splitBlocks } from "@/lib/kb";

/** A section as it comes out of the database. */
export type KbSectionInput = {
  slug: string;
  title: string;
  position: number;
};

/**
 * A sidebar entry as it comes out of the database: an article, or a link to a
 * page elsewhere on the site.
 */
export type KbEntryInput = {
  slug: string;
  /** The label to show. Already resolved from `nav_title` or the live title. */
  title: string;
  /** Set on a link entry: where it points. Null on a real article. */
  link_path: string | null;
  /** Null when the article is in no section. */
  section_slug: string | null;
  position: number;
  /** Only `managers` is ever shown, as a draft marker. */
  visibility?: string;
  /** The live version. Null on a link entry, which has none. */
  version?: number | null;
  /** The version THIS reader read, or null for "not read". */
  read_version?: number | null;
};

export type KbNavEntry = KbEntryInput & {
  /** The section it ended up in, which is not the same as the one it named. */
  section_slug: string | null;
  section_title: string | null;
  /** Where a reader clicking this in the sidebar goes. */
  href: string;
};

export type KbNavSection = {
  /** Null for the catch-all group of articles that belong to no section. */
  slug: string | null;
  title: string;
  entries: KbNavEntry[];
};

/**
 * Where an article with no section ends up.
 *
 * It is a visible group at the bottom rather than a hidden state: an article a
 * manager forgot to file is still one a member can find, and "it vanished from
 * the sidebar" is a much worse failure than "it is in the wrong place".
 */
export const UNSECTIONED_TITLE = "Everything else";

/** The path a sidebar entry points at. */
export function entryHref(entry: { slug: string; link_path: string | null }): string {
  return entry.link_path ?? `/kb/${entry.slug}`;
}

/**
 * Group articles into sections and put both in reading order.
 *
 * Sections sort by `position` then slug, entries by `position` then title. The
 * tie-breaks matter: `position` defaults to 0 for everything, so without them a
 * knowledge base nobody has ordered yet would come back in whatever order
 * Postgres felt like, and the sidebar would reshuffle itself between page loads.
 *
 * An entry naming a section that does not exist is treated as unsectioned rather
 * than dropped, for the same reason the catch-all group exists at all.
 *
 * `keepEmpty` is for the MANAGER screen only. A section with nothing in it is
 * noise to a member, so the reader drops it — but the manager who has just
 * created one needs to see it in order to put anything in it, and a "New
 * section" button whose result does not appear is one they will press twice.
 */
export function buildKbNav(
  sections: KbSectionInput[],
  entries: KbEntryInput[],
  opts: { keepEmpty?: boolean } = {},
): KbNavSection[] {
  const known = new Map(sections.map((s) => [s.slug, s]));

  const ordered = [...sections].sort(
    (a, b) => a.position - b.position || a.slug.localeCompare(b.slug),
  );

  const bySection = new Map<string | null, KbNavEntry[]>();
  for (const entry of entries) {
    const section = entry.section_slug && known.has(entry.section_slug) ? entry.section_slug : null;
    const resolved: KbNavEntry = {
      ...entry,
      section_slug: section,
      section_title: section ? (known.get(section)?.title ?? null) : null,
      href: entryHref(entry),
    };
    const list = bySection.get(section);
    if (list) list.push(resolved);
    else bySection.set(section, [resolved]);
  }

  const sortEntries = (list: KbNavEntry[]) =>
    [...list].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));

  const nav: KbNavSection[] = ordered
    .map((section) => ({
      slug: section.slug,
      title: section.title,
      entries: sortEntries(bySection.get(section.slug) ?? []),
    }))
    // An empty section is a heading with nothing under it. A manager who has
    // created one but not filled it yet should not have it shown to members.
    .filter((section) => opts.keepEmpty || section.entries.length > 0);

  const loose = bySection.get(null);
  if (loose?.length) {
    nav.push({ slug: null, title: UNSECTIONED_TITLE, entries: sortEntries(loose) });
  }
  return nav;
}

/**
 * The whole knowledge base as one reading order.
 *
 * This is what makes prev/next an onboarding path rather than a within-section
 * shuffle: reaching the end of "Start here" hands the reader the first article
 * of the next section instead of a dead end.
 */
export function flattenKbNav(nav: KbNavSection[]): KbNavEntry[] {
  return nav.flatMap((section) => section.entries);
}

/**
 * What comes before and after an entry in the reading order.
 *
 * Link entries take part: a member walking the onboarding path passes through
 * `/first-class` in the place a manager put it, rather than the order skipping
 * whatever is not stored here.
 */
export function adjacentEntries(
  nav: KbNavSection[],
  slug: string,
): { previous: KbNavEntry | null; next: KbNavEntry | null } {
  const flat = flattenKbNav(nav);
  const index = flat.findIndex((entry) => entry.slug === slug);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: flat[index - 1] ?? null,
    next: flat[index + 1] ?? null,
  };
}

/** The entry and the section it sits in, for a breadcrumb trail. */
export function entryBreadcrumbs(
  nav: KbNavSection[],
  slug: string,
): { section: KbNavSection | null; entry: KbNavEntry } | null {
  for (const section of nav) {
    const entry = section.entries.find((e) => e.slug === slug);
    if (entry) return { section, entry };
  }
  return null;
}

/**
 * Whether an entry counts towards reading progress at all.
 *
 * A LINK ENTRY does not. It points at a page on the marketing site, which has no
 * way to report back that somebody read it, so counting one would put a tick
 * nobody can ever earn in the denominator and leave "9 of 10" as the best a
 * member could do.
 */
export function countsTowardsProgress(entry: KbNavEntry): boolean {
  return !entry.link_path;
}

/** How an entry stands with this reader. */
export type ReadState = "unread" | "read" | "updated";

/**
 * Whether the reader has read an entry, and whether it has changed since.
 *
 * "updated" is the state worth having: a policy rewritten after somebody read
 * it is exactly the thing they need told, and a plain tick would quietly claim
 * they had read wording that did not exist when they did.
 */
export function readState(entry: KbNavEntry): ReadState {
  if (!countsTowardsProgress(entry) || entry.read_version == null) return "unread";
  if (entry.version != null && entry.read_version < entry.version) return "updated";
  return "read";
}

export type KbProgress = {
  /** Entries this reader has finished, on the wording that is live now. */
  read: number;
  /** Entries there are to read. Link entries are not among them. */
  total: number;
  /** Read once, but rewritten since. Counted apart from `read`. */
  updated: number;
  /**
   * Where to carry on: the first entry in READING ORDER that is unread or has
   * changed since it was read.
   *
   * Reading order rather than "most recently opened", because the order is the
   * onboarding path a manager set. Somebody who dipped into the syllabus should
   * still be sent back to the thing that comes next, not forward from wherever
   * they happened to land.
   */
  next: KbNavEntry | null;
};

/** How far through the knowledge base this reader is. */
export function kbProgress(nav: KbNavSection[]): KbProgress {
  const entries = flattenKbNav(nav).filter(countsTowardsProgress);
  const states = entries.map((entry) => ({ entry, state: readState(entry) }));
  return {
    read: states.filter((s) => s.state === "read").length,
    total: entries.length,
    updated: states.filter((s) => s.state === "updated").length,
    next: states.find((s) => s.state !== "read")?.entry ?? null,
  };
}

/** One heading inside an article, for the "On this page" list. */
export type KbHeading = {
  /** 1 for `#`, 2 for `##`, and so on. */
  depth: number;
  text: string;
  /** The `id` to link to, unique within the article. */
  id: string;
  /**
   * Whether the author pinned this id with `{#an-anchor}` rather than letting it
   * fall out of the wording. Shown to managers, because a pinned anchor is the
   * one that survives rewording the heading.
   */
  pinned: boolean;
  /** The `kb.ts` block this heading opens, so the reader can hang the id on it. */
  blockId: string;
};

/**
 * A URL fragment for a heading: lowercase, words joined by hyphens.
 *
 * Readable rather than hashed, because it ends up in the address bar when
 * somebody shares a link to one section of the syllabus. Non-ASCII text that
 * reduces to nothing falls back to "section" so the id is never empty.
 */
export function headingSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * The anchor a heading pins for itself, and the heading text without it.
 *
 * `## Grading {#grading}` is the attribute syntax Pandoc, Docusaurus and
 * markdown-it-attrs all spell the same way, which is as close to idiomatic as
 * Markdown gets for this: the heading still reads as a heading everywhere else,
 * and anything that does not understand the suffix shows it rather than losing
 * the heading.
 *
 * It exists because the id a heading gets otherwise is its own wording, so
 * rewording "Grading" to "How grading works" silently breaks every link another
 * article aimed at it. A pinned anchor is the author saying "other pages point
 * here", and it survives the rewrite.
 *
 * The id is put through `headingSlug` rather than taken literally, so there is
 * one id vocabulary and an anchor can never carry a space or a `#` into a URL.
 * A heading that is NOTHING but an anchor (`## {#x}`) is left alone: stripping
 * it would leave an empty heading, so the braces are treated as the text.
 */
export function splitHeadingAnchor(text: string): { text: string; anchor: string | null } {
  const match = /^(.*?)[ \t]*\{#([^{}\s]+)\}[ \t]*$/.exec(text);
  if (!match || !match[1].trim()) return { text, anchor: null };
  return { text: match[1], anchor: headingSlug(match[2]) };
}

/**
 * Read a heading off the start of a block, with the inline markdown stripped.
 *
 * `## The **blue** belt` is the heading "The blue belt": the emphasis is styling,
 * and carrying it into a table of contents or a URL fragment helps nobody.
 * Returns null for anything that is not an ATX heading, fenced code included —
 * a ``` block never reaches here as a heading because `splitBlocks` keeps it
 * whole and its first line is a fence, not a `#`.
 */
/** What `parseHeading` reads off a heading line. */
type Heading = { depth: number; text: string; anchor: string | null };

export function parseHeading(blockMarkdown: string): Heading | null {
  const firstLine = blockMarkdown.split("\n", 1)[0] ?? "";
  const match = /^ {0,3}(#{1,6})\s+(.*)$/.exec(firstLine);
  if (!match) return null;
  // The pinned anchor comes off BEFORE the inline markdown is stripped, so a
  // `{#id}` is never mistaken for part of a link or a code span, and what is
  // left is the heading a reader sees.
  const withoutAnchor = splitHeadingAnchor(match[2].replace(/\s+#+\s*$/, ""));
  const text = stripInlineMarkdown(withoutAnchor.text).trim();
  if (!text) return null;
  return { depth: match[1].length, text, anchor: withoutAnchor.anchor };
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images -> their text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\s+/g, " ");
}

/**
 * Every heading in an article, in order, with a unique id each.
 *
 * Built on `splitBlocks` rather than a fresh scan of the source so it inherits
 * that function's fence handling: a `# comment` inside a code sample is code,
 * and listing it as a section of the article would be wrong twice over (a
 * heading nobody wrote, linking to an anchor that is not there).
 *
 * Two headings with the same words get `-2`, `-3` suffixes, so "Grading" under
 * two different belts still gives two working links.
 */
export function extractHeadings(markdown: string): KbHeading[] {
  const parsed: { heading: Heading; blockId: string }[] = [];
  for (const block of splitBlocks(markdown)) {
    const heading = parseHeading(block.markdown);
    if (heading) parsed.push({ heading, blockId: block.id });
  }

  // Uniqueness is checked against every id ALREADY TAKEN, not against a
  // per-base counter. A counter alone collides with a heading that ends in a
  // number the author wrote: "Grading", "Grading 2", "Grading" would mint
  // `grading`, `grading-2`, and `grading-2` again, which puts two links in the
  // contents list pointing at the same place and two elements in the document
  // sharing an id.
  const used = new Set<string>();

  // PINNED ANCHORS ARE ALLOCATED FIRST, before anything derived from wording.
  // A pinned anchor is the author saying "other articles point here", so it has
  // to win: in document order a later heading whose words happen to slugify to
  // `grading` would otherwise take that id and push the pinned one to
  // `grading-2`, silently re-aiming every cross-reference in the club at the
  // wrong passage. Two headings pinned to the SAME anchor still fall back to
  // the suffix — that is an article contradicting itself, and the first one
  // wins.
  const take = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const ids: (string | undefined)[] = parsed.map(({ heading }) =>
    heading.anchor === null ? undefined : take(heading.anchor),
  );

  const headings: KbHeading[] = [];
  parsed.forEach(({ heading, blockId }, index) => {
    const id = ids[index] ?? take(headingSlug(heading.text));
    headings.push({
      depth: heading.depth,
      text: heading.text,
      id,
      pinned: heading.anchor !== null,
      blockId,
    });
  });
  return headings;
}

/**
 * The heading a URL fragment points at, or null when nothing in the article
 * answers to it.
 *
 * Null is a state the reader has to SHOW rather than ignore. A cross-reference
 * from another article is a link somebody wrote by hand months ago, against
 * wording that may since have been rewritten; landing silently at the top of a
 * long syllabus looks exactly like the link having worked, and the reader hunts
 * for a section that is no longer called that.
 *
 * The fragment is decoded first, so a heading with a percent-encoded character
 * in its id still matches, and a malformed escape is treated as no match rather
 * than throwing on a page that was only trying to scroll.
 */
export function findHeadingForHash(hash: string, headings: KbHeading[]): KbHeading | null {
  // Matched case-insensitively. Every id `headingSlug` mints is lowercase, so
  // this makes nothing ambiguous — but a cross-reference typed by eye, copying
  // the heading's own capitals ("#Grading"), would otherwise miss a section
  // that is right there and be reported as renamed away.
  const id = decodeFragment(hash).toLowerCase();
  if (!id) return null;
  return headings.find((heading) => heading.id === id) ?? null;
}

/** A URL fragment with its `#` and its percent-encoding taken off. */
function decodeFragment(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding, so it is used exactly as it arrived.
    return raw;
  }
}

/**
 * Fragments this app mints for something that is NOT a section of an article.
 *
 * A notification about a comment links to `/kb/<slug>#comment-<id>`
 * (`kbAnnotationHref`), which is an ordinary, working link — telling somebody
 * who followed one that a section has been renamed away would be both wrong and
 * alarming.
 */
const NOT_A_SECTION = /^comment-/;

/**
 * The fragment to tell the reader about, when a link named a section this
 * article does not have. Null when there is nothing worth saying.
 *
 * Only a fragment SHAPED like an anchor is worth a message: ids are words and
 * hyphens, so anything carrying `=` or `&` came from somewhere else entirely
 * (an auth callback's `#error=...`, a tracking parameter) and is not a broken
 * cross-reference. Truncated because the fragment is shown back on screen and a
 * hand-typed novel in the address bar must not push the article off it.
 */
export function missingSectionFragment(hash: string, headings: KbHeading[]): string | null {
  const id = decodeFragment(hash);
  if (!id || findHeadingForHash(hash, headings)) return null;
  if (NOT_A_SECTION.test(id) || !/^[A-Za-z0-9-]+$/.test(id)) return null;
  return id.length > 60 ? `${id.slice(0, 59)}…` : id;
}
