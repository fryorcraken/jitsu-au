import { describe, expect, it } from "vitest";
import { resolveAuthRefresh } from "@/lib/auth-events";

const nothing = { invalidateRouter: false, invalidateQueries: false };

describe("resolveAuthRefresh", () => {
  it("ignores the SIGNED_IN supabase re-emits when the page becomes visible", () => {
    // The regression this exists for: supabase-js recovers the stored session on
    // every visibilitychange and announces it as SIGNED_IN. Same person, same
    // token, so nothing on screen is out of date.
    expect(resolveAuthRefresh("SIGNED_IN", "user-1", "user-1")).toEqual(nothing);
  });

  it("ignores the first event of the page's life", () => {
    // The page just loaded with this session. Invalidating here makes every cold
    // start fetch its data twice.
    expect(resolveAuthRefresh("SIGNED_IN", undefined, "user-1")).toEqual(nothing);
    expect(resolveAuthRefresh("SIGNED_OUT", undefined, null)).toEqual(nothing);
  });

  it("refreshes everything when a different person signs in", () => {
    expect(resolveAuthRefresh("SIGNED_IN", null, "user-1")).toEqual({
      invalidateRouter: true,
      invalidateQueries: true,
    });
    expect(resolveAuthRefresh("SIGNED_IN", "user-1", "user-2")).toEqual({
      invalidateRouter: true,
      invalidateQueries: true,
    });
  });

  it("re-runs the loaders on sign-out but does not refetch queries", () => {
    expect(resolveAuthRefresh("SIGNED_OUT", "user-1", null)).toEqual({
      invalidateRouter: true,
      invalidateQueries: false,
    });
  });

  it("acts on USER_UPDATED even though the id is unchanged", () => {
    expect(resolveAuthRefresh("USER_UPDATED", "user-1", "user-1")).toEqual({
      invalidateRouter: true,
      invalidateQueries: true,
    });
  });

  it("ignores token refreshes and every other event", () => {
    for (const event of [
      "TOKEN_REFRESHED",
      "PASSWORD_RECOVERY",
      "INITIAL_SESSION",
      "MFA_CHALLENGE_VERIFIED",
    ]) {
      expect(resolveAuthRefresh(event, "user-1", "user-1")).toEqual(nothing);
    }
    // A token refresh must stay quiet even though supabase hands over a brand
    // new access token each time.
    expect(resolveAuthRefresh("TOKEN_REFRESHED", "user-1", "user-1")).toEqual(nothing);
  });
});
