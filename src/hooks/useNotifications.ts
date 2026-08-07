// Everything on /notifications, fetched once and shared with the sidebar badge.
//
// Its own module rather than an export from the page or from `MemberLayout.tsx`
// because both need the same answer, and a file that exports a component and a
// hook loses React Fast Refresh. One query key means the badge and the list are
// reading the same object, so they cannot disagree about how many things are
// waiting.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useAuth } from "@/hooks/useAuth";
import { badgeCount } from "@/lib/notifications";
import { listMyNotifications, type NotificationsPayload } from "@/lib/notifications.functions";

/** The shared query key, exported so a mutation can invalidate it by hand. */
export function notificationsQueryKey(userId: string | null | undefined) {
  return ["notifications", userId ?? null] as const;
}

export function useNotifications(): {
  data: NotificationsPayload | undefined;
  loading: boolean;
  failed: boolean;
  badge: number;
  refresh: () => void;
} {
  const { user, loading: authLoading } = useAuth();
  const fetchAll = useServerFn(listMyNotifications);
  const queryClient = useQueryClient();

  const query = useQuery({
    // Keyed by WHO it was fetched for, the same reasoning as `useKbNav`:
    // `__root.tsx` does not invalidate the cache on SIGNED_OUT, and a bare
    // ["notifications"] would leave one person's replies on screen in a tab
    // whose session ended. Here that would be somebody else's comment traffic.
    queryKey: notificationsQueryKey(user?.id),
    queryFn: () => fetchAll(),
    // Nothing to ask for until we know who is asking.
    enabled: !authLoading && Boolean(user?.id),
    // The badge sits in the shell of every member-space page, so a stale count
    // is the normal state. A minute keeps it honest without a request per
    // navigation.
    staleTime: 60_000,
  });

  return {
    data: query.data,
    loading: authLoading || query.isLoading,
    // A failed fetch is NOT "you have nothing waiting". The page says the
    // honest thing and offers a retry instead, the same call `/account` makes
    // about a failed profile load.
    failed: query.isError,
    badge: query.data ? badgeCount(query.data.attention, query.data.items) : 0,
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: notificationsQueryKey(user?.id) });
    },
  };
}
