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
 */
export function buildKbNav(sections: KbSectionInput[], entries: KbEntryInput[]): KbNavSection[] {
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
    .filter((section) => section.entries.length > 0);

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

/** One heading inside an article, for the "On this page" list. */
export type KbHeading = {
  /** 1 for `#`, 2 for `##`, and so on. */
  depth: number;
  text: string;
  /** The `id` to link to, unique within the article. */
  id: string;
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
 * Read a heading off the start of a block, with the inline markdown stripped.
 *
 * `## The **blue** belt` is the heading "The blue belt": the emphasis is styling,
 * and carrying it into a table of contents or a URL fragment helps nobody.
 * Returns null for anything that is not an ATX heading, fenced code included —
 * a ``` block never reaches here as a heading because `splitBlocks` keeps it
 * whole and its first line is a fence, not a `#`.
 */
export function parseHeading(blockMarkdown: string): { depth: number; text: string } | null {
  const firstLine = blockMarkdown.split("\n", 1)[0] ?? "";
  const match = /^ {0,3}(#{1,6})\s+(.*)$/.exec(firstLine);
  if (!match) return null;
  const text = stripInlineMarkdown(match[2].replace(/\s+#+\s*$/, "")).trim();
  if (!text) return null;
  return { depth: match[1].length, text };
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
  // Uniqueness is checked against every id ALREADY EMITTED, not against a
  // per-base counter. A counter alone collides with a heading that ends in a
  // number the author wrote: "Grading", "Grading 2", "Grading" would mint
  // `grading`, `grading-2`, and `grading-2` again, which puts two links in the
  // contents list pointing at the same place and two elements in the document
  // sharing an id.
  const used = new Set<string>();
  const headings: KbHeading[] = [];

  for (const block of splitBlocks(markdown)) {
    const heading = parseHeading(block.markdown);
    if (!heading) continue;
    const base = headingSlug(heading.text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    headings.push({ depth: heading.depth, text: heading.text, id, blockId: block.id });
  }
  return headings;
}
