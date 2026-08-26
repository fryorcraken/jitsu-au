// Wiring the draft safety net onto an editor.
//
// The rules are in `src/lib/editor-draft.ts`; this is when to apply them. Two
// things here are the whole point and are easy to get wrong:
//
// **Flush when the page is hidden, not when it unloads.** `beforeunload` is what
// the blog composer had, and on a phone it does essentially nothing: iOS Safari
// ignores it, and an app the operating system reclaims in the background is
// never asked to unload at all — it is simply gone, and relaunched cold later.
// `visibilitychange` to `hidden` (and `pagehide`, its partner for the back/
// forward cache) are the last events a page is *guaranteed* to get, so that is
// where the save has to happen. This is the event that would have saved the
// draft that prompted all of this.
//
// **Never restore without asking.** A stored draft is offered, and the offer is
// dismissible. Somebody who abandoned a draft on purpose, or who has since
// edited the same post from a laptop, must not have this device's older copy
// pushed silently over what they meant to keep.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EDITOR_DRAFT_DEBOUNCE_MS,
  clearEditorDraft,
  draftVerdict,
  readEditorDraft,
  sameDraftFields,
  writeEditorDraft,
} from "@/lib/editor-draft";

export type EditorDraftState<T> = {
  /** The stored draft to offer back, or null when there is nothing to offer. */
  offered: T | null;
  /** When that draft was written, epoch ms, for the "from 14:32" line. */
  offeredAt: number | null;
  /** Take the offer: the caller seeds its form from `offered`. */
  restore: () => void;
  /** Refuse it, and throw the stored copy away. */
  discard: () => void;
  /** Drop the stored draft after a successful save. */
  clear: () => void;
};

/**
 * Keep `value` on the device, and offer back anything found there on mount.
 *
 * `scope` names the document (a post id, or "new"). `owner` is the signed-in
 * user id, so a draft is never handed to whoever signs in next on a shared club
 * laptop. `enabled` lets a caller hold off until it knows what the saved version
 * is — comparing against a baseline that has not loaded would offer a draft that
 * turns out to be identical to it.
 */
export function useEditorDraft<T extends Record<string, string | boolean>>({
  kind,
  scope,
  owner,
  value,
  baseline,
  shape,
  enabled = true,
}: {
  kind: string;
  scope: string;
  owner: string | null;
  /** The live form contents. */
  value: T;
  /** What is saved on the server right now. */
  baseline: T;
  /** Field list and per-field empty value; see `reviveDraftFields`. */
  shape: T;
  enabled?: boolean;
}): EditorDraftState<T> {
  /**
   * Which document this hook has looked on the device for.
   *
   * Keyed rather than a bare "have we checked yet" boolean, because two of the
   * three editors using this (`manager.kb.tsx`, `manager.waiver-template.tsx`)
   * are single-page selectors: picking a different article or version changes
   * `scope` in place, with no remount. A boolean latched on the first document
   * and never looked at any other one again, so every document opened after the
   * first silently lost its draft instead of being offered it -- the exact
   * opposite of what this is for.
   */
  const scopeKey = `${kind}\u0000${scope}\u0000${owner ?? ""}`;
  const [checkedScope, setCheckedScope] = useState<string | null>(null);
  /** The offer, tagged with the document it belongs to. */
  const [offer, setOffer] = useState<{ scope: string; data: T; savedAt: number } | null>(null);

  // Look once per document. Not on every render: re-reading after the person has
  // answered would put the offer straight back on screen.
  useEffect(() => {
    if (!enabled || checkedScope === scopeKey) return;
    setCheckedScope(scopeKey);
    // Whatever was being offered belonged to the document we just left.
    setOffer(null);
    const hit = readEditorDraft(kind, scope, owner, shape);
    const verdict = draftVerdict(hit?.data ?? null, baseline, sameDraftFields);
    if (verdict === "stale") {
      clearEditorDraft(kind, scope);
      return;
    }
    if (verdict === "offer" && hit) {
      setOffer({ scope: scopeKey, data: hit.data, savedAt: hit.savedAt });
    }
    // `baseline` and `shape` are read at the moment this runs for a given
    // document and are not re-checked; adding them would re-offer a draft the
    // person just dismissed. Both editors set the new scope and the new
    // baseline in the same commit, so the baseline read here is the right one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, checkedScope, scopeKey, kind, scope, owner]);

  // Only ever the offer for the document on screen. Tagging and comparing, so a
  // scope change cannot leave the previous document's draft on offer for one
  // render against the wrong form.
  const offered = offer && offer.scope === scopeKey ? offer.data : null;
  const offeredAt = offer && offer.scope === scopeKey ? offer.savedAt : null;

  // The live value, in a ref, so the hidden-page flush below can read it without
  // re-registering its listeners on every keystroke.
  const latest = useRef(value);
  latest.current = value;
  const dirty = enabled && !sameDraftFields(value, baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const save = useCallback(() => {
    if (!dirtyRef.current) return;
    writeEditorDraft(kind, scope, owner, latest.current);
  }, [kind, scope, owner]);

  // The ordinary path: a moment after typing stops.
  useEffect(() => {
    if (!enabled) return;
    // Never delete a draft we have not looked at yet. On the first render for a
    // document the form has just been seeded from the saved version, so it
    // matches the baseline and reads as "nothing to recover" -- which would
    // delete that document's stored draft on sight, before anyone was ever
    // shown it.
    if (checkedScope !== scopeKey) return;
    if (!dirty) {
      // Back to matching what is saved (an undo, or a successful save that moved
      // the baseline). Nothing to recover, so nothing should be offered later.
      //
      // Unless an offer is still on screen: an unanswered offer sits in exactly
      // this state (the form still matches the baseline, the draft is the thing
      // being offered), so clearing here deleted the draft in the same breath as
      // offering it back. Anyone who was killed again before answering lost it.
      if (!offered) clearEditorDraft(kind, scope);
      return;
    }
    const timer = setTimeout(save, EDITOR_DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, checkedScope, scopeKey, offered, dirty, value, kind, scope, save]);

  // The path that actually matters on a phone. Both events, because they cover
  // different exits: `visibilitychange` fires when the app goes to the
  // background (the case that lost the draft), `pagehide` when the page is
  // frozen or replaced. Neither is cancellable, so there is nothing to interrupt
  // and no dialog: it just quietly saves.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") save();
    };
    const onPageHide = () => save();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [enabled, save]);

  const restore = useCallback(() => setOffer(null), []);

  const discard = useCallback(() => {
    clearEditorDraft(kind, scope);
    setOffer(null);
  }, [kind, scope]);

  const clear = useCallback(() => {
    clearEditorDraft(kind, scope);
  }, [kind, scope]);

  return { offered, offeredAt, restore, discard, clear };
}
