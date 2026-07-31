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
