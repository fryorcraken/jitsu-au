// The knowledge base article query, in one place, so the page that reads an
// article and the links that point at it agree about it.
//
// Two things live here that used to be inline in `routes/kb/$slug.tsx`:
//
//  * The QUERY KEY, which is scoped to the reader. The nav query has been keyed
//    that way since it shipped (see `useKbNav` for the reasoning: a manager
//    whose session ends with a tab open must not keep seeing managers-only
//    drafts). Article bodies and comment threads are the same data, only more
//    of it, and holding them under a bare `["kb-article", slug]` while they are
//    cached for minutes at a time would leave a draft on screen after a sign-out
//    in another tab.
//  * PREFETCHING. The sidebar, the index and the previous/next links all know
//    the slug a reader is about to open long before they click it, so the fetch
//    can start on hover or on focus instead of after the click. On a warm cache
//    the article is simply there, which is the difference between the knowledge
//    base feeling like a set of pages and feeling like an app.
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/useAuth";
import { getKbArticle } from "@/lib/kb.functions";

/**
 * How long a fetched article counts as fresh.
 *
 * Long enough that moving back and forth through a section costs nothing, short
 * enough that a manager who has just published a correction sees it on the next
 * article they open rather than at the end of the session. An article is
 * versioned prose that changes a few times a year, so this errs long.
 */
export const KB_ARTICLE_STALE_TIME = 5 * 60_000;

/** Everything the reader's copy of an article is cached under. */
function articleQueryOptions<T>(
  fetchArticle: (opts: { data: { slug: string } }) => Promise<T>,
  userId: string | null,
  slug: string,
) {
  return {
    queryKey: ["kb-article", userId, slug],
    queryFn: () => fetchArticle({ data: { slug } }),
    staleTime: KB_ARTICLE_STALE_TIME,
    // No retries, and here rather than on the observer so a PREFETCH obeys it
    // too. The common failure is a refusal ("that article does not exist, or is
    // not available to you"), which no amount of asking again will change, and
    // a prefetch left retrying on the default backoff would hold a click in the
    // loading state for seconds waiting for an answer that is already known.
    retry: false,
  };
}

/** The comment threads on an article, keyed by reader for the same reason. */
export function kbAnnotationsQueryKey(userId: string | null, slug: string) {
  return ["kb-annotations", userId, slug];
}

/**
 * One article, once auth has settled.
 *
 * `enabled: !authLoading` because the server resolves the reader from the
 * request's bearer token: asking too early reads a members-only article as a
 * signed-out visitor and renders "not available to you" at somebody who is, in
 * fact, signed in.
 */
export function useKbArticle(slug: string) {
  const { user, loading: authLoading } = useAuth();
  const fetchArticle = useServerFn(getKbArticle);
  return useQuery({
    ...articleQueryOptions(fetchArticle, user?.id ?? null, slug),
    enabled: !authLoading,
  });
}

/**
 * Start fetching an article the reader has not clicked yet.
 *
 * Safe to call on every pointer move over a list: `prefetchQuery` is a no-op
 * while the same key is already fresh or already in flight, so a reader running
 * their cursor down the sidebar fetches each article at most once.
 */
export function useKbArticlePrefetch(): (slug: string) => void {
  const { user, loading: authLoading } = useAuth();
  const fetchArticle = useServerFn(getKbArticle);
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  return useCallback(
    (slug: string) => {
      // Prefetching before auth has settled would cache the signed-out answer
      // under the signed-in reader's key, which is the one failure this is not
      // allowed to have.
      if (authLoading) return;
      void queryClient.prefetchQuery(articleQueryOptions(fetchArticle, userId, slug));
    },
    [authLoading, fetchArticle, queryClient, userId],
  );
}

/**
 * Throw away everything the READER side has cached about the knowledge base.
 *
 * For the manager screen to call after it writes. Nothing else connects the
 * two: the editor keeps its own state and never goes through these queries, so
 * without this a manager who publishes a correction (or reorders the sidebar,
 * or renames a section) would read the old version at `/kb/<slug>` until the
 * five minutes above ran out. Cheap, and it is invalidation rather than
 * removal, so a screen currently showing one of these refetches instead of
 * blanking.
 */
export function useInvalidateKbReader(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    // Every reader's copy, not just this manager's: they are keyed by user id,
    // and a manager holds at most one of them anyway.
    for (const key of [["kb-article"], ["kb-nav"], ["kb-search"], ["kb-annotations"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [queryClient]);
}
