// What a link preview shows: the part of an article a link points at.
//
// The knowledge base is read like a handbook. The syllabus names "advanced body
// grab" and links to where it is described, and a member reading the syllabus
// wants to know what that is without losing their place in a long page. So
// hovering a link (or tapping it once on a phone) shows a small card with the
// passage it points at, the way Quartz and Obsidian do.
//
// Pure and server-free so the one judgement in it, which passage a link means,
// is tested directly rather than through a rendered card.
import { splitBlocks } from "@/lib/kb";
import { extractHeadings, findHeadingForHash, missingSectionFragment } from "@/lib/kb-nav";

/**
 * How much of the passage the card shows before it stops and says there is
 * more. A preview is a glance, not a second reader: a whole belt's worth of
 * syllabus in a 20rem card would be a scrolling box inside a scrolling page,
 * which is the worst way to read anything on a phone.
 */
export const PREVIEW_MAX_BLOCKS = 5;
export const PREVIEW_MAX_CHARS = 700;

export type KbPreview = {
  /** The heading the link named, or null when it pointed at the whole article. */
  heading: string | null;
  /** The markdown to show, with the heading itself taken off (the card titles it). */
  markdown: string;
  /** Whether there is more of the passage than the card shows. */
  truncated: boolean;
  /**
   * The fragment the link asked for when the article has no such section any
   * more. The card then shows the start of the article and says so, the same
   * honesty the reader page has about a renamed heading.
   */
  missingSection: string | null;
};

/**
 * The passage a link to `bodyMd` (optionally with `#hash`) points at.
 *
 * A link to a section shows that section: from its heading down to the next
 * heading at the same depth or shallower, so a `##` belt includes its own `###`
 * techniques and stops at the next belt. A link to the article shows its start.
 */
export function articlePreview(bodyMd: string, hash?: string): KbPreview {
  const blocks = splitBlocks(bodyMd);
  const headings = extractHeadings(bodyMd);
  const fragment = hash ? `#${hash.replace(/^#/, "")}` : "";
  const target = fragment ? findHeadingForHash(fragment, headings) : null;

  let start = 0;
  let end = blocks.length;
  if (target) {
    const blockIndex = new Map(blocks.map((block) => [block.id, block.index]));
    const headingIndex = blockIndex.get(target.blockId) ?? 0;
    // Start AFTER the heading block: the card already titles itself with it.
    start = headingIndex + 1;
    const nextHeading = headings.find(
      (heading) =>
        (blockIndex.get(heading.blockId) ?? 0) > headingIndex && heading.depth <= target.depth,
    );
    if (nextHeading) end = blockIndex.get(nextHeading.blockId) ?? end;
  }

  const passage = blocks.slice(start, end);
  const shown: string[] = [];
  let chars = 0;
  for (const block of passage) {
    // The first block always goes in, however long: an empty card for a
    // passage that opens with one long paragraph would be the preview failing
    // at the only thing it is for. After that, a block goes in only if it
    // fits, so one long one cannot carry the card far past the budget.
    if (shown.length > 0) {
      if (shown.length >= PREVIEW_MAX_BLOCKS) break;
      if (chars + block.markdown.length > PREVIEW_MAX_CHARS) break;
    }
    shown.push(block.markdown);
    chars += block.markdown.length;
  }

  return {
    heading: target?.text ?? null,
    markdown: shown.join("\n\n"),
    truncated: shown.length < passage.length,
    missingSection: fragment ? missingSectionFragment(fragment, headings) : null,
  };
}

/**
 * The article slug a link body points at, when it is a knowledge base article.
 *
 * Only `/kb/<slug>` exactly. `/kb` itself is the index, and anything deeper is
 * not an article route, so neither gets a preview.
 */
export function kbArticleSlug(path: string): string | null {
  const match = /^\/kb\/([^/?#]+)\/?$/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
