import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";

import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { blogMarkdownComponents } from "@/lib/blog-markdown";
import { CLUB_MESSAGE_GROUP_LABELS, peopleCount } from "@/lib/club-message";
import { getClubMessage } from "@/lib/club-message.functions";
import { formatDateTime } from "@/lib/dates";
import { describeLoadError } from "@/lib/load-error";

export const Route = createFileRoute("/_authenticated/manager/messages_/$id")({
  head: () => ({
    meta: [{ title: "Sent message | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SentMessagePage,
});

type Message = Awaited<ReturnType<typeof getClubMessage>>;

/** One sent message, exactly as it went, and who it reached. */
function SentMessagePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchMessage = useServerFn(getClubMessage);
  const [message, setMessage] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useCallback(() => {
    setError(null);
    fetchMessage({ data: { id } })
      .then(setMessage)
      .catch((e) => setError(describeLoadError(e, "Could not load this message")));
  }, [fetchMessage, id]);

  useEffect(() => {
    if (isManager) load();
  }, [isManager, load]);

  return (
    <div className="space-y-6">
      <Link to="/manager/messages" className="text-sm underline underline-offset-2">
        Back to messages
      </Link>
      {error ? (
        <LoadFailure what="This message" message={error} onRetry={load} />
      ) : !message ? (
        <Loading label="Loading the message..." />
      ) : (
        <article className="space-y-4">
          <div>
            <h1 className="text-3xl font-black">{message.subject}</h1>
            <p className="text-sm text-muted-foreground">
              Club notice, sent {formatDateTime(message.sent_at)}
              {message.sent_by_name ? ` by ${message.sent_by_name}` : ""}.
            </p>
          </div>
          <dl className="grid gap-1 rounded-lg border p-4 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
            <dt className="font-medium">Sent to</dt>
            <dd>
              {[
                ...message.groups.map((g) => CLUB_MESSAGE_GROUP_LABELS[g]),
                ...(message.lead_count > 0
                  ? [`${peopleCount(message.lead_count)} from the leads`]
                  : []),
              ].join(", ") || "Nobody"}
            </dd>
            <dt className="font-medium">Emails</dt>
            <dd>
              {message.emailed} of {message.recipients} sent
              {message.pending > 0
                ? `. The other ${message.pending} go with tomorrow morning's summary email, or press "Send the rest now" on the Messages screen.`
                : "."}
            </dd>
          </dl>
          <div className="rounded-lg border p-4">
            <ReactMarkdown components={blogMarkdownComponents} skipHtml>
              {message.body}
            </ReactMarkdown>
          </div>
        </article>
      )}
    </div>
  );
}
