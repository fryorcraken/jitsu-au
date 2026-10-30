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

  let passage: string[];
  if (!target) {
    passage = blocks.map((block) => block.markdown);
  } else {
    const blockIndex = new Map(blocks.map((block) => [block.id, block.index]));
    const headingIndex = blockIndex.get(target.blockId) ?? 0;
    const nextHeading = headings.find(
      (heading) =>
        (blockIndex.get(heading.blockId) ?? 0) > headingIndex && heading.depth <= target.depth,
    );
    const end = nextHeading
      ? (blockIndex.get(nextHeading.blockId) ?? blocks.length)
      : blocks.length;

    // The heading LINE comes off, not the heading's whole block: the card
    // already titles itself with it. A block is whatever sits between blank
    // lines, and a list written straight under its heading with no blank line
    // between them is one block with the heading:
    //
    //   ### Open hand
    //   - Palm heel jab and cross
    //
    // Most of the club's technique lists are written that way. Dropping the
    // whole block showed "nothing is written under this heading" for every one.
    const { text, endsSection } = sectionStart(
      blocks[headingIndex].markdown.replace(/^[^\n]*\n?/, ""),
      target.depth,
    );
    passage = [
      ...(text ? [text] : []),
      // A sibling heading packed into the same block ends the section there,
      // so nothing after the block belongs to it either.
      ...(endsSection ? [] : blocks.slice(headingIndex + 1, end).map((block) => block.markdown)),
    ];
  }

  const shown: string[] = [];
  let chars = 0;
  for (const markdown of passage) {
    // The first block always goes in, however long: an empty card for a
    // passage that opens with one long paragraph would be the preview failing
    // at the only thing it is for. After that, a block goes in only if it
    // fits, so one long one cannot carry the card far past the budget.
    if (shown.length > 0) {
      if (shown.length >= PREVIEW_MAX_BLOCKS) break;
      if (chars + markdown.length > PREVIEW_MAX_CHARS) break;
    }
    shown.push(markdown);
    chars += markdown.length;
  }

  return {
    heading: target?.text ?? null,
    markdown: shown.join("\n\n"),
    truncated: shown.length < passage.length,
    missingSection: fragment ? missingSectionFragment(fragment, headings) : null,
  };
}

/**
 * What follows a heading's own line inside its block, cut at a heading of the
 * same depth or shallower if one is packed in there too.
 *
 * `extractHeadings` only sees a heading that opens a block, so a sibling
 * written with no blank line above it (`- Palm\n### Closed fists`) is not a
 * boundary it knows about, and the card would run on into the next section.
 * Lines inside a code fence are code, not headings.
 *
 * Only blank lines come off the ends. A plain `.trim()` would strip the indent
 * from an indented code block on the first line and turn it into a paragraph,
 * the same reason `splitBlocks` does not use one.
 */
function sectionStart(rest: string, depth: number): { text: string; endsSection: boolean } {
  const lines = rest.split("\n");
  let fence: string | null = null;
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}(#{1,6})\s/.exec(lines[i]);
    if (heading && heading[1].length <= depth) {
      cut = i;
      break;
    }
  }
  const text = lines
    .slice(0, cut)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
  return { text: text.trim() ? text : "", endsSection: cut < lines.length };
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
