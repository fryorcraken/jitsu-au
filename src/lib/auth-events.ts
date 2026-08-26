// Which Supabase auth events actually mean something changed.
//
// supabase-js re-reads the stored session every single time the page becomes
// visible (`_onVisibilityChanged` -> `_recoverAndRefresh`) and, when it finds a
// usable one, announces it as `SIGNED_IN`. That is not a sign-in. It is the same
// person, the same token, said again, and it fires on every tab switch, every
// phone unlock and every return to the installed app.
//
// The app used to take it at face value and throw away every route loader and
// every cached query on each one, so coming back to the app re-fetched the whole
// screen from scratch. That is the single biggest reason the installed app felt
// so eager to reload, and on a phone in a gym it is seconds of spinners over a
// connection that was the problem in the first place.
//
// So the rule here is about identity rather than about the event's name: refresh
// when the signed-in person actually changes, and leave the screen alone
// otherwise. Kept side-effect free and free of React and Supabase imports so it
// can be unit tested directly, the same way `auth-persistence.ts` is.

/** What a given auth event should cause the app to throw away. */
export type AuthRefresh = {
  /** Re-run the route loaders (who the page is for has changed). */
  invalidateRouter: boolean;
  /** Re-fetch cached queries as well. */
  invalidateQueries: boolean;
  /**
   * Whose data to wipe off this device, or null to keep everything.
   *
   * Wrapped in an object rather than a bare `string | null` so that "clear the
   * signed-out slot" (`{ owner: null }`) stays expressible and distinct from
   * "clear nothing" (`null`). A bare union would collapse the two and quietly
   * make one of them unreachable.
   *
   * This is the privacy rule for everything `local-cache.ts` stores: a cached
   * knowledge base, a check-in roster full of members' names and emails, an
   * unsaved draft. It lives here, next to the identity rule it depends on,
   * rather than as a condition inside the root component, because it is the
   * guarantee that makes storing any of it defensible on a club laptop several
   * people use -- and a guarantee that exists only as untested wiring is not
   * one.
   */
  clearDeviceCache: { owner: string | null } | null;
};

const NOTHING: AuthRefresh = {
  invalidateRouter: false,
  invalidateQueries: false,
  clearDeviceCache: null,
};

/**
 * Decide what an auth event is worth.
 *
 * `previousUserId` is deliberately three-valued:
 *
 *  - `undefined` — we have not seen an event yet. The very first one is the
 *    session the page loaded with, so there is nothing on screen that predates
 *    it and nothing to invalidate. Adopting it silently is what stops every cold
 *    start fetching its data twice.
 *  - `null` — we know the person is signed out.
 *  - a string — we know who they are.
 */
export function resolveAuthRefresh(
  event: string,
  previousUserId: string | null | undefined,
  nextUserId: string | null,
): AuthRefresh {
  // A profile or email change keeps the same id but changes what the app should
  // be showing, so it is the one event that is always worth acting on.
  if (event === "USER_UPDATED") {
    // The same person, so their own cached data is still theirs to see.
    return { invalidateRouter: true, invalidateQueries: true, clearDeviceCache: null };
  }

  if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return NOTHING;

  // First event of the page's life: adopt it, don't act on it. Nothing to clear
  // either: this IS the session the page loaded with, so whatever is on the
  // device already belongs to whoever is holding it.
  if (previousUserId === undefined) return NOTHING;

  // Includes the SIGNED_IN supabase re-emits on every visibility change. Signing
  // the same person back in is not a handover, so their cache survives it.
  if (previousUserId === nextUserId) return NOTHING;

  // Signing out: re-run the loaders so the auth gate redirects, but do NOT
  // invalidate the query cache. The queries that hold anything privileged are
  // keyed by reader id (see `useKbNav`), so they are already unreachable, and
  // refetching them on the way out would fire a screenful of requests as the
  // session that could answer them disappears.
  //
  // Either way the person at the keyboard has changed, so everything this app
  // kept on the device for the previous one goes.
  if (nextUserId === null) {
    return {
      invalidateRouter: true,
      invalidateQueries: false,
      clearDeviceCache: { owner: previousUserId },
    };
  }

  return {
    invalidateRouter: true,
    invalidateQueries: true,
    clearDeviceCache: { owner: previousUserId },
  };
}

/**
 * Whether an event's session tells us who is signed in.
 *
 * This exists because of a bug worth remembering: `previousUserId` used to be
 * adopted only from `SIGNED_IN` / `SIGNED_OUT`, but the FIRST event supabase
 * hands any new subscriber is `INITIAL_SESSION`, carrying whatever session
 * already exists. A returning member's tab therefore never learned who they
 * were, so when they later signed out there was no id to wipe the device for --
 * and the cached roster, articles and drafts stayed behind on a shared laptop.
 * The privacy guarantee was, in the ordinary case, not being kept at all.
 *
 * So identity is adopted from every event that actually reports it. An event
 * carrying a session names its user; `SIGNED_OUT` and `INITIAL_SESSION` are the
 * two that legitimately report nobody. Anything else arriving with no session is
 * not evidence that the person left, so it is ignored rather than forgetting who
 * they are.
 */
export function reportsIdentity(event: string, nextUserId: string | null): boolean {
  if (nextUserId !== null) return true;
  return event === "SIGNED_OUT" || event === "INITIAL_SESSION";
}
