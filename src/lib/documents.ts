// Pure, side-effect-free logic for club documents and their annotations.
//
// Everything here runs identically in the browser (the reader renders blocks and
// groups threads) and on the server (annotations are stored against a block id
// computed the same way), which is the whole reason it is a separate module: an
// anchor computed one way at write time and another way at read time is an
// annotation that silently detaches from the passage it was about.
//
// No server imports, no Supabase, no React — see src/lib/validation.ts for the
// same rule and the same reason.

/** Who may read a document. */
export const documentVisibilities = ["public", "members", "managers"] as const;
export type DocumentVisibility = (typeof documentVisibilities)[number];

/** A private note, or a comment thread everyone who can read the document sees. */
export const annotationVisibilities = ["private", "shared"] as const;
export type AnnotationVisibility = (typeof annotationVisibilities)[number];

/** One addressable passage of a document. */
export type DocumentBlock = {
  /** Content-derived anchor (see `blockId`). Stable across edits elsewhere. */
  id: string;
  /** 0-based position in the rendered document. Presentation only, never an anchor. */
  index: number;
  /** The block's markdown, exactly as written. */
  markdown: string;
};

/**
 * The document text a block id is derived from, with insignificant differences
 * removed: leading/trailing space, and runs of whitespace (including the line
 * breaks inside a wrapped paragraph) collapsed to one space.
 *
 * Deliberately NOT lowercased. Case is meaning in prose, and two blocks that
 * differ only in case are two different sentences; a capitalisation fix should
 * show up as "the passage this comment was about has changed", which is what the
 * quote fallback in `resolveAnchors` reports. Reflowing a paragraph should not.
 */
export function normalizeBlockText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A 64-bit FNV-1a digest as 16 hex characters, computed as two independent
 * 32-bit passes with different offset bases.
 *
 * Hand-rolled rather than `crypto.subtle.digest` because block ids are computed
 * during render, and every Web Crypto digest is async — a synchronous hash keeps
 * `splitBlocks` a plain function. This is an anchor key, never a security
 * boundary: nothing is authenticated or authorised by it.
 */
function fnv1a(text: string, offset: number): number {
  let hash = offset;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // hash * 16777619, kept in 32-bit unsigned range without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hashText(text: string): string {
  const a = fnv1a(text, 0x811c9dc5);
  const b = fnv1a(text, 0x9e3779b1);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * The anchor for a block, derived from its TEXT and not its position.
 *
 * Position would be the obvious key and is the wrong one: inserting a paragraph
 * at the top of a policy would renumber every block below it, silently moving
 * every comment down one passage. Content-derived ids mean an edit only detaches
 * the annotations on the passage that actually changed.
 *
 * `ordinal` disambiguates genuinely identical blocks (two "N/A" lines, a
 * repeated heading): the first occurrence is the bare hash, later ones are
 * suffixed. Only the repeated block's own anchors move when one is added or
 * removed, and the quote fallback in `resolveAnchors` recovers those.
 */
export function blockId(text: string, ordinal = 0): string {
  const hash = hashText(normalizeBlockText(text));
  return ordinal === 0 ? hash : `${hash}.${ordinal}`;
}

/**
 * Split markdown into the blocks a reader can annotate: paragraphs, headings,
 * list groups, tables, block quotes, and fenced code blocks.
 *
 * Blank lines are the separator, with one exception that matters: a blank line
 * INSIDE a fenced code block is part of the code, not a break between blocks.
 * Splitting there would both mangle the rendering and mint anchors for fragments
 * of a code sample.
 *
 * This is deliberately a source-level split rather than a real markdown parse.
 * The reader renders each block with `react-markdown` independently, so the
 * split has to land on boundaries where that is safe — which top-level blank
 * lines are, and mid-construct positions are not.
 */
export function splitBlocks(markdown: string): DocumentBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) chunks.push(text);
    current = [];
  };

  for (const line of lines) {
    // ``` or ~~~, optionally indented, optionally with a language tag. A fence
    // closes only on the same marker it opened with, so a ``` inside a ~~~ block
    // is content.
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      current.push(line);
      continue;
    }
    if (fence === null && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  // Assign ordinals across identical blocks so repeated text still gets unique
  // anchors (see `blockId`).
  const seen = new Map<string, number>();
  return chunks.map((markdownChunk, index) => {
    const key = normalizeBlockText(markdownChunk);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { id: blockId(markdownChunk, ordinal), index, markdown: markdownChunk };
  });
}

/** The parts of an annotation that say where it hangs. */
export type AnnotationAnchor = {
  block_id: string | null;
  quote: string | null;
};

export type AnchorResolution<A extends AnnotationAnchor> = {
  /** Block id -> the annotations on it, in the order given. */
  anchored: Map<string, A[]>;
  /** `block_id === null`: notes about the document as a whole. */
  document: A[];
  /**
   * Written against a passage that is no longer in the document. Shown apart
   * rather than dropped: a comment on a clause that was deleted or rewritten is
   * usually the most interesting comment on the page.
   */
  orphaned: A[];
};

