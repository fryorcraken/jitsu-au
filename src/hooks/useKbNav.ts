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
import { buildKbNav } from "@/lib/kb-nav";
import type { KbNavSection } from "@/lib/kb-nav";
import { listKnowledgeBase } from "@/lib/kb.functions";

export function useKbNav(): { nav: KbNavSection[]; loading: boolean } {
  const { user, loading: authLoading } = useAuth();
  const fetchNav = useServerFn(listKnowledgeBase);
  const query = useQuery({
    // Keyed by WHO it was fetched for. `__root.tsx` deliberately does not
    // invalidate the query cache on SIGNED_OUT, which was safe while every
    // screen holding privileged data lived under `_authenticated` and navigated
    // away. `/kb` is public, so a manager who signs out from the header stays on
    // the page with the observer mounted, and a bare `["kb-nav"]` would keep
    // listing every managers-only draft's title until something forced a
    // refetch. The reads themselves are gated server-side; this stops the
    // titles lingering on screen.
    queryKey: ["kb-nav", user?.id ?? null],
    queryFn: () => fetchNav(),
    // The server resolves the reader from the request's bearer token, so asking
    // before auth has settled returns the signed-out view of the knowledge base
    // to a member who is signed in.
    enabled: !authLoading,
  });

  const nav = useMemo(
    () => (query.data ? buildKbNav(query.data.sections, query.data.entries) : []),
    [query.data],
  );
  return { nav, loading: authLoading || query.isLoading };
}
