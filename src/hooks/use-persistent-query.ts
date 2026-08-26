// A query whose answer survives the app being closed.
//
// React Query already caches, but only in memory: the moment the tab is
// discarded or the installed app is reclaimed by the phone, every answer it
// held is gone. That is fine on a laptop and wrong on the two screens this club
// actually uses on bad connections:
//
//   * **Check-in**, run at the door of a university gym, on a phone, by a
//     manager with a queue of people in front of them. Relaunching to a spinner
//     (or worse, to "could not load the roster") is the failure that matters.
//   * **The knowledge base**, which members read on the mat between rounds. It
//     is the club's own prose and it changes a few times a year, so re-fetching
//     it on every launch is pure cost.
//
// So this seeds a query from the device and then refreshes it in the background:
// what was there last time paints immediately, and the network result replaces
// it when it arrives. Same shape as the service worker's stale-while-revalidate
// for assets, one layer up.
//
// **What is allowed in here.** Everything stored is scoped to the signed-in
// person, dropped the moment they sign out (`clearCacheFor` in `__root.tsx`),
// and given a hard expiry so a stale answer cannot outlive its usefulness. That
// is a deliberate line: `public/sw.js` refuses to cache HTML precisely so that
// no signed-in page can be served to the next person on a shared device, and
// this must not quietly undo it. Only opt a query in when the data is worth an
// offline read AND being a few minutes out of date is honest rather than
// misleading. Anything a manager would act on irreversibly does not belong here.

import { useEffect, useRef } from "react";
import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { readCache, writeCache, type CacheHit } from "@/lib/local-cache";

/** Bumped when the envelope changes; the payload's own shape is `revive`'s job. */
export const PERSISTENT_QUERY_VERSION = 1;

export type PersistentQueryOptions<T> = {
  /** React Query's key. Include the reader's id, as the KB queries already do. */
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  /**
   * The storage key. Deliberately separate from `queryKey` rather than derived
   * from it: a key is a shape somebody will change one day, and deriving would
   * silently orphan every entry already on every device the next time it moved.
   */
  cacheKey: string;
  /** Who this belongs to. `null` reads and writes the signed-out slot. */
  owner: string | null;
  /** Refuse anything stored longer ago than this. */
  maxAgeMs: number;
  /** Total, and required — see `CacheTerms.revive`. */
  revive: (value: unknown) => T | null;
  staleTime?: number;
  enabled?: boolean;
};

export type PersistentQueryResult<T> = UseQueryResult<T> & {
  /**
   * When the data on screen was fetched, if it came off the device rather than
   * the network. Null once a fresh answer has landed, so a screen can say "this
   * is what was here at 18:40" only while that is actually true.
   */
  restoredAt: number | null;
};

export function usePersistentQuery<T>({
  queryKey,
  queryFn,
  cacheKey,
  owner,
  maxAgeMs,
  revive,
  staleTime,
  enabled = true,
}: PersistentQueryOptions<T>): PersistentQueryResult<T> {
  // Read during render, not in an effect. An effect runs after the first paint,
  // which would mean a flash of the loading state before the cached answer
  // appeared — exactly the spinner this exists to remove.
  //
  // Once per key, though, and that is what the ref is for. Reading on every
  // render would mean a synchronous `localStorage` read and a `JSON.parse` of
  // the whole payload on every keystroke into any field on the page — the
  // check-in screen has a search box directly above a roster of every member,
  // which is precisely the worst case. It is also what keeps `seed` stable, so
  // `restoredAt` below does not change identity under a re-render.
  const seedKey = `${cacheKey}\u0000${owner ?? ""}\u0000${enabled}`;
  const seedRef = useRef<{ key: string; hit: CacheHit<T> | null } | null>(null);
  if (seedRef.current?.key !== seedKey) {
    seedRef.current = {
      key: seedKey,
      hit: enabled
        ? readCache<T>(cacheKey, { version: PERSISTENT_QUERY_VERSION, owner, maxAgeMs, revive })
        : null,
    };
  }
  const seed = seedRef.current.hit;

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime,
    initialData: seed?.data,
    // Without this the seeded answer would count as having arrived just now, so
    // `staleTime` would hold it on screen without ever checking. Dating it
    // honestly is what makes the refresh-in-the-background half happen.
    initialDataUpdatedAt: seed?.savedAt,
  });

  const { data, isSuccess, isFetching } = query;

  useEffect(() => {
    if (!enabled || !isSuccess || data === undefined) return;
    // While a fetch is in flight, `data` is still the seeded copy. Writing then
    // would refresh its timestamp without refreshing its contents, and an entry
    // that keeps re-dating itself never expires.
    if (isFetching) return;
    writeCache(cacheKey, data, PERSISTENT_QUERY_VERSION, owner);
  }, [enabled, isSuccess, isFetching, data, cacheKey, owner]);

  // Only while what is on screen really is the stored copy: as soon as the
  // background refresh lands, `dataUpdatedAt` moves past it.
  const restoredAt = seed && query.dataUpdatedAt <= seed.savedAt ? seed.savedAt : null;

  return Object.assign(query, { restoredAt });
}
