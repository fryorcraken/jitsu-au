import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";

import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { Button } from "@/components/ui/button";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { blogMarkdownComponents } from "@/lib/blog-markdown";
import { CLUB_MESSAGE_GROUP_LABELS, peopleCount } from "@/lib/club-message";
import { finishClubMessage, getClubMessage } from "@/lib/club-message.functions";
import { formatDateTime } from "@/lib/dates";
import { describeLoadError } from "@/lib/load-error";
import { ANNOUNCE_SUBMIT } from "@/lib/submit-resilience";

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
  const finish = useServerFn(finishClubMessage);
  // Finishing is keyed on the message's own id on the server, so a retry, or
  // two managers pressing at once, sends nobody a second copy.
  const finishing =
    useResilientSubmit<Awaited<ReturnType<typeof finishClubMessage>>>(ANNOUNCE_SUBMIT);
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

  async function sendRest() {
    const outcome = await finishing.submit({
      run: (signal) => finish({ signal, data: { id } }),
    });
    if (!outcome.ok) return;
    const { recipients, emailed, pending } = outcome.value;
    setMessage((m) => (m ? { ...m, recipients, emailed, pending } : m));
    finishing.reset();
  }

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
                ...(message.person_count > 0
                  ? [`${peopleCount(message.person_count)} picked one by one`]
                  : []),
                ...(message.lead_count > 0
                  ? [`${peopleCount(message.lead_count)} from the leads`]
                  : []),
              ].join(", ") || "Nobody"}
            </dd>
            <dt className="font-medium">Emails</dt>
            <dd>
              {message.emailed} of {message.recipients} sent
              {message.pending > 0 ? `. ${message.pending} still to go.` : "."}
            </dd>
          </dl>
          {message.pending > 0 && (
            <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
              <p className="text-sm">
                Members still waiting get it with tomorrow morning's summary email. Leads only get
                it when you send the rest. Nobody gets it twice.
              </p>
              <Button onClick={() => void sendRest()} disabled={finishing.busy}>
                {finishing.busy ? "Sending..." : "Send the rest now"}
              </Button>
              <SubmitStatus
                status={finishing.status}
                attempt={finishing.attempt}
                attempts={finishing.attempts}
                error={finishing.error}
                failureKind={finishing.failureKind}
                onRetry={() => void sendRest()}
              />
            </div>
          )}
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
