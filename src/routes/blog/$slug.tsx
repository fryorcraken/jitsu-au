import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowBigUp } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { BlogVideoBlock } from "@/components/site/BlogVideoBlock";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/dates";
import { getBlogPostBySlug } from "@/lib/blog.functions";
import {
  getMyCommentUpvotes,
  listComments,
  postComment,
  toggleCommentUpvote,
} from "@/lib/blog-comments.functions";
import { splitBlogContent } from "@/lib/blog-content";
import { blogMarkdownComponents } from "@/lib/blog-markdown";
import { useAuth } from "@/hooks/useAuth";
import { buildPageMeta, canonicalUrl } from "@/lib/seo";
import { cn } from "@/lib/utils";

type BlogPostRow = NonNullable<Awaited<ReturnType<typeof getBlogPostBySlug>>>;

export const Route = createFileRoute("/blog/$slug")({
  // A slug with no published post behind it is a 404, not a page with a
  // "not found" body — the router's own notFoundComponent renders instead,
  // and this route's head() below never runs for it, so the meta/canonical it
  // sets can assume `post` is always real.
  loader: async ({ params }): Promise<{ post: BlogPostRow }> => {
    const post = await getBlogPostBySlug({ data: { slug: params.slug } });
    if (!post) throw notFound();
    return { post };
  },
  head: ({ loaderData, params }) => {
    const post = loaderData!.post;
    const path = `/blog/${params.slug}`;
    return {
      meta: buildPageMeta({
        title: `${post.title} | UTS Jitsu Blog`,
        description: post.excerpt || "News, tips and updates from UTS Jitsu.",
        path,
      }),
      links: [{ rel: "canonical", href: canonicalUrl(path) }],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: post.title,
            datePublished: post.published_at,
            description: post.excerpt || undefined,
            image: post.cover_image_url || undefined,
            mainEntityOfPage: canonicalUrl(path),
          }),
        },
      ],
    };
  },
  component: BlogPostPage,
});

type Comment = Awaited<ReturnType<typeof listComments>>[number];

const COMMENT_MAX = 2000;

