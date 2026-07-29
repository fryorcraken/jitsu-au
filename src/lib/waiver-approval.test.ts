import { describe, expect, it } from "vitest";
import {
  approvalFailureMessage,
  approvalRefreshFailureMessage,
  approvalSuccessMessage,
} from "./waiver-approval";

describe("approvalSuccessMessage", () => {
  it("says the member's record changed when a waiver is approved", () => {
    expect(approvalSuccessMessage("approved")).toBe(
      "Waiver approved. The member's record has been updated.",
    );
  });

  it("says the waiver is pending again when an approval is removed", () => {
    expect(approvalSuccessMessage("pending")).toBe(
      "Approval removed. The waiver is pending again.",
    );
  });
});

describe("approvalFailureMessage", () => {
  it("passes the server's reason through", () => {
    expect(approvalFailureMessage(new Error("Not a manager"))).toBe("Not a manager");
  });

  it("falls back for a thrown non-Error", () => {
    expect(approvalFailureMessage("boom")).toBe("Failed to update approval");
  });

  it("falls back rather than showing a blank toast", () => {
    expect(approvalFailureMessage(new Error("   "))).toBe("Failed to update approval");
  });
});

describe("approvalRefreshFailureMessage", () => {
  // The whole point of #70: the approval has already committed (profile
  // updated, login unbanned, sign-in link emailed, trial assigned), so a failed
  // refetch must never read as a failed approval or the manager clicks again.
  it("says the save worked and only the refresh did not", () => {
    expect(approvalRefreshFailureMessage(new Error("Network error"))).toBe(
      "Saved, but the page could not be refreshed: Network error",
    );
  });

  it("falls back for a thrown non-Error", () => {
    expect(approvalRefreshFailureMessage(undefined)).toBe(
      "Saved, but the page could not be refreshed.",
    );
  });

  it("drops the trailing colon when the error has nothing to say", () => {
    expect(approvalRefreshFailureMessage(new Error(""))).toBe(
      "Saved, but the page could not be refreshed.",
    );
  });

  it("never claims the approval failed", () => {
    for (const thrown of [new Error("Failed to fetch"), "boom", undefined, new Error("")]) {
      expect(approvalRefreshFailureMessage(thrown)).toMatch(/^Saved, but/);
      expect(approvalRefreshFailureMessage(thrown)).not.toContain("Failed to update approval");
    }
  });
});
