// A remark plugin that takes a pinned anchor off a heading before it is shown.
//
// `## Grading {#grading}` gives the heading a stable id another article can link
// to (see `splitHeadingAnchor` in `kb-nav.ts` for why that syntax). The id is
// plumbing, not prose: a member reading the syllabus should see "Grading", not
// "Grading {#grading}".
//
// It lives in `kbRemarkPlugins` rather than being stripped by each caller, for
// the same reason the table plugin does: the reader renders one block at a time
// and the manager's preview renders a whole body, and a suffix that disappears
// in one but not the other is a difference nobody notices until a manager
// publishes an article with the plumbing showing.
//
// Stripping only. The id itself is NOT set here, because the reader renders each
// block through its own `react-markdown` pass: a plugin has no way to see the
// headings in the rest of the article, so it could not tell a second "Grading"
// from the first. `extractHeadings` does that once over the whole body, and the
// reader hangs the id it produces on the block.
import type { Heading, Root, RootContent } from "mdast";
import { splitHeadingAnchor } from "@/lib/kb-nav";

/** Every node in the tree that is a heading, however deeply it is nested. */
function headings(nodes: RootContent[]): Heading[] {
  const found: Heading[] = [];
  for (const node of nodes) {
    if (node.type === "heading") found.push(node);
    // A heading can sit inside a blockquote or a list item, and one written
    // there carries an anchor just as usefully as one at the top level.
    if ("children" in node && Array.isArray(node.children)) {
      found.push(...headings(node.children as RootContent[]));
    }
  }
  return found;
}

/** A text node that is nothing but the anchor, e.g. the ` {#blue}` after emphasis. */
const ONLY_ANCHOR = /^[ \t]*\{#[^{}\s]+\}[ \t]*$/;

export function remarkKbAnchors() {
  return (tree: Root) => {
    for (const heading of headings(tree.children)) {
      const last = heading.children.at(-1);
      // The anchor is the last thing on the line, so it is always in the final
      // text node — either at the end of it (`## Grading {#grading}`) or as the
      // whole of it, when the heading ends in emphasis or a link
      // (`## The **blue** belt {#blue}` splits the anchor into a node of its own).
      if (!last || last.type !== "text") continue;

      if (heading.children.length > 1 && ONLY_ANCHOR.test(last.value)) {
        heading.children.pop();
        const previous = heading.children.at(-1);
        if (previous?.type === "text") previous.value = previous.value.replace(/[ \t]+$/, "");
        continue;
      }

      const { text, anchor } = splitHeadingAnchor(last.value);
      // `splitHeadingAnchor` leaves a heading that is NOTHING but an anchor
      // alone, so this never empties a heading of its text.
      if (anchor === null) continue;
      last.value = text.replace(/[ \t]+$/, "");
    }
  };
}
