import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";

import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { blogMarkdownComponents } from "@/lib/blog-markdown";
import { getMyClubMessage } from "@/lib/club-message.functions";
import { formatDateTime } from "@/lib/dates";
import { describeLoadError } from "@/lib/load-error";

export const Route = createFileRoute("/_authenticated/messages/$id")({
  head: () => ({
    meta: [{ title: "Message from the club | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: MyMessagePage,
});

type Message = NonNullable<Awaited<ReturnType<typeof getMyClubMessage>>>;

/**
 * A club notice, as the member it was sent to reads it on the site. Where the
 * Notifications page links to, so somebody who missed the email can still
 * read the whole thing. Only a message that was sent to this inbox opens.
 */
function MyMessagePage() {
  const { id } = Route.useParams();
  const fetchMessage = useServerFn(getMyClubMessage);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "missing" }
    | { kind: "error"; message: string }
    | { kind: "ready"; message: Message }
  >({ kind: "loading" });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    fetchMessage({ data: { id } })
      .then((m) => setState(m ? { kind: "ready", message: m } : { kind: "missing" }))
      .catch((e) =>
        setState({ kind: "error", message: describeLoadError(e, "Could not load this message") }),
      );
  }, [fetchMessage, id]);

  useEffect(() => load(), [load]);

  return (
    <div className="space-y-6">
      <Link to="/notifications" className="text-sm underline underline-offset-2">
        Back to notifications
      </Link>
      {state.kind === "loading" ? (
        <Loading label="Loading the message..." />
      ) : state.kind === "error" ? (
        <LoadFailure what="This message" message={state.message} onRetry={load} />
      ) : state.kind === "missing" ? (
        <div className="rounded-lg border p-4">
          <h1 className="text-xl font-bold">This message isn't on your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been sent to a different email address. Your notifications list everything
            the club has sent you.
          </p>
        </div>
      ) : (
        <article className="space-y-4">
          <div>
            <h1 className="text-3xl font-black">{state.message.subject}</h1>
            <p className="text-sm text-muted-foreground">
              From the club, {formatDateTime(state.message.sent_at)}
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <ReactMarkdown components={blogMarkdownComponents} skipHtml>
              {state.message.body}
            </ReactMarkdown>
          </div>
        </article>
      )}
    </div>
  );
}
