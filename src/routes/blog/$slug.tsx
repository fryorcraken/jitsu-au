import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowBigUp } from "lucide-react";
import { SiteLayout } from "@/components/site/SiteLayout";
import { YouTubeEmbed } from "@/components/site/YouTubeEmbed";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { formatDate } from "@/lib/dates";
import { getBlogPostBySlug } from "@/lib/blog.functions";
import {
  getMyCommentUpvotes,
  listComments,
  postComment,
  toggleCommentUpvote,
} from "@/lib/blog-comments.functions";
import { extractYouTubeId, splitBlogContent } from "@/lib/blog-content";
import { useAuth } from "@/hooks/useAuth";
import { buildPageMeta, canonicalUrl } from "@/lib/seo";

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

function CommentComposer({
  placeholder,
  busy,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  busy: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState("");
  return (
    <div className="space-y-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={3}
        maxLength={2000}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !body.trim()}
          onClick={() => {
            onSubmit(body.trim());
            setBody("");
          }}
        >
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
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback>{comment.author_name.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{comment.author_name}</span>
          <span className="text-xs text-muted-foreground">{formatDate(comment.created_at)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onUpvote(comment.id)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
              upvoted ? "border-primary text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <ArrowBigUp className="h-3.5 w-3.5" />
            {comment.upvote_count}
          </button>
          {onReply && (
            <button
              type="button"
              onClick={onReply}
              className="text-xs text-muted-foreground hover:underline"
            >
              Reply
            </button>
          )}
        </div>
        {replyBox}
      </div>
    </div>
  );
}

function BlogPostPage() {
  const { post } = Route.useLoaderData() as { post: BlogPostRow };
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fetchComments = useServerFn(listComments);
  const fetchMyUpvotes = useServerFn(getMyCommentUpvotes);
  const sendComment = useServerFn(postComment);
  const sendUpvote = useServerFn(toggleCommentUpvote);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const commentsQ = useQuery({
    queryKey: ["blog-comments", post.id],
    queryFn: () => fetchComments({ data: { post_id: post.id } }),
    staleTime: 15_000,
  });
  const upvotesQ = useQuery({
    queryKey: ["my-comment-upvotes"],
    queryFn: () => fetchMyUpvotes(),
    enabled: Boolean(user),
    staleTime: 15_000,
  });

  const comments = commentsQ.data ?? [];
  const myUpvotes = new Set(upvotesQ.data ?? []);
  const topLevel = comments.filter((c) => !c.parent_comment_id);
  const repliesFor = (id: string) => comments.filter((c) => c.parent_comment_id === id);

  async function refreshComments() {
    await queryClient.invalidateQueries({ queryKey: ["blog-comments", post.id] });
  }

  async function submitComment(body: string, parentCommentId?: string) {
    setPosting(true);
    try {
      await sendComment({ data: { post_id: post.id, parent_comment_id: parentCommentId, body } });
      setReplyingTo(null);
      await refreshComments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not post your comment");
    } finally {
      setPosting(false);
    }
  }

  async function upvote(commentId: string) {
    try {
      await sendUpvote({ data: { comment_id: commentId } });
      await Promise.all([
        refreshComments(),
        queryClient.invalidateQueries({ queryKey: ["my-comment-upvotes"] }),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update your upvote");
    }
  }

  return (
    <SiteLayout>
      <article className="mx-auto max-w-3xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          <Link to="/blog">Blog</Link>
        </p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">{post.title}</h1>
        {post.published_at && (
          <p className="mt-3 text-sm text-muted-foreground">{formatDate(post.published_at)}</p>
        )}
        {post.cover_image_url && (
          <img src={post.cover_image_url} alt="" className="mt-6 w-full rounded-2xl object-cover" />
        )}

        <div className="prose prose-neutral mt-8 max-w-none dark:prose-invert">
          {splitBlogContent(post.body_md).map((block, i) =>
            block.type === "video" ? (
              (() => {
                const videoId = extractYouTubeId(block.url);
                return videoId ? (
                  <YouTubeEmbed
                    key={i}
                    videoId={videoId}
                    title={post.title}
                    className="not-prose my-6"
                  />
                ) : (
                  <p key={i}>
                    <a href={block.url} target="_blank" rel="noreferrer">
                      Watch the video ↗
                    </a>
                  </p>
                );
              })()
            ) : (
              <ReactMarkdown key={i}>{block.text}</ReactMarkdown>
            ),
          )}
        </div>

        <section className="mt-16 border-t pt-10">
          <h2 className="text-xl font-bold">Comments</h2>

          {commentsQ.isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading comments...</p>
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
                        <div className="ml-2">
                          <CommentComposer
                            placeholder="Write a reply..."
                            busy={posting}
                            onSubmit={(body) => submitComment(body, comment.id)}
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
                busy={posting}
                onSubmit={(body) => submitComment(body)}
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
