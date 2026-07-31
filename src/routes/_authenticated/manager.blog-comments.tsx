import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/site/StatusPill";
import { blogCommentClass } from "@/lib/status-colours";
import { formatDateTime } from "@/lib/dates";
import {
  blockCommenter,
  listBlockedCommenters,
  listCommentsForModeration,
  setCommentVisibility,
  unblockCommenter,
} from "@/lib/blog-comments.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/blog-comments")({
  head: () => ({
    meta: [{ title: "Blog comments | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: BlogCommentsPage,
});

type CommentRow = Awaited<ReturnType<typeof listCommentsForModeration>>[number];
type BlockedRow = Awaited<ReturnType<typeof listBlockedCommenters>>[number];

function BlogCommentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchComments = useServerFn(listCommentsForModeration);
  const fetchBlocked = useServerFn(listBlockedCommenters);
  const setVisibility = useServerFn(setCommentVisibility);
  const block = useServerFn(blockCommenter);
  const unblock = useServerFn(unblockCommenter);

  const [comments, setComments] = useState<CommentRow[]>([]);
  const [blocked, setBlocked] = useState<BlockedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  function refresh() {
    return Promise.all([
      fetchComments({ data: {} }).then(setComments),
      fetchBlocked().then(setBlocked),
    ]);
  }

  useEffect(() => {
    if (!isManager) return;
    refresh()
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not load comments"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  async function onHide(comment: CommentRow) {
    const reason = window.prompt("Reason for hiding this comment (optional):") ?? "";
    setBusyId(comment.id);
    try {
      await setVisibility({ data: { id: comment.id, status: "hidden", reason } });
      toast.success("Comment hidden");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not hide that comment");
    } finally {
      setBusyId(null);
    }
  }

  async function onUnhide(comment: CommentRow) {
    setBusyId(comment.id);
    try {
      await setVisibility({ data: { id: comment.id, status: "visible" } });
      toast.success("Comment restored");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore that comment");
    } finally {
      setBusyId(null);
    }
  }

  async function onBlock(comment: CommentRow) {
    if (
      !window.confirm(
        `Block ${comment.author_name} from commenting anywhere on the blog? This is the extreme option — use "Hide" for just this comment.`,
      )
    )
      return;
    const reason = window.prompt("Reason (optional):") ?? "";
    setBusyId(comment.id);
    try {
      await block({ data: { user_id: comment.user_id, reason } });
      toast.success(`${comment.author_name} is now blocked from commenting`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not block that person");
    } finally {
      setBusyId(null);
    }
  }

  async function onUnblock(row: BlockedRow) {
    setBusyId(row.user_id);
    try {
      await unblock({ data: { user_id: row.user_id } });
      toast.success(`${row.name} can comment again`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unblock that person");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="p-8">Loading...</div>;

  const blockedUserIds = new Set(blocked.map((b) => b.user_id));

  return (
    <section className="mx-auto max-w-6xl space-y-10 px-4 py-10">
      <div>
        <h1 className="text-3xl font-black">Blog comments</h1>
        <p className="text-sm text-muted-foreground">
          Hide an individual comment, or block a person from commenting anywhere on the blog.
        </p>
      </div>

      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-3">Post</th>
                <th className="p-3">Author</th>
                <th className="p-3">Comment</th>
                <th className="p-3">Status</th>
                <th className="p-3">Posted</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {comments.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className="p-3">
                    {c.post_slug ? (
                      <Link
                        to="/blog/$slug"
                        params={{ slug: c.post_slug }}
                        className="hover:underline"
                      >
                        {c.post_title}
                      </Link>
                    ) : (
                      c.post_title
                    )}
                  </td>
                  <td className="p-3">
                    <div>{c.author_name}</div>
                    {c.author_email && (
                      <div className="text-xs text-muted-foreground">{c.author_email}</div>
                    )}
                    {blockedUserIds.has(c.user_id) && (
                      <Pill label="blocked" className={blogCommentClass("hidden")} />
                    )}
                  </td>
                  <td className="max-w-sm p-3">
                    <p className="whitespace-pre-wrap">{c.body}</p>
                    {c.hidden_reason && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Reason: {c.hidden_reason}
                      </p>
                    )}
                  </td>
                  <td className="p-3">
                    <Pill label={c.status} className={blogCommentClass(c.status)} />
                  </td>
                  <td className="p-3 text-muted-foreground">{formatDateTime(c.created_at)}</td>
                  <td className="space-x-1 p-3 text-right">
                    {c.status === "visible" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === c.id}
                        onClick={() => onHide(c)}
                      >
                        Hide
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === c.id}
                        onClick={() => onUnhide(c)}
                      >
                        Unhide
                      </Button>
                    )}
                    {!blockedUserIds.has(c.user_id) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === c.id}
                        onClick={() => onBlock(c)}
                      >
                        Block author
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold">Blocked commenters</h2>
        <p className="text-sm text-muted-foreground">
          People blocked from commenting anywhere on the blog.
        </p>
        {blocked.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nobody is blocked.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">Reason</th>
                  <th className="p-3">Blocked</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {blocked.map((row) => (
                  <tr key={row.user_id} className="border-t">
                    <td className="p-3">{row.name}</td>
                    <td className="p-3 text-muted-foreground">{row.email ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{row.reason ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{formatDateTime(row.blocked_at)}</td>
                    <td className="p-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === row.user_id}
                        onClick={() => onUnblock(row)}
                      >
                        Unblock
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
