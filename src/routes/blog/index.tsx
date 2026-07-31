import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SiteLayout } from "@/components/site/SiteLayout";
import { formatDate } from "@/lib/dates";
import { blogListSearchSchema } from "@/lib/validation";
import { listPublishedBlogPosts } from "@/lib/blog.functions";
import { buildPageMeta } from "@/lib/seo";

type ListResult = Awaited<ReturnType<typeof listPublishedBlogPosts>>;
type LoaderData = { result: ListResult | null; error: boolean };

export const Route = createFileRoute("/blog/")({
  validateSearch: blogListSearchSchema,
  // Keyed on the `page` search param so navigating between pages re-runs the
  // loader (and, on the very first load of any page, ships real post links in
  // the server-rendered HTML rather than a client-only fetch — a blog list
  // with nothing in the initial markup is both bad for first paint and
  // invisible to a crawler that doesn't execute JS).
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }): Promise<LoaderData> => {
    try {
      return { result: await listPublishedBlogPosts({ data: { page: deps.page } }), error: false };
    } catch {
      return { result: null, error: true };
    }
  },
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
  const { result, error } = Route.useLoaderData() as LoaderData;

  const posts = result?.posts ?? [];
  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageOutOfRange = !error && total > 0 && page > totalPages;

  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Blog</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">News from the mat</h1>
        <p className="mt-4 text-muted-foreground">Updates, tips and stories from UTS Jitsu.</p>

        {error ? (
          <div className="mt-10 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm">
            <p>Something went wrong loading the blog.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => window.location.reload()}
            >
              Try again
            </Button>
          </div>
        ) : pageOutOfRange ? (
          <div className="mt-10 text-sm text-muted-foreground">
            <p>That page doesn't exist.</p>
            <Button asChild variant="outline" size="sm" className="mt-3">
              <Link to="/blog" search={{ page: 1 }}>
                Back to the first page
              </Link>
            </Button>
          </div>
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
                    loading="lazy"
                    width={800}
                    height={192}
                    className="mb-4 h-48 w-full rounded-xl object-cover"
                  />
                )}
                <h2 className="text-balance text-2xl font-bold">
                  <Link to="/blog/$slug" params={{ slug: post.slug }} className="hover:underline">
                    {post.title}
                  </Link>
                </h2>
                {post.published_at && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    <time dateTime={post.published_at}>{formatDate(post.published_at)}</time>
                  </p>
                )}
                {post.excerpt && (
                  <p className="mt-3 break-words text-muted-foreground">{post.excerpt}</p>
                )}
                <Button asChild variant="link" className="mt-2 px-0">
                  <Link to="/blog/$slug" params={{ slug: post.slug }}>
                    Read more
                    <span className="sr-only">: {post.title}</span>
                  </Link>
                </Button>
              </article>
            ))}
          </div>
        )}

        {!error && !pageOutOfRange && totalPages > 1 && (
          <nav aria-label="Blog pagination" className="mt-10 flex items-center justify-between">
            {page > 1 ? (
              <Button asChild variant="outline">
                <Link to="/blog" search={{ page: page - 1 }}>
                  Previous
                </Link>
              </Button>
            ) : (
              <Button variant="outline" disabled aria-disabled="true">
                Previous
              </Button>
            )}
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            {page < totalPages ? (
              <Button asChild variant="outline">
                <Link to="/blog" search={{ page: page + 1 }}>
                  Next
                </Link>
              </Button>
            ) : (
              <Button variant="outline" disabled aria-disabled="true">
                Next
              </Button>
            )}
          </nav>
        )}
      </section>
    </SiteLayout>
  );
}
