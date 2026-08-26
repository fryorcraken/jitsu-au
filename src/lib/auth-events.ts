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
};

const NOTHING: AuthRefresh = { invalidateRouter: false, invalidateQueries: false };

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
    return { invalidateRouter: true, invalidateQueries: true };
  }

  if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return NOTHING;

  // First event of the page's life: adopt it, don't act on it.
  if (previousUserId === undefined) return NOTHING;

  if (previousUserId === nextUserId) return NOTHING;

  // Signing out: re-run the loaders so the auth gate redirects, but do NOT
  // invalidate the query cache. The queries that hold anything privileged are
  // keyed by reader id (see `useKbNav`), so they are already unreachable, and
  // refetching them on the way out would fire a screenful of requests as the
  // session that could answer them disappears.
  if (nextUserId === null) return { invalidateRouter: true, invalidateQueries: false };

  return { invalidateRouter: true, invalidateQueries: true };
}
