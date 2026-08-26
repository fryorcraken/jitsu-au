import { describe, expect, it } from "vitest";
import { reportsIdentity, resolveAuthRefresh } from "@/lib/auth-events";

const nothing = { invalidateRouter: false, invalidateQueries: false, clearDeviceCache: null };

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
      clearDeviceCache: { owner: null },
    });
    expect(resolveAuthRefresh("SIGNED_IN", "user-1", "user-2")).toEqual({
      invalidateRouter: true,
      invalidateQueries: true,
      clearDeviceCache: { owner: "user-1" },
    });
  });

  it("re-runs the loaders on sign-out but does not refetch queries", () => {
    expect(resolveAuthRefresh("SIGNED_OUT", "user-1", null)).toEqual({
      invalidateRouter: true,
      invalidateQueries: false,
      clearDeviceCache: { owner: "user-1" },
    });
  });

  it("acts on USER_UPDATED even though the id is unchanged", () => {
    expect(resolveAuthRefresh("USER_UPDATED", "user-1", "user-1")).toEqual({
      invalidateRouter: true,
      invalidateQueries: true,
      clearDeviceCache: null,
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

  describe("clearing the device", () => {
    // The privacy guarantee behind every cached article, roster and draft: a
    // club laptop handed to the next person must carry nothing of the last.
    it("wipes the previous person's data when somebody signs out", () => {
      expect(resolveAuthRefresh("SIGNED_OUT", "user-1", null).clearDeviceCache).toEqual({
        owner: "user-1",
      });
    });

    it("wipes it when a DIFFERENT person signs in without a sign-out in between", () => {
      expect(resolveAuthRefresh("SIGNED_IN", "user-1", "user-2").clearDeviceCache).toEqual({
        owner: "user-1",
      });
    });

    it("keeps it when the same person is re-announced", () => {
      // This fires on every visibility change. Wiping here would throw away an
      // unsaved draft every time somebody switched apps, which is the exact
      // failure the draft net exists to prevent.
      expect(resolveAuthRefresh("SIGNED_IN", "user-1", "user-1").clearDeviceCache).toBeNull();
      expect(resolveAuthRefresh("TOKEN_REFRESHED", "user-1", "user-1").clearDeviceCache).toBeNull();
    });

    it("keeps it when the same person's profile changes", () => {
      expect(resolveAuthRefresh("USER_UPDATED", "user-1", "user-1").clearDeviceCache).toBeNull();
    });

    it("can name the signed-out slot, distinctly from clearing nothing", () => {
      // `{ owner: null }` and `null` are different answers. A bare
      // `string | null` would collapse them and make one unreachable.
      expect(resolveAuthRefresh("SIGNED_IN", null, "user-1").clearDeviceCache).toEqual({
        owner: null,
      });
      expect(resolveAuthRefresh("SIGNED_IN", "user-1", "user-1").clearDeviceCache).toBeNull();
    });
  });

  describe("the real event sequence a subscription receives", () => {
    /**
     * What `__root.tsx` does, in miniature: feed events through in order,
     * adopting identity exactly as the wiring does, and report what each one
     * asked for. The bug that made this necessary was invisible to every test
     * that called `resolveAuthRefresh` on its own, because it lived in WHICH
     * events were allowed to update `previousUserId`.
     */
    function drive(events: [string, string | null][]) {
      let previousUserId: string | null | undefined = undefined;
      return events.map(([event, userId]) => {
        const refresh = resolveAuthRefresh(event, previousUserId, userId);
        if (reportsIdentity(event, userId)) previousUserId = userId;
        return refresh;
      });
    }

    it("wipes the device when a returning member signs out", () => {
      // The sequence a returning member's tab actually sees. supabase fires
      // INITIAL_SESSION first, carrying the stored session -- never SIGNED_IN.
      // Adopting only from SIGNED_IN meant this sign-out had nobody to clear
      // for, and the cached roster, articles and drafts stayed on the device.
      const [initial, signedOut] = drive([
        ["INITIAL_SESSION", "user-1"],
        ["SIGNED_OUT", null],
      ]);

      expect(initial.clearDeviceCache).toBeNull();
      expect(signedOut.clearDeviceCache).toEqual({ owner: "user-1" });
      expect(signedOut.invalidateRouter).toBe(true);
    });

    it("wipes it when the tab did see a SIGNED_IN first", () => {
      const [, , signedOut] = drive([
        ["INITIAL_SESSION", "user-1"],
        ["SIGNED_IN", "user-1"],
        ["SIGNED_OUT", null],
      ]);
      expect(signedOut.clearDeviceCache).toEqual({ owner: "user-1" });
    });

    it("stays quiet through a whole session of tab switches", () => {
      // Every visibility change re-announces the session. None of these should
      // refetch anything or touch what is on the device.
      const results = drive([
        ["INITIAL_SESSION", "user-1"],
        ["SIGNED_IN", "user-1"],
        ["TOKEN_REFRESHED", "user-1"],
        ["SIGNED_IN", "user-1"],
        ["SIGNED_IN", "user-1"],
      ]);
      for (const r of results) {
        expect(r).toEqual({
          invalidateRouter: false,
          invalidateQueries: false,
          clearDeviceCache: null,
        });
      }
    });

    it("wipes the first person's data when a second signs in on the same device", () => {
      const [, , , second] = drive([
        ["INITIAL_SESSION", "user-1"],
        ["SIGNED_OUT", null],
        ["INITIAL_SESSION", null],
        ["SIGNED_IN", "user-2"],
      ]);
      // user-1's data went at the sign-out; this clears the signed-out slot.
      expect(second.clearDeviceCache).toEqual({ owner: null });
      expect(second.invalidateQueries).toBe(true);
    });

    it("starting signed out and staying so asks for nothing", () => {
      const results = drive([
        ["INITIAL_SESSION", null],
        ["SIGNED_OUT", null],
      ]);
      for (const r of results) expect(r.clearDeviceCache).toBeNull();
    });
  });

  describe("reportsIdentity", () => {
    it("believes any event that carries a session", () => {
      for (const event of ["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"]) {
        expect(reportsIdentity(event, "user-1")).toBe(true);
      }
    });

    it("believes the two events that legitimately report nobody", () => {
      expect(reportsIdentity("SIGNED_OUT", null)).toBe(true);
      expect(reportsIdentity("INITIAL_SESSION", null)).toBe(true);
    });

    it("does not forget who somebody is because an event arrived without a session", () => {
      // A sessionless TOKEN_REFRESHED is not evidence that the person left, and
      // forgetting them here would lose the id the device needs wiping for.
      expect(reportsIdentity("TOKEN_REFRESHED", null)).toBe(false);
      expect(reportsIdentity("USER_UPDATED", null)).toBe(false);
    });
  });
});
