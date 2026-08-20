// Decisions the waiver-template editor makes, kept out of the component so they
// are unit-testable — same reason `waiver-approval.ts` exists. No React, no
// toasts, no server calls. The refusal type lives here too, so the screen and
// the manager agent API describe a rejected template change the same way.
import type { AcknowledgementDef } from "./validation";
import { MEDIA_ACK_ID } from "./waiver-acknowledgements";

/**
 * Why a template change could not be made.
 *
 * One class carrying a reason rather than three classes, because the callers
 * that care all branch on the same three cases: the editor screen shows the
 * message either way, and the agent API turns the reason into a status code an
 * agent can act on (change the request / it is gone / try again).
 *
 * `not_published` is the one a message alone cannot carry. It means the club's
 * live waiver is not what the caller asked for, and when `version` is set it
 * means that version WAS written and is simply not live — so repeating the save
 * files a second numbered draft, while publishing that version finishes the job.
 * Getting that distinction wrong is how an outage (`/waiver` refusing to render
 * for everyone) gets reported as "your request was invalid" and abandoned.
 */
export class WaiverTemplateError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "invalid" | "not_published",
    /**
     * The version that exists but is not live. Undefined when nothing was
     * written at all, which is the difference between "retry this call" and
     * "publish the version you already have".
     */
    readonly version?: number,
  ) {
    super(message);
    this.name = "WaiverTemplateError";
  }
}

/** What the editor holds right now, and what a stored version holds. */
export type TemplateDraft = {
  title: string;
  body_md: string;
  acknowledgements: AcknowledgementDef[];
};

/**
 * The acknowledgements a save would actually write: trimmed, with blank ones
 * dropped.
 *
 * "Add acknowledgement" appends an empty row for the manager to type into, so an
 * abandoned empty row is not an edit. Saving already discarded them; the
 * unsaved-changes check has to agree, or adding a row and thinking better of it
 * prompts about losing work that was never there.
 */
export function meaningfulAcks(acks: AcknowledgementDef[]): AcknowledgementDef[] {
  return acks.map((a) => ({ ...a, label: a.label.trim() })).filter((a) => a.label.length > 0);
}

/**
 * Whether the editor holds changes a save would keep.
 *
 * Compares field by field rather than by serializing both sides: two
 * acknowledgement lists that differ only in key order are the same list, and a
 * `JSON.stringify` comparison would call that an edit.
 */
export function isDirty(draft: TemplateDraft, stored: TemplateDraft | null): boolean {
  if (!stored) return false;
  if (draft.title !== stored.title) return true;
  if (draft.body_md !== stored.body_md) return true;
  const a = meaningfulAcks(draft.acknowledgements);
  const b = meaningfulAcks(stored.acknowledgements);
  if (a.length !== b.length) return true;
  return a.some(
    (ack, i) => ack.id !== b[i].id || ack.label !== b[i].label || ack.required !== b[i].required,
  );
}

/**
 * Whether an acknowledgement list still carries a valid media-consent item.
 *
 * "Valid" means present with a non-blank label, not merely present: a manager
 * can select the media row's Textarea and clear it without touching the id,
 * and `meaningfulAcks` would drop that row silently on save (same as any other
 * abandoned blank row), taking the media acknowledgement -- and the club's
 * ability to record photo consent -- with it. Checking the raw, un-cleaned
 * list here catches that before the drop happens, so the guard trips on the
 * edit that causes the loss rather than after it.
 *
 * Also false for a template that never had the item at all (every version
 * predating the media-consent feature), so loading an old version and saving
 * it unchanged is refused too, not just an edit that removes it.
 */
export function hasMediaAcknowledgement(acks: AcknowledgementDef[]): boolean {
  return acks.some((a) => a.id === MEDIA_ACK_ID && a.label.trim().length > 0);
}

/**
 * How a version is labelled in the list.
 *
 * "Draft" is only honest for a version that has never been live. One that WAS
 * live is a superseded legal document, possibly with signatures against it, and
 * calling it a draft on the screen where a manager picks what the club stands
 * behind invites treating a rollback as publishing something unfinished. We
 * cannot tell from the row itself, so age against the live version stands in:
 * anything older than what is live has had its turn.
 */
export function versionLabel(
  version: { version: number; is_current: boolean },
  liveVersion: number | null,
): "Live" | "Previous" | "Draft" {
  if (version.is_current) return "Live";
  if (liveVersion !== null && version.version < liveVersion) return "Previous";
  return "Draft";
}
