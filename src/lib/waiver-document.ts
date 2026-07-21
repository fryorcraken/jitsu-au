/**
 * Pure helpers for rendering a waiver as HTML (see
 * `src/components/site/WaiverDocument.tsx`). Kept server-import-free and
 * side-effect-free so they stay unit-testable.
 */

export type WaiverBlock =
  | { kind: "hr" }
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string };

/**
 * Parse the template body the same way the PDF renderer does
 * (`src/lib/waiver-pdf.ts`): split on blank lines, then recognise `---`, `# `,
 * `## `, and plain paragraphs. Single newlines inside a paragraph collapse to
 * spaces, matching the PDF.
 */
export function parseWaiverBlocks(body: string): WaiverBlock[] {
  const blocks: WaiverBlock[] = [];
  for (const raw of body.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (block === "---") {
      blocks.push({ kind: "hr" });
    } else if (block.startsWith("# ")) {
      blocks.push({ kind: "h1", text: block.slice(2) });
    } else if (block.startsWith("## ")) {
      blocks.push({ kind: "h2", text: block.slice(3) });
    } else {
      blocks.push({ kind: "p", text: block.replace(/\n/g, " ") });
    }
  }
  return blocks;
}
