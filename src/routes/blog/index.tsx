import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { blogListSearchSchema } from "@/lib/validation";
import { listPublishedBlogPosts } from "@/lib/blog.functions";
import { buildPageMeta } from "@/lib/seo";

export const Route = createFileRoute("/blog/")({
  validateSearch: blogListSearchSchema,
  head: () => ({
    meta: buildPageMeta({
      title: "Blog | UTS Jitsu",
      description:
        "News, tips and updates from UTS Jitsu, Japanese Jiu-Jitsu at UTS Ultimo, Sydney.",
      path: "/blog",
    }),
    links: [{ rel: "canonical", href: "https://jitsu.au/blog" }],
  }),
  component: BlogIndex,
});

function BlogIndex() {
  const { page } = Route.useSearch();
  const fetchPosts = useServerFn(listPublishedBlogPosts);
  const postsQ = useQuery({
    queryKey: ["blog-posts", page],
    queryFn: () => fetchPosts({ data: { page } }),
    staleTime: 60_000,
  });

  const posts = postsQ.data?.posts ?? [];
  const total = postsQ.data?.total ?? 0;
  const pageSize = postsQ.data?.pageSize ?? 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Blog</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">News from the mat</h1>
        <p className="mt-4 text-muted-foreground">Updates, tips and stories from UTS Jitsu.</p>

        {postsQ.isLoading ? (
          <p className="mt-10 text-sm text-muted-foreground">Loading...</p>
        ) : posts.length === 0 ? (
          <p className="mt-10 text-sm text-muted-foreground">No posts yet. Check back soon.</p>
        ) : (
          <div className="mt-10 space-y-6">
            {posts.map((post) => (
              <article key={post.id} className="rounded-2xl border bg-card p-6 shadow-sm">
                {post.cover_image_url && (
                  <img
                    src={post.cover_image_url}
                    alt=""
                    className="mb-4 h-48 w-full rounded-xl object-cover"
                  />
                )}
                <h2 className="text-2xl font-bold">
                  <Link to="/blog/$slug" params={{ slug: post.slug }} className="hover:underline">
                    {post.title}
                  </Link>
                </h2>
                {post.published_at && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(post.published_at)}
                  </p>
                )}
                {post.excerpt && <p className="mt-3 text-muted-foreground">{post.excerpt}</p>}
                <Button asChild variant="link" className="mt-2 px-0">
                  <Link to="/blog/$slug" params={{ slug: post.slug }}>
                    Read more
                  </Link>
                </Button>
              </article>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-10 flex items-center justify-between">
            <Button
              asChild
              variant="outline"
              className={page <= 1 ? "pointer-events-none opacity-50" : ""}
            >
              <Link to="/blog" search={{ page: Math.max(1, page - 1) }}>
                Previous
              </Link>
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              asChild
              variant="outline"
              className={page >= totalPages ? "pointer-events-none opacity-50" : ""}
            >
              <Link to="/blog" search={{ page: Math.min(totalPages, page + 1) }}>
                Next
              </Link>
            </Button>
          </div>
        )}
      </section>
    </SiteLayout>
  );
}
