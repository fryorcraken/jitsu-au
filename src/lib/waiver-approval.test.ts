import { describe, expect, it, vi } from "vitest";
import {
  approvalConfirmation,
  approvalFailureMessage,
  approvalRefreshFailureMessage,
  runApproval,
  supersedesMediaConsent,
} from "./waiver-approval";

describe("runApproval", () => {
  const ok = () => Promise.resolve();

  it("reports what changed when both steps land", async () => {
    const outcome = await runApproval({ status: "approved", approve: ok, refresh: ok });
    expect(outcome).toEqual({
      kind: "ok",
      severity: "success",
      message: "Waiver approved. The member's record has been updated.",
    });
  });

  it("reports the waiver as pending again when an approval is removed", async () => {
    const outcome = await runApproval({ status: "pending", approve: ok, refresh: ok });
    expect(outcome).toEqual({
      kind: "ok",
      severity: "success",
      message: "Approval removed. The waiver is pending again.",
    });
  });

  it("reports a failed approval as an error, and does not refresh", async () => {
    const refresh = vi.fn(ok);
    const outcome = await runApproval({
      status: "approved",
      approve: () => Promise.reject(new Error("Forbidden")),
      refresh,
    });
    expect(outcome).toEqual({ kind: "failed", severity: "error", message: "Forbidden" });
    expect(refresh).not.toHaveBeenCalled();
  });

  // The regression #70 was filed for. Before the split, this case produced
  // "Failed to update approval" even though the approval had committed: the
  // profile was updated, the login unbanned, the activation email sent and the
  // free trial assigned. The manager's next move was to click Approve again.
  it("says the save worked when only the refresh fails", async () => {
    const outcome = await runApproval({
      status: "approved",
      approve: ok,
      refresh: () => Promise.reject(new Error("Failed to fetch")),
    });
    expect(outcome).toEqual({
      kind: "refreshFailed",
      severity: "warning",
      message: "Saved, but the page could not be refreshed: Failed to fetch",
    });
  });

  it("never calls a committed approval a failure, whatever the refresh threw", async () => {
    for (const thrown of [new Error("Failed to fetch"), new Error(""), "boom", undefined]) {
      const outcome = await runApproval({
        status: "approved",
        approve: ok,
        refresh: () => Promise.reject(thrown),
      });
      expect(outcome.kind).toBe("refreshFailed");
      // Not red: red is what a manager reads as "click Approve again".
      expect(outcome).not.toHaveProperty("severity", "error");
      expect(outcome.kind !== "stale" && outcome.message).toMatch(/^Saved, but/);
    }
  });

  it("stays silent when a newer load already owns the screen", async () => {
    const outcome = await runApproval({
      status: "approved",
      approve: ok,
      refresh: () => Promise.resolve(false),
    });
    // No message and no severity: the load that won will say its own piece.
    expect(outcome).toEqual({ kind: "stale" });
  });

  it("treats any other refresh answer as a refresh that landed", async () => {
    const outcome = await runApproval({
      status: "approved",
      approve: ok,
      refresh: () => Promise.resolve(true),
    });
    expect(outcome.kind).toBe("ok");
  });

  it("runs the approval before the refresh", async () => {
    const order: string[] = [];
    await runApproval({
      status: "approved",
      approve: async () => void order.push("approve"),
      refresh: async () => void order.push("refresh"),
    });
    expect(order).toEqual(["approve", "refresh"]);
  });
});

describe("approvalFailureMessage", () => {
  it("passes the server's reason through", () => {
    expect(approvalFailureMessage(new Error("Not a manager"))).toBe("Not a manager");
  });

  it("keeps the reason when trimming its padding", () => {
    expect(approvalFailureMessage(new Error("  Forbidden  "))).toBe("Forbidden");
  });

  it("falls back for a thrown non-Error", () => {
    expect(approvalFailureMessage("boom")).toBe("Could not update the approval. Try again.");
  });

  it("falls back rather than showing a blank toast", () => {
    expect(approvalFailureMessage(new Error("   "))).toBe(
      "Could not update the approval. Try again.",
    );
  });
});

describe("supersedesMediaConsent", () => {
  // The regression this guards: a member withdraws consent on /account
  // (setting media_consent_updated_at to now), and a manager later approves
  // an OLDER pending waiver -- filed from a paper scan, say -- whose photo
  // box was ticked. That approval must not resurrect the withdrawn consent.
  it("does not supersede a more recent withdrawal with an older ticked waiver", () => {
    expect(
      supersedesMediaConsent({
        waiverSignedAt: "2026-01-01T00:00:00.000Z",
        profileMediaConsentUpdatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("supersedes when the waiver is genuinely newer than the profile's answer", () => {
    expect(
      supersedesMediaConsent({
        waiverSignedAt: "2026-06-01T00:00:00.000Z",
        profileMediaConsentUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("supersedes when the profile has no answer yet", () => {
    expect(
      supersedesMediaConsent({
        waiverSignedAt: "2026-01-01T00:00:00.000Z",
        profileMediaConsentUpdatedAt: null,
      }),
    ).toBe(true);
  });

  it("does not supersede on an exact tie", () => {
    expect(
      supersedesMediaConsent({
        waiverSignedAt: "2026-01-01T00:00:00.000Z",
        profileMediaConsentUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("approvalRefreshFailureMessage", () => {
  it("says the save worked and only the refresh did not", () => {
    expect(approvalRefreshFailureMessage(new Error("Network error"))).toBe(
      "Saved, but the page could not be refreshed: Network error",
    );
  });

  it("keeps the reason when trimming its padding", () => {
    expect(approvalRefreshFailureMessage(new Error("  Network error  "))).toBe(
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
});

describe("approvalConfirmation", () => {
  const copy = approvalConfirmation("Sam Tanaka");

  it("asks about the person in front of the manager", () => {
    expect(copy.title).toBe("Approve Sam Tanaka's waiver?");
  });

  it("names every outward-facing thing a first approval does", () => {
    // The three steps that reach past this site: the email, the login and the
    // trial. A manager who has not been told about the email cannot choose not
    // to send it, and it is the one that cannot be pulled back.
    expect(copy.details).toEqual([
      "emails them to say their account is ready",
      "unlocks their login so they can sign in",
      "starts their free trial",
    ]);
  });

  it("says plainly that revoking approval does not take any of it back", () => {
    expect(copy.footnote).toContain("cannot be unsent");
    expect(copy.footnote).toContain("does not take back the email, the login or the trial");
  });

  it("names the action on the button rather than saying OK", () => {
    expect(copy.confirmLabel).toBe("Approve waiver");
  });

  it("keeps the em dash out of copy a manager reads", () => {
    // AGENTS.md: no em dashes in user-facing copy, this screen included.
    const everything = [copy.title, copy.description, copy.footnote, copy.confirmLabel]
      .concat(copy.details)
      .join(" ");
    expect(everything).not.toContain("\u2014");
  });
});
