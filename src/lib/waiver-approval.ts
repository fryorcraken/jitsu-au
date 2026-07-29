// What a manager is told after approving or unapproving a waiver.
//
// Approving is not a repaint: `setWaiverApproval` copies the submission onto
// the profile, lifts the applicant's login ban, emails a sign-in link and
// assigns the free trial. The list refetch that follows only decides what the
// screen shows. Both manager screens run them back to back, so the messages
// live here — shared, and unit-testable away from the components — to stop a
// refetch that failed being reported as an approval that failed.

export type ApprovalStatus = "approved" | "pending";

/** The approval and the refetch both landed: say what changed. */
export function approvalSuccessMessage(status: ApprovalStatus): string {
  return status === "approved"
    ? "Waiver approved. The member's record has been updated."
    : "Approval removed. The waiver is pending again.";
}

/** The approval itself failed, so nothing was written. */
export function approvalFailureMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Failed to update approval";
}

/**
 * The approval committed and only the refetch failed. Say so plainly: the row
 * on screen is stale, not wrong, and clicking Approve again would be pointless.
 */
export function approvalRefreshFailureMessage(e: unknown): string {
  return e instanceof Error
    ? `Saved, but the page could not be refreshed: ${e.message}`
    : "Saved, but the page could not be refreshed.";
}
