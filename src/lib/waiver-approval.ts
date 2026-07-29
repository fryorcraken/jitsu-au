// Approving or unapproving a waiver, and what the manager is told about it.
//
// Approving is not a repaint: `setWaiverApproval` copies the submission onto
// the profile, lifts the applicant's login ban, emails a sign-in link and
// assigns the free trial. The refresh that follows only decides what the screen
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
  return reason(e) ?? "Failed to update approval";
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
