// Rendering a blog post's body: Markdown text (react-markdown, same as the
// waiver template) interleaved with `[[video:<url>]]` lines, each its own
// block so the renderer swaps a video line for an embedded player instead of
// feeding it to the Markdown renderer. See docs/blog.md.

export type BlogContentBlock = { type: "markdown"; text: string } | { type: "video"; url: string };

const VIDEO_LINE = /^\[\[video:(.+)\]\]$/;

/**
 * Split a post body into Markdown and video blocks, in order. Consecutive
 * non-video lines are grouped into a single Markdown block, so a paragraph
 * that happens to sit next to a video embed still renders as one block.
 */
export function splitBlogContent(bodyMd: string): BlogContentBlock[] {
  const lines = bodyMd.split("\n");
  const blocks: BlogContentBlock[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      blocks.push({ type: "markdown", text: buffer.join("\n") });
      buffer = [];
    }
  };
  for (const line of lines) {
    const m = VIDEO_LINE.exec(line.trim());
    if (m) {
      flush();
      blocks.push({ type: "video", url: m[1].trim() });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

/** How long a derived excerpt runs before it is cut at a word boundary. The
 * excerpt doubles as the post page's meta description, so this is sized for a
 * search result rather than for the blog list, which has room for more. */
export const EXCERPT_MAX_LENGTH = 200;

/**
 * Strip the inline Markdown out of one line, leaving the words a reader sees.
 *
 * Images go entirely (their alt text describes a picture, not the post), links
 * keep their label and lose their URL, and emphasis/code markers are dropped.
 * A lone `_` is only removed at a word boundary, so `snake_case` survives while
 * `_italic_` doesn't.
 */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/~~/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\*/g, "")
    .replace(/(^|\s)_(\S)/g, "$1$2")
    .replace(/(\S)_(\s|$)/g, "$1$2");
}

/**
 * The prose of a Markdown block as one line of plain text.
 *
 * Headings are dropped rather than flattened in: they restate the title or
 * label a section, and neither reads as the opening of the post. Fenced code,
 * horizontal rules and table rows go for the same reason. Blockquote and list
 * markers are stripped but their text is kept.
 */
function proseFromMarkdown(markdown: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line)) continue;
    if (line.startsWith("|")) continue;
    const text = stripInlineMarkdown(
      line.replace(/^>\s?/, "").replace(/^([-*+]|\d+[.)])\s+/, ""),
    ).trim();
    if (text) kept.push(text);
  }
  return kept.join(" ");
}

/**
 * A one-line summary of a post, for when the manager leaves the excerpt blank.
 *
 * Returns "" when there is nothing to summarise — an empty body, or one made
 * only of videos, images and headings — which callers treat as "no excerpt"
 * rather than storing a blank string.
 */
export function deriveExcerpt(bodyMd: string, maxLength: number = EXCERPT_MAX_LENGTH): string {
  const text = splitBlogContent(bodyMd)
    .filter((block) => block.type === "markdown")
    .map((block) => proseFromMarkdown(block.text))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const head = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.!?-]+$/, "");
  return `${head}…`;
}

/**
 * Extract a YouTube video id from a watch/share/embed/shorts URL. Null for
 * anything else (including a well-formed link to another provider) — the
 * caller falls back to a plain "watch the video" link for those.
 */
export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1) || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const embedMatch = /^\/(?:embed|shorts)\/([^/]+)/.exec(u.pathname);
      if (embedMatch) return embedMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}