function CommentComposer({
  placeholder,
  ariaLabel,
  busy,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  ariaLabel: string;
  busy: boolean;
  autoFocus?: boolean;
  /** Resolves to whether the post succeeded — the composer only clears itself
   * on success, so a failed submission never throws away what was typed. */
  onSubmit: (body: string, hp: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  const [hp, setHp] = useState("");
  const remaining = COMMENT_MAX - body.length;

  async function handleSubmit() {
    const ok = await onSubmit(body.trim(), hp);
    if (ok) setBody("");
  }

  return (
    <div className="space-y-2">
      <Textarea
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={3}
        maxLength={COMMENT_MAX}
      />
      {/* Honeypot: invisible and unreachable to a real person (visually
          hidden, aria-hidden, not tabbable) — only a script that blindly
          fills every field on the form will ever set this. */}
      <input
        type="text"
        name="hp"
        value={hp}
        onChange={(e) => setHp(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="sr-only"
      />
      {remaining <= 200 && (
        <p className="text-xs text-muted-foreground">{remaining} characters left</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !body.trim()} onClick={handleSubmit}>
          {busy ? "Posting..." : "Post"}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function UpvoteButton({
  comment,
  upvoted,
  onUpvote,
}: {
  comment: Comment;
  upvoted: boolean;
  onUpvote: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onUpvote(comment.id)}
      aria-pressed={upvoted}
      aria-label={
        upvoted
          ? `Remove your upvote — ${comment.upvote_count} upvotes`
          : `Upvote — ${comment.upvote_count} upvotes`
      }
      className={cn(
        "flex min-h-8 items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        upvoted
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input text-muted-foreground hover:bg-muted",
      )}
    >
      <ArrowBigUp className="h-3.5 w-3.5" aria-hidden="true" />
      {comment.upvote_count}
    </button>
  );
}

function CommentRow({
  comment,
  myUpvotes,
  onUpvote,
  onReply,
  replyBox,
}: {
  comment: Comment;
  myUpvotes: Set<string>;
  onUpvote: (id: string) => void;
  onReply: (() => void) | null;
  replyBox: ReactNode;
}) {
  const upvoted = myUpvotes.has(comment.id);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">{comment.author_name}</span>
        <span className="text-xs text-muted-foreground">{formatDate(comment.created_at)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{comment.body}</p>
      <div className="mt-2 flex items-center gap-3">
        <UpvoteButton comment={comment} upvoted={upvoted} onUpvote={onUpvote} />
        {onReply && (
          <button
            type="button"
            onClick={onReply}
            className="min-h-8 rounded px-1 text-xs text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Reply
          </button>
        )}
      </div>
      {replyBox}
    </div>
  );
}

function BlogPostPage() {
  const { post } = Route.useLoaderData() as { post: BlogPostRow };
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchComments = useServerFn(listComments);
  const fetchMyUpvotes = useServerFn(getMyCommentUpvotes);
  const sendComment = useServerFn(postComment);
  const sendUpvote = useServerFn(toggleCommentUpvote);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  // Which composer is mid-submit: a comment id for a reply, "root" for the
  // main box, or null — keyed per composer so posting a reply doesn't also
  // disable the unrelated root composer (and vice versa).
  const [postingFor, setPostingFor] = useState<string | "root" | null>(null);

  const commentsKey = ["blog-comments", post.id] as const;
  const upvotesKey = ["my-comment-upvotes"] as const;

  const commentsQ = useQuery({
    queryKey: commentsKey,
    queryFn: () => fetchComments({ data: { post_id: post.id } }),
    staleTime: 15_000,
  });
  const upvotesQ = useQuery({
    queryKey: upvotesKey,
    queryFn: () => fetchMyUpvotes(),
    enabled: Boolean(user),
    staleTime: 15_000,
  });

  const comments = commentsQ.data ?? [];
  const myUpvotes = new Set(upvotesQ.data ?? []);
  const topLevel = comments.filter((c) => !c.parent_comment_id);
  const repliesFor = (id: string) => comments.filter((c) => c.parent_comment_id === id);

  async function refreshComments() {
    await queryClient.invalidateQueries({ queryKey: commentsKey });
  }

  async function submitComment(
    body: string,
    hp: string,
    parentCommentId?: string,
  ): Promise<boolean> {
    const busyKey = parentCommentId ?? "root";
    setPostingFor(busyKey);
    try {
      await sendComment({
        data: { post_id: post.id, parent_comment_id: parentCommentId, body, hp },
      });
      setReplyingTo(null);
      toast.success(parentCommentId ? "Reply posted" : "Comment posted");
      await refreshComments();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not post your comment");
      return false;
    } finally {
      setPostingFor(null);
    }
  }

  async function upvote(commentId: string) {
    if (!user) {
      navigate({ to: "/auth", search: { redirect: `/blog/${post.slug}` } });
      return;
    }
    const wasUpvoted = myUpvotes.has(commentId);
    const prevComments = queryClient.getQueryData<Comment[]>(commentsKey);
    const prevUpvotes = queryClient.getQueryData<string[]>(upvotesKey);

    // Reflect the change immediately — the button toggling only after a full
    // round trip (and a full comment-list refetch) read as unresponsive
    // enough that the natural response was to click again, which toggled the
    // vote straight back off.
    queryClient.setQueryData<Comment[]>(commentsKey, (old) =>
      (old ?? []).map((c) =>
        c.id === commentId ? { ...c, upvote_count: c.upvote_count + (wasUpvoted ? -1 : 1) } : c,
      ),
    );
    queryClient.setQueryData<string[]>(upvotesKey, (old) =>
      wasUpvoted ? (old ?? []).filter((id) => id !== commentId) : [...(old ?? []), commentId],
    );

    try {
      const res = await sendUpvote({ data: { comment_id: commentId } });
      // Reconcile with the server's authoritative count/state rather than
      // trusting the optimistic guess, which the toggle function itself
      // already computed and handed back for exactly this purpose.
      queryClient.setQueryData<Comment[]>(commentsKey, (old) =>
        (old ?? []).map((c) => (c.id === commentId ? { ...c, upvote_count: res.count } : c)),
      );
      queryClient.setQueryData<string[]>(upvotesKey, (old) => {
        const withoutIt = (old ?? []).filter((id) => id !== commentId);
        return res.upvoted ? [...withoutIt, commentId] : withoutIt;
      });
    } catch (e) {
      queryClient.setQueryData(commentsKey, prevComments);
      queryClient.setQueryData(upvotesKey, prevUpvotes);
      toast.error(e instanceof Error ? e.message : "Could not update your upvote");
    }
  }

  return (
    <SiteLayout>
      <article className="mx-auto max-w-3xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          <Link to="/blog" className="hover:underline">
            Blog
          </Link>
        </p>
        <h1 className="mt-3 text-balance text-4xl font-bold md:text-5xl">{post.title}</h1>
        {post.published_at && (
          <p className="mt-3 text-sm text-muted-foreground">
            <time dateTime={post.published_at}>{formatDate(post.published_at)}</time>
          </p>
        )}
        {post.cover_image_url && (
          <img
            src={post.cover_image_url}
            alt=""
            className="mt-6 max-h-[28rem] w-full rounded-2xl object-cover"
          />
        )}

        <div className="mt-8 max-w-none">
          {splitBlogContent(post.body_md).map((block, i) =>
            block.type === "video" ? (
              <BlogVideoBlock key={i} url={block.url} title={post.title} />
            ) : (
              <ReactMarkdown key={i} components={blogMarkdownComponents}>
                {block.text}
              </ReactMarkdown>
            ),
          )}
        </div>

        <section className="mt-16 border-t pt-10">
          <h2 className="text-xl font-bold">Comments</h2>

          {commentsQ.isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading comments...</p>
          ) : commentsQ.isError ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Couldn't load comments.{" "}
              <button type="button" className="underline" onClick={() => commentsQ.refetch()}>
                Try again
              </button>
            </p>
          ) : topLevel.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            <div className="mt-6 space-y-6">
              {topLevel.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  myUpvotes={myUpvotes}
                  onUpvote={upvote}
                  onReply={user ? () => setReplyingTo(comment.id) : null}
                  replyBox={
                    <div className="mt-3 space-y-4">
                      {replyingTo === comment.id && (
                        <div className="ml-6 border-l pl-4">
                          <CommentComposer
                            placeholder="Write a reply..."
                            ariaLabel={`Reply to ${comment.author_name}`}
                            autoFocus
                            busy={postingFor === comment.id}
                            onSubmit={(body, hp) => submitComment(body, hp, comment.id)}
                            onCancel={() => setReplyingTo(null)}
                          />
                        </div>
                      )}
                      {repliesFor(comment.id).map((reply) => (
                        <div key={reply.id} className="ml-6 border-l pl-4">
                          <CommentRow
                            comment={reply}
                            myUpvotes={myUpvotes}
                            onUpvote={upvote}
                            onReply={null}
                            replyBox={null}
                          />
                        </div>
                      ))}
                    </div>
                  }
                />
              ))}
            </div>
          )}

          <div className="mt-8 border-t pt-6">
            {user ? (
              <CommentComposer
                placeholder="Add a comment..."
                ariaLabel="Add a comment"
                busy={postingFor === "root"}
                onSubmit={(body, hp) => submitComment(body, hp)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                <Link
                  to="/auth"
                  search={{ redirect: `/blog/${post.slug}` }}
                  className="text-primary underline underline-offset-4"
                >
                  Log in
                </Link>{" "}
                to join the conversation.
              </p>
            )}
          </div>
        </section>
      </article>
    </SiteLayout>
  );
}
