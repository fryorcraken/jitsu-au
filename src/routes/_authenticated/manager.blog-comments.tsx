import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/site/StatusPill";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { blogCommentClass } from "@/lib/status-colours";
import { formatDateTime } from "@/lib/dates";
import {
  blockCommenter,
  countRepliesByParent,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  // Two separate id-spaces — a comment id and its author's user id are never
  // the same value, but keying both actions off one shared `busyId` state
  // meant blocking an author never disabled anything in the Blocked
  // commenters panel below, and vice versa.
  const [busyCommentId, setBusyCommentId] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [hideTarget, setHideTarget] = useState<CommentRow | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [blockTarget, setBlockTarget] = useState<CommentRow | null>(null);
  const [blockReason, setBlockReason] = useState("");

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  function refresh() {
    return Promise.all([
      fetchComments({ data: {} }).then(setComments),
      fetchBlocked().then(setBlocked),
    ]);
  }

  // `refresh()` on its own is called after a hide or a block, where the action's
  // own handler reports a failure; this wrapper is the one the screen loads
  // through and the one "Try again" repeats.
  const load = useMemo(
    () => () => {
      setLoading(true);
      return refresh()
        .then(() => setLoadError(null))
        .catch((e) => {
          const message = describeLoadError(e, "Could not load comments");
          setLoadError(message);
          toast.error(message);
        })
        .finally(() => setLoading(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!isManager) return;
    void load();
  }, [isManager, load]);

  async function confirmHide() {
    if (!hideTarget) return;
    setBusyCommentId(hideTarget.id);
    try {
      await setVisibility({
        data: { id: hideTarget.id, status: "hidden", reason: hideReason.trim() },
      });
      toast.success("Comment hidden");
      setHideTarget(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not hide that comment");
    } finally {
      setBusyCommentId(null);
    }
  }

  async function onUnhide(comment: CommentRow) {
    setBusyCommentId(comment.id);
    try {
      await setVisibility({ data: { id: comment.id, status: "visible" } });
      toast.success("Comment restored");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore that comment");
    } finally {
      setBusyCommentId(null);
    }
  }

  async function confirmBlock() {
    if (!blockTarget) return;
    setBusyUserId(blockTarget.user_id);
    try {
      await block({ data: { user_id: blockTarget.user_id, reason: blockReason.trim() } });
      toast.success(`${blockTarget.author_name} is now blocked from commenting`);
      setBlockTarget(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not block that person");
    } finally {
      setBusyUserId(null);
    }
  }

  async function onUnblock(row: BlockedRow) {
    setBusyUserId(row.user_id);
    try {
      await unblock({ data: { user_id: row.user_id } });
      toast.success(`${row.name} can comment again`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unblock that person");
    } finally {
      setBusyUserId(null);
    }
  }

  if (loading) return <Loading className="p-8" />;

  const blockedUserIds = new Set(blocked.map((b) => b.user_id));
  const replyCountByParent = countRepliesByParent(comments);
  const hideTargetReplyCount = hideTarget ? (replyCountByParent.get(hideTarget.id) ?? 0) : 0;

  return (
    <section className="mx-auto max-w-6xl space-y-10 px-4 py-10">
      <div>
        <h1 className="text-3xl font-black">Blog comments</h1>
        <p className="text-sm text-muted-foreground">
          Hide an individual comment, or block a person from commenting anywhere on the blog.
        </p>
      </div>

      {loadError ? (
        <LoadFailure
          what="The comments"
          message={loadError}
          hint="This is not the same as there being nothing to moderate."
          onRetry={() => void load()}
        />
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-3">
                  Post
                </th>
                <th scope="col" className="p-3">
                  Author
                </th>
                <th scope="col" className="p-3">
                  Comment
                </th>
                <th scope="col" className="p-3">
                  Status
                </th>
                <th scope="col" className="p-3">
                  Posted
                </th>
                <th scope="col" className="p-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {comments.map((c) => {
                const replyCount = replyCountByParent.get(c.id) ?? 0;
                return (
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
                      {c.parent_comment_id && (
                        <span className="mr-1 text-xs text-muted-foreground">↳ reply</span>
                      )}
                      <div>{c.author_name}</div>
                      {c.author_email && (
                        <div className="text-xs text-muted-foreground">{c.author_email}</div>
                      )}
                      {blockedUserIds.has(c.user_id) && (
                        <Pill label="blocked" className={blogCommentClass("hidden")} />
                      )}
                    </td>
                    <td className="max-w-sm p-3">
                      <p className="whitespace-pre-wrap break-words">{c.body}</p>
                      {replyCount > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {replyCount} {replyCount === 1 ? "reply" : "replies"}
                        </p>
                      )}
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
                          disabled={busyCommentId === c.id}
                          onClick={() => {
                            setHideReason("");
                            setHideTarget(c);
                          }}
                        >
                          Hide
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyCommentId === c.id}
                          onClick={() => onUnhide(c)}
                        >
                          Unhide
                        </Button>
                      )}
                      {!blockedUserIds.has(c.user_id) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={busyUserId === c.user_id}
                          onClick={() => {
                            setBlockReason("");
                            setBlockTarget(c);
                          }}
                        >
                          Block author
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold">Blocked commenters</h2>
        <p className="text-sm text-muted-foreground">
          People blocked from commenting anywhere on the blog.
        </p>
        {loadError ? (
          <p className="mt-3 text-sm text-muted-foreground">
            This list could not be loaded either, so it is not saying nobody is blocked.
          </p>
        ) : blocked.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nobody is blocked.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="p-3">
                    Name
                  </th>
                  <th scope="col" className="p-3">
                    Email
                  </th>
                  <th scope="col" className="p-3">
                    Reason
                  </th>
                  <th scope="col" className="p-3">
                    Blocked
                  </th>
                  <th scope="col" className="p-3">
                    <span className="sr-only">Actions</span>
                  </th>
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
                        disabled={busyUserId === row.user_id}
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

      <Dialog open={Boolean(hideTarget)} onOpenChange={(open) => !open && setHideTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hide this comment?</DialogTitle>
            <DialogDescription>
              It stops showing on the public post immediately. You can unhide it later.
            </DialogDescription>
          </DialogHeader>
          {hideTarget && (
            <div className="space-y-3">
              <p className="rounded-md border bg-muted/40 p-3 text-sm">{hideTarget.body}</p>
              {hideTargetReplyCount > 0 && (
                <p className="text-sm text-amber-600 dark:text-amber-500">
                  This comment has {hideTargetReplyCount}{" "}
                  {hideTargetReplyCount === 1 ? "reply" : "replies"}. Hiding it also removes{" "}
                  {hideTargetReplyCount === 1 ? "that reply" : "those replies"} from the post. They
                  stay marked visible, they just have nowhere left to show.
                </p>
              )}
              <div>
                <Label htmlFor="hide-reason">Reason (optional, for your own records)</Label>
                <Textarea
                  id="hide-reason"
                  autoFocus
                  value={hideReason}
                  onChange={(e) => setHideReason(e.target.value)}
                  maxLength={500}
                  rows={3}
                  className="mt-1.5"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setHideTarget(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={busyCommentId === hideTarget?.id} onClick={confirmHide}>
              {busyCommentId === hideTarget?.id ? "Hiding..." : "Hide comment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(blockTarget)} onOpenChange={(open) => !open && setBlockTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Block {blockTarget?.author_name} from commenting?</DialogTitle>
            <DialogDescription>
              This is the extreme option. It stops them commenting anywhere on the blog from now on.
              It does not hide comments they've already posted (use "Hide" on this row for just this
              one).
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="block-reason">Reason (optional, for your own records)</Label>
            <Textarea
              id="block-reason"
              autoFocus
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              maxLength={500}
              rows={3}
              className="mt-1.5"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBlockTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busyUserId === blockTarget?.user_id}
              onClick={confirmBlock}
            >
              {busyUserId === blockTarget?.user_id ? "Blocking..." : "Block"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
