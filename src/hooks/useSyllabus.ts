// The member's syllabus, fetched once and kept on the device.
//
// The whole syllabus is a few dozen short blocks, so it comes down in one call
// and the page picks a belt and a topic out of it locally (`syllabusView`).
// That is what makes changing the belt or the topic instant, and what lets a
// member on the mat with no signal still read "everything up to green":
// grading is exactly when the reception in a basement gym is worst. Same cache
// rules as the knowledge base itself (`useKbNav`), and for the same reasons:
// keyed by reader, a week old at most, wiped on sign-out.
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/useAuth";
import { usePersistentQuery } from "@/hooks/use-persistent-query";
import { describeLoadError } from "@/lib/load-error";
import { KB_CACHE_MAX_AGE_MS, cacheReviver, syllabusCacheSchema } from "@/lib/kb-cache";
import { getSyllabus } from "@/lib/syllabus.functions";

type SyllabusPayload = Awaited<ReturnType<typeof getSyllabus>>;

/** As long as the knowledge base's own contents: it changes when a manager publishes. */
export const SYLLABUS_STALE_TIME = 5 * 60_000;

export function useSyllabus() {
  const { user, loading: authLoading } = useAuth();
  const fetchSyllabus = useServerFn(getSyllabus);
  const userId = user?.id ?? null;
  const query = usePersistentQuery<SyllabusPayload>({
    queryKey: ["kb-syllabus", userId],
    queryFn: () => fetchSyllabus(),
    // The server works out the reader from the bearer token; asking before auth
    // settles would cache the signed-out answer (nothing) for a signed-in member.
    enabled: !authLoading,
    staleTime: SYLLABUS_STALE_TIME,
    cacheKey: `kb-syllabus.${userId ?? "anon"}`,
    owner: userId,
    maxAgeMs: KB_CACHE_MAX_AGE_MS,
    revive: cacheReviver<SyllabusPayload>(syllabusCacheSchema),
  });
  // Keyed on having NO data, never on `isError` alone: a failed refresh over a
  // stored copy is a staleness notice, not a reason to hide the syllabus.
  const failedOutright = query.isError && !query.data;
  return {
    data: query.data ?? null,
    loading: authLoading || query.isLoading,
    error: failedOutright ? describeLoadError(query.error, "Could not load the syllabus") : null,
    refetch: () => void query.refetch(),
    restoredAt: query.isError ? query.restoredAt : null,
  };
}
