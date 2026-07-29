// What a manager is told after approving or unapproving a waiver.
//
// Approving is not a repaint: `setWaiverApproval` copies the submission onto
// the profile, lifts the applicant's login ban, emails a sign-in link and
// assigns the free trial. The list refetch that follows only decides what the
// screen shows. Both manager screens run them back to back, so the messages
// live here — shared, and unit-testable away from the components — to stop a
// refetch that failed being reported as an approval that failed.

import type { WaiverApprovalStatus } from "./validation";

/**
 * A map rather than a ternary so a new approval status is a type error here
 * instead of silently borrowing the "unapproved" wording.
 */
const SUCCESS: Record<WaiverApprovalStatus, string> = {
  approved: "Waiver approved. The member's record has been updated.",
  pending: "Approval removed. The waiver is pending again.",
};

/** The approval and the refetch both landed: say what changed. */
export function approvalSuccessMessage(status: WaiverApprovalStatus): string {
  return SUCCESS[status];
}

/** The approval itself failed, so nothing was written. */
export function approvalFailureMessage(e: unknown): string {
  return reason(e) ?? "Failed to update approval";
}

/**
 * The approval committed and only the refetch failed. Say so plainly: the row
 * on screen is stale, not wrong, and clicking Approve again would be pointless.
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
