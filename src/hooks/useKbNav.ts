// The knowledge base navigation, fetched once and shared by every page inside
// the shell.
//
// Its own module rather than an export from `KbLayout.tsx` because the shell,
// the index page and the article page all need the same order — the index to lay
// out its sections, the article page for breadcrumbs and prev/next — and a file
// that exports both components and a hook loses React Fast Refresh.
//
// They share one query key, so moving between articles reuses the cached nav
// instead of refetching the whole structure on every click.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/useAuth";
import { describeLoadError } from "@/lib/load-error";
import { buildKbNav } from "@/lib/kb-nav";
import type { KbNavSection } from "@/lib/kb-nav";
import { listKnowledgeBase } from "@/lib/kb.functions";

/**
 * How long the fetched contents count as fresh. See the `staleTime` below.
 */
export const KB_NAV_STALE_TIME = 5 * 60_000;

export function useKbNav(): {
  nav: KbNavSection[];
  loading: boolean;
  /** Set when the fetch rejected. Null while it is in flight and once it lands. */
  error: string | null;
  refetch: () => void;
} {
  const { user, loading: authLoading } = useAuth();
  const fetchNav = useServerFn(listKnowledgeBase);
  const query = useQuery({
    // Keyed by WHO it was fetched for. `__root.tsx` deliberately does not
    // invalidate the query cache on SIGNED_OUT, which was safe while every
    // screen holding privileged data lived under `_authenticated` and navigated
    // away. The route gate on `/kb` (`beforeLoad`) only runs on navigation, so a
    // manager whose session ends while a tab is already open (an expired token,
    // storage cleared in another tab) stays on the page with the observer
    // mounted, and a bare `["kb-nav"]` would keep listing every managers-only
    // draft's title until something forced a refetch. The reads themselves are
    // gated server-side; this stops the titles lingering on screen.
    queryKey: ["kb-nav", user?.id ?? null],
    queryFn: () => fetchNav(),
    // The server resolves the reader from the request's bearer token, so asking
    // before auth has settled returns the signed-out view of the knowledge base
    // to a member who is signed in.
    enabled: !authLoading,
    // The sidebar is on every page under /kb and its contents change when a
    // manager publishes, which is a few times a year. Without this, React Query
    // refetches the whole structure on every remount and every window focus, so
    // a reader alt-tabbing back to an article they are part-way through paid for
    // the nav again. `markKbArticleRead` invalidates this key when a tick needs
    // to appear, so progress is still immediate.
    staleTime: KB_NAV_STALE_TIME,
  });

  const nav = useMemo(
    () => (query.data ? buildKbNav(query.data.sections, query.data.entries) : []),
    [query.data],
  );
  // `isLoading` is false once a query has failed, and it was the only thing
  // reported here: /kb sat on "Loading..." for good, with no error and no way
  // out, because nothing downstream could see that the fetch had rejected.
  return {
    nav,
    loading: authLoading || query.isLoading,
    error: query.isError
      ? describeLoadError(query.error, "Could not load the knowledge base")
      : null,
    refetch: () => void query.refetch(),
  };
}