/**
 * Work out where each annotation belongs in the document as it stands now.
 *
 * Two passes, in this order:
 *
 *   1. Exact `block_id`. The normal case, and free.
 *   2. The stored `quote`, matched against block text. This rescues the one
 *      routine way an id moves without the passage changing: a repeated block
 *      being added or removed shifts the ORDINAL of every later copy (see
 *      `blockId`), so the text is untouched but the id is not.
 *
 * Anything still unmatched is orphaned. Nothing is ever re-anchored by
 * proximity or position: attaching a comment to a paragraph its author never
 * read is worse than admitting the passage is gone.
 */
export function resolveAnchors<A extends AnnotationAnchor>(
  blocks: DocumentBlock[],
  annotations: A[],
): AnchorResolution<A> {
  const blockIds = new Set(blocks.map((b) => b.id));
  // First block with a given normalized text wins a quote match.
  const byText = new Map<string, string>();
  for (const block of blocks) {
    const key = normalizeBlockText(block.markdown);
    if (!byText.has(key)) byText.set(key, block.id);
  }

  const anchored = new Map<string, A[]>();
  const document: A[] = [];
  const orphaned: A[] = [];

  const push = (id: string, annotation: A) => {
    const list = anchored.get(id);
    if (list) list.push(annotation);
    else anchored.set(id, [annotation]);
  };

  for (const annotation of annotations) {
    if (!annotation.block_id) {
      document.push(annotation);
      continue;
    }
    if (blockIds.has(annotation.block_id)) {
      push(annotation.block_id, annotation);
      continue;
    }
    const requoted = annotation.quote
      ? byText.get(normalizeBlockText(annotation.quote))
      : undefined;
    if (requoted) {
      push(requoted, annotation);
      continue;
    }
    orphaned.push(annotation);
  }

  return { anchored, document, orphaned };
}

/** A root annotation with its replies. */
export type Thread<A> = { root: A; replies: A[] };

type Threadable = { id: string; parent_id: string | null; created_at?: string | null };

/**
 * Group a flat annotation list into threads: roots in the order given, each
 * with its replies oldest-first.
 *
 * A reply whose parent is missing is promoted to a root rather than dropped.
 * The schema cascades replies when a parent is deleted, so this should not
 * happen — but a filtered read (a private parent, a page that fetched only part
 * of the document) could produce it, and silently swallowing somebody's comment
 * is the one outcome worth ruling out.
 */
export function groupThreads<A extends Threadable>(annotations: A[]): Thread<A>[] {
  const byId = new Set(annotations.map((a) => a.id));
  const repliesByParent = new Map<string, A[]>();
  const roots: A[] = [];

  for (const annotation of annotations) {
    if (annotation.parent_id && byId.has(annotation.parent_id)) {
      const list = repliesByParent.get(annotation.parent_id);
      if (list) list.push(annotation);
      else repliesByParent.set(annotation.parent_id, [annotation]);
    } else {
      roots.push(annotation);
    }
  }

  return roots.map((root) => ({
    root,
    replies: (repliesByParent.get(root.id) ?? []).sort((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    ),
  }));
}

/** Who is asking. `userId` is null for a signed-out visitor. */
export type Viewer = { userId: string | null; isManager: boolean };

/**
 * Whether this viewer may read a document at all.
 *
 * The server functions and the manager agent endpoint both call this rather than
 * writing the comparison out, so "who can see a draft" has exactly one answer.
 */
export function canReadDocument(visibility: DocumentVisibility, viewer: Viewer): boolean {
  if (viewer.isManager) return true;
  if (visibility === "public") return true;
  if (visibility === "members") return Boolean(viewer.userId);
  return false;
}

/**
 * Whether this viewer may annotate it. Stricter than reading on purpose: a
 * public document is readable signed-out, but every annotation belongs to a
 * person, so annotating always needs a login.
 */
export function canAnnotate(
  doc: { visibility: DocumentVisibility; annotations_enabled: boolean },
  viewer: Viewer,
): boolean {
  if (!viewer.userId) return false;
  if (!doc.annotations_enabled) return false;
  return canReadDocument(doc.visibility, viewer);
}

/**
 * Editing and deleting are the AUTHOR's alone — managers included.
 *
 * A manager can moderate a thread (see `canResolveThread`) and can delete the
 * whole document, but rewriting the words attributed to somebody else is not
 * moderation, and a comment feature people cannot trust that way is one they
 * stop using honestly.
 */
export function canEditAnnotation(annotation: { user_id: string }, viewer: Viewer): boolean {
  return Boolean(viewer.userId) && annotation.user_id === viewer.userId;
}

/** Resolving a shared thread: its author, or a manager moderating. */
export function canResolveThread(
  annotation: { user_id: string; visibility: AnnotationVisibility },
  viewer: Viewer,
): boolean {
  if (annotation.visibility !== "shared") return false;
  if (viewer.isManager) return true;
  return canEditAnnotation(annotation, viewer);
}
