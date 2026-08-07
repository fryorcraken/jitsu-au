import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Pill } from "@/components/site/StatusPill";
import { UNREAD_CLASS } from "@/lib/status-colours";
import { formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  listContactMessages,
  markContactMessagesSeen,
  type ContactMessage,
} from "@/lib/contact-messages.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { useNotifications } from "@/hooks/useNotifications";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/manager/contact-messages")({
  head: () => ({
    meta: [{ title: "Contact messages | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ContactMessagesPage,
});

function ContactMessagesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchMessages = useServerFn(listContactMessages);
  const markSeen = useServerFn(markContactMessagesSeen);
  const { refresh: refreshNotifications } = useNotifications();

  const [messages, setMessages] = useState<ContactMessage[]>([]);
  // Which messages were unread when this page loaded. Captured before the marker
  // is stamped, so clearing the dashboard badge does not also lose the one thing
  // it was telling you: which of these you had not read yet.
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  // Distinguished from "no messages": telling a manager nobody wrote in, when
  // really the inbox could not be read, is the same false reassurance this
  // whole screen exists to end.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when the server had more messages than it returned. The seen marker is a
  // single watermark, so it cannot express "read the newest 200 but not the 50
  // behind them" — the server declines to move it, and this says why rather than
  // leaving a badge that will not clear look broken.
  const [hiddenOlder, setHiddenOlder] = useState(0);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  // Returns its own cancel flag so the mount effect can drop a late response,
  // while the "Try again" button calls it with nothing to cancel.
  function load(isCancelled: () => boolean = () => false) {
    setLoading(true);
    return fetchMessages({ data: {} })
      .then(async (result) => {
        if (isCancelled()) return;
        setMessages(result.messages);
        setUnreadIds(new Set(result.unreadIds));
        setLoadError(null);
        setHiddenOlder(result.truncated ? result.total - result.messages.length : 0);
        // Opening the inbox is what marks it read, like an email client. Fired
        // after the rows are in hand and best-effort: failing to stamp the
        // marker leaves the badge up, which is the safe direction to fail in.
        // Acknowledges the newest message actually listed rather than "now", so
        // one arriving while this page loaded is not marked read unseen. Null
        // when the list was truncated, which is the server declining to move a
        // watermark past messages it did not show.
        if (!result.newestAt) return;
        try {
          await markSeen({ data: { seen_at: result.newestAt } });
          // The sidebar badge and /notifications read one cached query with a
          // minute of staleness. Without this the manager is looking at the
          // messages while the badge still counts them, and going back shows the
          // same "Read it" item they just followed.
          if (!isCancelled()) refreshNotifications();
        } catch (e) {
          console.error("[manager/contact-messages] could not mark messages seen:", e);
        }
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : "Could not load the contact messages";
        if (isCancelled()) return;
        setLoadError(message);
        toast.error(message);
      })
      .finally(() => {
        if (!isCancelled()) setLoading(false);
      });
  }

  useEffect(() => {
    if (!isManager) return;
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  if (loading) return <div className="p-8">Loading...</div>;

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-black">Contact messages</h1>
        <p className="text-sm text-muted-foreground">
          Everything sent through the contact form, newest first. Reply from your own inbox: new
          messages are emailed to every manager as they arrive. Anything from before that was
          switched on is listed here only.
        </p>
      </div>

      {hiddenOlder > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">
            Showing the newest {messages.length}. {hiddenOlder} older{" "}
            {hiddenOlder === 1 ? "message is" : "messages are"} not on this page.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Because of that, none of these count as read yet and the notification stays up. Ask for
            paging on this screen if you need to work through the older ones.
          </p>
        </div>
      )}

      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium">The contact messages could not be loaded.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {loadError} This is not the same as having no messages.
          </p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-3">
                  Received
                </th>
                <th scope="col" className="p-3">
                  From
                </th>
                <th scope="col" className="p-3">
                  Subject
                </th>
                <th scope="col" className="p-3">
                  Message
                </th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className="border-t align-top">
                  <td className="whitespace-nowrap p-3 text-muted-foreground">
                    {formatDateTime(m.created_at)}
                    {unreadIds.has(m.id) && (
                      <Pill label="new" className={cn("ml-2", UNREAD_CLASS)} />
                    )}
                  </td>
                  <td className="p-3">
                    <div>{m.name}</div>
                    <a href={`mailto:${m.email}`} className="text-xs text-primary hover:underline">
                      {m.email}
                    </a>
                  </td>
                  <td className="p-3">{m.subject ?? "—"}</td>
                  <td className="max-w-md p-3">
                    <p className="whitespace-pre-wrap break-words">{m.message}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
