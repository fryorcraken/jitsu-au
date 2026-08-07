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

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    let cancelled = false;
    fetchMessages({ data: {} })
      .then(async (result) => {
        if (cancelled) return;
        setMessages(result.messages);
        setUnreadIds(new Set(result.unreadIds));
        setLoadError(null);
        // Opening the inbox is what marks it read, like an email client. Fired
        // after the rows are in hand and best-effort: failing to stamp the
        // marker leaves the badge up, which is the safe direction to fail in.
        // Acknowledges the newest message actually listed rather than "now", so
        // one arriving while this page loaded is not marked read unseen.
        if (!result.newestAt) return;
        try {
          await markSeen({ data: { seen_at: result.newestAt } });
        } catch (e) {
          console.error("[manager/contact-messages] could not mark messages seen:", e);
        }
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : "Could not load the contact messages";
        if (!cancelled) setLoadError(message);
        toast.error(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
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
          Everything sent through the contact form, newest first. Every manager is emailed a copy as
          it arrives, so reply from your own inbox.
        </p>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium">The contact messages could not be loaded.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {loadError} This is not the same as having no messages. Reload the page to try again.
          </p>
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
