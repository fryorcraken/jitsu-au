// The calendar link is the site's longest-lived secret and it can never leave
// the URL path, so replacing it is the only way one ever stops working. These
// pin the half of that which lives in the feed: a replaced link must serve
// nothing, and must not be indistinguishable from a typo.
import { describe, expect, it } from "vitest";
import {
  REPLACED_LINK_MESSAGE,
  UNKNOWN_LINK_MESSAGE,
  feedTokenVerdict,
} from "./calendar-feed-token";

describe("feedTokenVerdict", () => {
  it("serves a live link, and hands the row back", () => {
    const row = { id: "tok-1", user_id: "usr-1", revoked_at: null };
    const verdict = feedTokenVerdict(row);
    expect(verdict.serve).toBe(true);
    // The caller needs the row to know whose calendar this is; a verdict that
    // only said "yes" would leave it re-checking for null.
    expect(verdict.serve && verdict.row).toBe(row);
  });

  // The whole point of the feature: the old address stops carrying events the
  // moment its owner replaces it.
  it("refuses a replaced link", () => {
    const verdict = feedTokenVerdict({
      id: "tok-1",
      user_id: "usr-1",
      revoked_at: "2026-08-22T01:00:00Z",
    });
    expect(verdict.serve).toBe(false);
    expect(verdict).toMatchObject({ status: 410, message: REPLACED_LINK_MESSAGE });
  });

  // 410, not 404. "This address was real and is now gone" is a different answer
  // from "no such address", and it is what lets the message be honest.
  it("tells a replaced link apart from one that never existed", () => {
    const replaced = feedTokenVerdict({ revoked_at: "2026-08-22T01:00:00Z" });
    const unknown = feedTokenVerdict(null);
    expect(replaced).not.toEqual(unknown);
    expect(unknown).toEqual({ serve: false, status: 404, message: UNKNOWN_LINK_MESSAGE });
  });

  // Someone holding a replaced link is its owner, or the person they leaked it
  // to. Either way they need to know it was replaced rather than broken, and
  // where the new one is.
  it("tells the holder of a replaced link what to do next", () => {
    expect(REPLACED_LINK_MESSAGE).toContain("replaced");
    expect(REPLACED_LINK_MESSAGE).toContain("/account");
    // Copy voice: no em dashes (AGENTS.md).
    expect(REPLACED_LINK_MESSAGE).not.toContain("—");
  });
});
