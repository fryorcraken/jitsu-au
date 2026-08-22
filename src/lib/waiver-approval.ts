// Approving or unapproving a waiver, and what the manager is told about it.
//
// Approving is not a repaint: `setWaiverApproval` copies the submission onto
// the profile, lifts the applicant's login ban, emails them that their account
// is active, and assigns the free trial. The refresh that follows only decides what the screen
// shows. Running them in one try/catch reported a refresh that failed as an
// approval that failed, which is the one message that makes a manager click
// Approve again on work that already went through.
//
// Both manager screens do the same two steps in the same order, differing only
// in how they refresh, so the ordering lives here with the wording: injected
// callbacks, no toasts, no React, so the sequence is unit-testable on its own.

import type { WaiverApprovalStatus } from "./validation";

/**
 * A map rather than a ternary so a new approval status is a type error here
 * instead of silently borrowing the "unapproved" wording.
 */
const SUCCESS: Record<WaiverApprovalStatus, string> = {
  approved: "Waiver approved. The member's record has been updated.",
  pending: "Approval removed. The waiver is pending again.",
};

/**
 * How an approval ended, and what to say about it.
 *
 * `severity` is decided here rather than at each screen, because it is half the
 * message: a refresh that failed after a committed approval must not be red.
 * Red is what a manager reads as "that did not work", and re-clicking Approve
 * is exactly what this whole module exists to stop. It matches how the same
 * shape is already reported when a manager's email change saves but its
 * confirmation email does not.
 */
export type ApprovalOutcome =
  | { kind: "ok"; severity: "success"; message: string }
  | { kind: "failed"; severity: "error"; message: string }
  | { kind: "refreshFailed"; severity: "warning"; message: string }
  | { kind: "stale" };

/**
 * Set a waiver's approval, then refresh the screen behind it.
 *
 * `refresh` returning `false` means a newer load already owns the screen, so
 * this one keeps quiet rather than talking over it. Anything else it returns
 * counts as a refresh that landed.
 */
export async function runApproval({
  status,
  approve,
  refresh,
}: {
  status: WaiverApprovalStatus;
  approve: () => Promise<unknown>;
  refresh: () => Promise<boolean | void>;
}): Promise<ApprovalOutcome> {
  try {
    await approve();
  } catch (e) {
    return { kind: "failed", severity: "error", message: approvalFailureMessage(e) };
  }
  // The approval is committed from here on. A refresh failure past this point
  // is a stale screen, not a failed approval, and must never be reported as one.
  try {
    const refreshed = await refresh();
    if (refreshed === false) return { kind: "stale" };
    return { kind: "ok", severity: "success", message: SUCCESS[status] };
  } catch (e) {
    return {
      kind: "refreshFailed",
      severity: "warning",
      message: approvalRefreshFailureMessage(e),
    };
  }
}

/** The approval itself failed, so nothing was written. */
export function approvalFailureMessage(e: unknown): string {
  return reason(e) ?? "Could not update the approval. Try again.";
}

/**
 * The approval committed and only the refresh failed. Say so plainly: the row
 * on screen is stale rather than wrong, so clicking Approve again is harmless
 * but pointless. Reloading the page is what actually helps.
 */
export function approvalRefreshFailureMessage(e: unknown): string {
  const why = reason(e);
  return why
    ? `Saved, but the page could not be refreshed: ${why}`
    : "Saved, but the page could not be refreshed.";
}

/** The thrown value's message, when there is one worth showing a person. */
function reason(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const message = e.message.trim();
  return message || undefined;
}

// ---- Promoting a waiver's media consent answer onto the profile ----
//
// Approving a waiver can happen out of chronological order: Approve is
// available on every pending waiver, and a waiver can be unapproved and
// re-approved later, so "the latest thing a manager clicked Approve on" is
// not the same as "the most recently signed answer". Without this check, an
// old paper waiver that had the photo box ticked could silently overwrite a
// consent the member explicitly withdrew more recently on /account, wiping
// the record that they ever withdrew it.

/**
 * Whether an approved waiver's media-consent answer should supersede what is
 * currently on the profile.
 *
 * Only a waiver that is actually newer than the profile's current answer may
 * overwrite it: the profile's `media_consent_updated_at` being `null` means
 * nothing has set a provenance yet (so any signed answer wins), otherwise the
 * waiver's `signed_at` must be strictly later. A tie (the same instant) does
 * not supersede, since it cannot represent an answer given after the one
 * already on the profile.
 */
export function supersedesMediaConsent({
  waiverSignedAt,
  profileMediaConsentUpdatedAt,
}: {
  waiverSignedAt: string;
  profileMediaConsentUpdatedAt: string | null;
}): boolean {
  if (profileMediaConsentUpdatedAt === null) return true;
  return new Date(waiverSignedAt).getTime() > new Date(profileMediaConsentUpdatedAt).getTime();
}

// ---- What a manager is told before they approve ----
//
// Approving is the one manager action on this site that reaches a person
// directly and cannot be pulled back: it emails them. Both screens ask the
// same question in the same words, because it is the same action and the
// wording is the part that has to be right. Kept here, next to the sequence it
// describes, so a change to what approving DOES has the sentence about it in
// the same file.

/**
 * The confirmation shown before a first approval, ready to hand to `useConfirm`.
 *
 * The list is hedged with "if it is their first approved waiver" because that
 * is the truth: the unban, the email and the trial are all skipped for someone
 * who can already log in, and the screen cannot tell which case this is
 * without asking the server. Over-promising here is the safer error. A manager
 * who expects an email that does not go out loses nothing, while one who does
 * not expect it has already sent it.
 */
export function approvalConfirmation(name: string) {
  return {
    title: `Approve ${name}'s waiver?`,
    description:
      "This copies what they signed onto their member record. If it is their first approved waiver, it also:",
    details: [
      "emails them to say their account is ready",
      "unlocks their login so they can sign in",
      "starts their free trial",
    ],
    footnote:
      "That email cannot be unsent. Revoking approval afterwards puts the waiver back to pending, but it does not take back the email, the login or the trial.",
    confirmLabel: "Approve waiver",
  };
}
