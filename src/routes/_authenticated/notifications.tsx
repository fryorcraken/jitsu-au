import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, Bell } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotificationSwitches } from "@/components/site/NotificationSwitches";
import { useNotifications } from "@/hooks/useNotifications";
import type { EmailPreferenceKey } from "@/lib/notifications";
import {
  markNotificationsRead,
  saveMyNotificationPreferences,
} from "@/lib/notifications.functions";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({
    meta: [{ title: "Notifications | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: NotificationsPage,
});

function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function NotificationsPage() {
  const { data, loading, failed, badge, refresh } = useNotifications();
  const markRead = useServerFn(markNotificationsRead);
  const savePrefs = useServerFn(saveMyNotificationPreferences);

  const [prefs, setPrefs] = useState<Record<EmailPreferenceKey, boolean> | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // Opening the page marks read exactly once, for the rows that were on screen
  // when it loaded. A notification that arrives while somebody is reading must
  // not be marked read without ever having been seen.
  const markedOnOpen = useRef(false);

  useEffect(() => {
    if (data && prefs === null) setPrefs(data.preferences);
  }, [data, prefs]);

  useEffect(() => {
    if (!data || markedOnOpen.current) return;
    const unread = data.items.filter((i) => i.read_at === null).map((i) => i.id);
    markedOnOpen.current = true;
    if (unread.length === 0) return;
    markRead({ data: { ids: unread } })
      .then(() => refresh())
      // Silent on failure: the notifications are all still on screen and the
      // only cost is a badge that clears on the next load. An error toast for
      // something the reader did not ask for would be noise.
      .catch(() => {});
  }, [data, markRead, refresh]);

  const markAll = useCallback(() => {
    markRead({ data: {} })
      .then(() => refresh())
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not mark those read."));
  }, [markRead, refresh]);

  const onSwitch = useCallback(
    (key: EmailPreferenceKey, next: boolean) => {
      // Optimistic: a switch that waits for a round trip before moving feels
      // broken. Reverted below if the save fails.
      const previous = prefs;
      setPrefs((p) => (p ? { ...p, [key]: next } : p));
      setSavingPrefs(true);
      savePrefs({ data: { [key]: next } })
        .then((saved) => setPrefs(saved))
        .catch((e) => {
          setPrefs(previous);
          toast.error(e instanceof Error ? e.message : "Could not save that.");
        })
        .finally(() => setSavingPrefs(false));
    },
    [prefs, savePrefs],
  );

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-black">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What has happened, and what needs doing.
        </p>
      </div>

      {failed && (
        <Card>
          <CardHeader>
            <CardTitle>We couldn't load your notifications</CardTitle>
            <CardDescription>
              Nothing is lost. This is usually a dropped connection, so try again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={refresh}>Try again</Button>
          </CardContent>
        </Card>
      )}

      {/* Standing problems. No read control on purpose: these clear by being
          fixed, and a "mark read" button would let a manager hide something
          that is still broken. */}
      {data && data.attention.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Needs attention
            </CardTitle>
            <CardDescription>
              Things only a manager can fix. They clear themselves once they are sorted.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.attention.map((n, i) => (
              <div
                key={`${n.type}-${i}`}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-4"
              >
                <div>
                  <p className="font-medium">{n.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{n.body}</p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link to={n.href}>{n.actionLabel}</Link>
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              Activity
            </CardTitle>
            <CardDescription>Replies, threads you are in, and new posts.</CardDescription>
          </div>
          {data && data.items.some((i) => i.read_at === null) && (
            <Button size="sm" variant="ghost" onClick={markAll}>
              Mark all as read
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {data && data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Replies to your comments will show up here.
            </p>
          )}
          {/* A plain anchor, not a router `Link`, for two reasons. These hrefs
              carry a fragment (`/blog/<slug>#comment-<id>`) that `Link` expects
              as a separate `hash` prop rather than inside `to`. And they come
              out of the DATABASE, not the route table: a row written by an
              older version of the app can name a path that no longer exists,
              which an anchor turns into the router's own not-found page instead
              of throwing on the notifications page itself. */}
          <div className="space-y-2">
            {data?.items.map((item) => (
              <a
                key={item.id}
                href={item.href}
                className={
                  item.read_at === null
                    ? "block rounded-lg border border-primary/40 bg-accent/40 p-4 transition-colors hover:bg-accent"
                    : "block rounded-lg border p-4 transition-colors hover:bg-accent/50"
                }
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{item.title}</p>
                  <span className="text-xs text-muted-foreground">{timeAgo(item.created_at)}</span>
                </div>
                {item.body && <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>}
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>Choose what reaches your inbox. Change it any time.</CardDescription>
        </CardHeader>
        <CardContent>
          {prefs ? (
            <NotificationSwitches
              values={prefs}
              onChange={onSwitch}
              disabled={savingPrefs}
              isManager={data?.isManager}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )}
        </CardContent>
      </Card>

      {/* Only rendered once loaded, so it never says "0 waiting" while the
          count is still unknown. */}
      {data && badge === 0 && (
        <p className="text-center text-sm text-muted-foreground">All caught up.</p>
      )}
    </section>
  );
}
