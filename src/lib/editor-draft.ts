// Never lose what somebody typed.
//
// The waiver already had this (`waiver-draft.ts`): it keeps a half-filled form
// on the device so a reload, a crash, or a phone backgrounding the page long
// enough to be evicted does not cost twenty fields and a signature. Every other
// place in this app where somebody writes at length had nothing — a blog post, a
// knowledge base article, the waiver template itself. All three are Markdown
// somebody may sit with for half an hour, and all three lived only in React
// state.
//
// A manager lost a finished blog draft to exactly that: they left the installed
// app, the phone reclaimed it, and coming back relaunched the app from scratch
// with an empty editor. `beforeunload` is the guard the composer had, and it is
// no guard at all here — iOS ignores it outright, and an app the system kills in
// the background never gets the chance to fire it.
//
// So this is the third occurrence, and the shape worth having in one place. The
// waiver keeps its own module: its draft is one specific form with a typed
// shape, health answers and a signature image, and folding it in here would make
// both worse.
//
// **localStorage, not the sessionStorage the waiver uses.** The two are storing
// different things for different people. The waiver holds a stranger's health
// answers and signature on a phone that might be borrowed at the door, and it
// only has to survive a reload — sessionStorage is exactly right for that. These
// drafts are a manager's own writing on their own device, they hold no personal
// data about anybody else, and the failure they exist for *is* the app being
// killed and relaunched, which is precisely when sessionStorage is emptied.
// Using sessionStorage here would leave the reported bug unfixed.
//
// Kept pure and free of React so the rules below can be tested directly; the
// wiring (when to save, when to ask) is `src/hooks/use-editor-draft.ts`.

import { readCache, removeCache, writeCache, type CacheHit } from "@/lib/local-cache";

/**
 * Bumped when the *envelope* changes. Individual editors version their own
 * payload through `revive` — a field added to an editor should restore as blank
 * rather than binning everybody's in-progress work, the same reasoning as the
 * `giSize` note in `waiver-draft.ts`.
 */
export const EDITOR_DRAFT_VERSION = 1;

/**
 * How long an unsaved draft is worth offering back.
 *
 * Long, because the whole point is to survive being forgotten about: a manager
 * who starts a post on Tuesday and comes back on Thursday should find it. Not
 * unbounded, because an offer to restore something from months ago is a puzzle
 * rather than a rescue, and it would sit against the origin's quota forever.
 */
export const EDITOR_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/**
 * How long to wait after the last keystroke before writing.
 *
 * Long enough not to touch storage on every character, short enough that what is
 * on the device is never meaningfully behind what is on screen. Whatever this
 * is, a draft is also flushed the instant the page is hidden (see the hook),
 * which is the moment that actually matters on a phone.
 */
export const EDITOR_DRAFT_DEBOUNCE_MS = 800;

/**
 * The storage key for one editor's draft.
 *
 * `scope` identifies *which document*, so two posts open in two tabs do not
 * overwrite each other, and so a new post and an existing one are separate. Use
 * a stable id: the post/article id, or the literal "new" for an unsaved one.
 */
export function editorDraftKey(kind: string, scope: string): string {
  return `draft.${kind}.${scope}`;
}

/**
 * What a stored draft is worth on the screen that just opened.
 *
 * - `"none"` — nothing stored, or nothing worth restoring.
 * - `"offer"` — a draft that differs from what the server just handed us. This
 *   is unsaved work, so ask before touching the form. Never restore silently:
 *   somebody who deliberately abandoned a draft, or who has since edited the
 *   same post from a laptop, must not have this device's copy pushed back over
 *   what they meant to keep.
 * - `"stale"` — a draft identical to the saved version. It was saved after all,
 *   so there is nothing to offer and the entry can go.
 */
export type DraftVerdict = "none" | "offer" | "stale";

export function draftVerdict<T>(
  stored: T | null,
  baseline: T,
  isSame: (a: T, b: T) => boolean,
): DraftVerdict {
  if (stored === null) return "none";
  return isSame(stored, baseline) ? "stale" : "offer";
}

/**
 * A plain-object comparison good enough for these editors.
 *
 * Every field in all three is a string or a boolean, so this is exact rather
 * than approximate. Kept here so each editor does not write its own and quietly
 * leave a field out of the check, which would make its drafts look "stale" and
 * be thrown away.
 */
export function sameDraftFields<T extends Record<string, string | boolean>>(a: T, b: T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key as keyof T] !== b[key as keyof T]) return false;
  }
  return true;
}

/**
 * Build a `revive` for a flat record of strings and booleans.
 *
 * `shape` supplies both the field list and the fallback for a field that is
 * missing or the wrong type, so a draft written before a field existed restores
 * with that field's empty value rather than being rejected wholesale.
 */
export function reviveDraftFields<T extends Record<string, string | boolean>>(
  shape: T,
): (value: unknown) => T | null {
  return (value) => {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    const out: Record<string, string | boolean> = {};
    for (const [key, fallback] of Object.entries(shape)) {
      const stored = source[key];
      out[key] = typeof stored === typeof fallback ? (stored as string | boolean) : fallback;
    }
    return out as T;
  };
}

/* ---------------- Storage, over `local-cache` ---------------- */

export function readEditorDraft<T extends Record<string, string | boolean>>(
  kind: string,
  scope: string,
  owner: string | null,
  shape: T,
): CacheHit<T> | null {
  return readCache(editorDraftKey(kind, scope), {
    version: EDITOR_DRAFT_VERSION,
    owner,
    maxAgeMs: EDITOR_DRAFT_MAX_AGE_MS,
    revive: reviveDraftFields(shape),
  });
}

export function writeEditorDraft(
  kind: string,
  scope: string,
  owner: string | null,
  data: Record<string, string | boolean>,
): void {
  writeCache(editorDraftKey(kind, scope), data, EDITOR_DRAFT_VERSION, owner);
}

export function clearEditorDraft(kind: string, scope: string): void {
  removeCache(editorDraftKey(kind, scope));
}
