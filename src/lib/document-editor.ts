// Decisions the manager's document editor makes, kept out of the component so
// they are unit-testable — the same split `waiver-template-editor.ts` uses, for
// the same reason. No React, no toasts, no server calls.
import type { DocumentVisibility } from "./documents";

/** What the editor holds right now, and what a stored version holds. */
export type DocumentDraft = {
  title: string;
  body_md: string;
  visibility: DocumentVisibility;
  annotations_enabled: boolean;
};

/**
 * Whether the editor holds changes a save would keep.
 *
 * `change_note` is deliberately NOT part of this: it describes a save rather
 * than being part of the document, so a note typed against an otherwise
 * unchanged body is not an edit worth warning about losing.
 */
export function isDocumentDirty(draft: DocumentDraft, stored: DocumentDraft | null): boolean {
  if (!stored) return false;
  return (
    draft.title !== stored.title ||
    draft.body_md !== stored.body_md ||
    draft.visibility !== stored.visibility ||
    draft.annotations_enabled !== stored.annotations_enabled
  );
}

/** What a manager is warned about before a save that changes who can read it. */
export type VisibilityChange = { from: DocumentVisibility; to: DocumentVisibility } | null;

/**
 * The visibility change a save would make, when it is one worth confirming.
 *
 * Only WIDENING is flagged. Narrowing (public → members, members → managers)
 * takes a document away from people who could read it, which is recoverable and
 * unsurprising. Widening publishes text to an audience that could not see it a
 * moment ago, and for a document that has been sitting at `managers` while it
 * was drafted, that is the one click nobody should make by accident.
 */
const REACH: Record<DocumentVisibility, number> = { managers: 0, members: 1, public: 2 };

export function wideningVisibility(
  stored: DocumentVisibility | null,
  next: DocumentVisibility,
): VisibilityChange {
  if (!stored || stored === next) return null;
  return REACH[next] > REACH[stored] ? { from: stored, to: next } : null;
}

/**
 * A slug proposed from a title, so a manager creating a document does not have
 * to invent one. Mirrors the `documents.slug` CHECK: lowercase, digits, single
 * hyphens, no leading or trailing hyphen.
 *
 * Returns "" when the title has nothing usable in it (all punctuation, or a
 * script this cannot transliterate), which the form treats as "you type it" —
 * better than proposing a slug like `--` that the database would reject.
 */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}
