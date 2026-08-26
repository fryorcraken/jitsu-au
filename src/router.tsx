import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * How long a fetched answer counts as fresh before React Query will consider
 * asking again.
 *
 * React Query's own default is zero, which means "stale the instant it lands":
 * every remount, every reconnect and (with the focus refetch below) every return
 * to the app re-asks the server for something it already has on screen. On a
 * desktop that is invisible. On a phone in a gym, on the club's actual traffic,
 * it is a screenful of spinners every time somebody unlocks their phone.
 *
 * Thirty seconds is short enough that a manager who just changed something and
 * navigated away sees it on the way back, and long enough that moving between
 * screens costs nothing. Screens whose data genuinely changes more slowly set
 * their own longer `staleTime` (the knowledge base uses five minutes).
 */
const DEFAULT_STALE_TIME = 30_000;

/**
 * How long an unused answer is kept in memory after the last screen using it
 * unmounts. A day, because the installed app is opened and left over and over
 * across a single day, and the whole point is that coming back is cheap.
 */
const DEFAULT_GC_TIME = 24 * 60 * 60_000;

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME,
        gcTime: DEFAULT_GC_TIME,
        // Off, deliberately. This is the single most-felt cause of the installed
        // app reloading the moment you come back to it: every tab switch and
        // every phone unlock re-fetched every mounted query at once. Coming back
        // to a screen you were already looking at should show you that screen.
        // `refetchOnReconnect` below is what covers the case that actually
        // matters, which is data fetched while the connection was down.
        refetchOnWindowFocus: false,
        // On, and the reason the setting above can be off: a phone that has just
        // found signal again is the one moment a refetch is worth interrupting
        // for, because what is on screen may have been fetched against nothing.
        refetchOnReconnect: true,
        // Stale data still refetches when a screen mounts. Fresh data does not,
        // which is what makes navigating back and forth free.
        refetchOnMount: true,
        // One retry, not three. A server function that refused (not a manager,
        // no such article) will refuse again, and three rounds of backoff is
        // several seconds of a screen sitting on a spinner before it can say so.
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Preloading a route on hover/touch is only worth it if the result is still
    // there when the tap lands. At 0 every preload was thrown away immediately
    // and the click re-fetched from scratch, so the preload was pure extra
    // traffic on the connection least able to afford it.
    defaultPreloadStaleTime: DEFAULT_STALE_TIME,
  });

  return router;
};
