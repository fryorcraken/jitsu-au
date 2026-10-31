import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteLayout } from "@/components/site/SiteLayout";
import { formatDate } from "@/lib/dates";
import { BLOG_POST_KIND_LABELS, blogListSearchSchema } from "@/lib/validation";
import { listPublishedBlogPosts } from "@/lib/blog.functions";
import { buildPageMeta, canonicalUrl } from "@/lib/seo";
import { cn } from "@/lib/utils";

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
        "Articles on training and self-defence, and the latest club news from UTS Jitsu, Japanese Jiu-Jitsu at UTS Ultimo, Sydney.",
      path: "/blog",
    }),
    links: [{ rel: "canonical", href: canonicalUrl("/blog") }],
  }),
  component: BlogIndex,
});

type Article = ListResult["articles"][number];
type Update = ListResult["posts"][number];

/**
 * An article on the blog list: a large card, the whole of it one link, so a
 * thumb anywhere on it opens the piece. Reading time where an update would put
 * its date, because when an article was written is not why anybody opens it.
 */
function ArticleCard({ article }: { article: Article }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-primary/25 bg-secondary/60 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring hover:shadow-md">
      {article.cover_image_url && (
        <img
          src={article.cover_image_url}
          alt=""
          loading="lazy"
          width={800}
          height={224}
          className="h-48 w-full object-cover md:h-56"
        />
      )}
      <div className="flex flex-1 flex-col p-6">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
          {BLOG_POST_KIND_LABELS.article}
          <span aria-hidden="true">·</span>
          <span className="normal-case tracking-normal text-muted-foreground">
            {article.reading_minutes} min read
          </span>
        </p>
        <h3 className="mt-2 text-balance text-2xl font-bold">
          <Link
            to="/blog/$slug"
            params={{ slug: article.slug }}
            // Stretched over the card: the title is the link a screen reader
            // hears, and the rest of the card is just a bigger target for it.
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none group-hover:underline"
          >
            {article.title}
          </Link>
        </h3>
        {article.excerpt && (
          <p className="mt-3 break-words text-muted-foreground">{article.excerpt}</p>
        )}
        <p className="mt-auto pt-4 text-sm font-semibold text-primary" aria-hidden="true">
          Read the article →
        </p>
      </div>
    </article>
  );
}

/** A club update: one row of a dated feed, newest first. */
function UpdateRow({ post }: { post: Update }) {
  return (
    <article className="flex gap-4 py-5">
      <div className="min-w-0 flex-1">
        {post.published_at && (
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <time dateTime={post.published_at}>{formatDate(post.published_at)}</time>
          </p>
        )}
        <h3 className="mt-1 text-balance text-lg font-bold">
          <Link to="/blog/$slug" params={{ slug: post.slug }} className="hover:underline">
            {post.title}
          </Link>
        </h3>
        {post.excerpt && (
          <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">
            {post.excerpt}
          </p>
        )}
      </div>
      {post.cover_image_url && (
        <img
          src={post.cover_image_url}
          alt=""
          loading="lazy"
          width={112}
          height={80}
          className="h-20 w-28 shrink-0 rounded-lg object-cover"
        />
      )}
    </article>
  );
}

function BlogIndex() {
  const { page } = Route.useSearch();
  const { result, error } = Route.useLoaderData() as LoaderData;

  const articles = result?.articles ?? [];
  const posts = result?.posts ?? [];
  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Past the last page of updates. With no updates at all that is any page
  // after the first, which would otherwise say the blog is empty while its
  // articles sit on page one.
  const pageOutOfRange = !error && page > totalPages;
  const nothingYet = articles.length === 0 && posts.length === 0;

  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Blog</p>
        <h1 className="mt-3 text-4xl font-bold md:text-5xl">News from the mat</h1>
        <p className="mt-4 text-muted-foreground">
          Articles worth coming back to, and the latest from the club.
        </p>

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
        ) : nothingYet ? (
          <p className="mt-10 text-sm text-muted-foreground">No posts yet. Check back soon.</p>
        ) : (
          <>
            {articles.length > 0 && (
              <section aria-labelledby="blog-articles" className="mt-12">
                <h2 id="blog-articles" className="text-2xl font-bold">
                  Articles
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Longer reads on training and self-defence.
                </p>
                <div className={cn("mt-6 grid gap-6", articles.length > 1 && "md:grid-cols-2")}>
                  {articles.map((article) => (
                    <ArticleCard key={article.id} article={article} />
                  ))}
                </div>
              </section>
            )}

            <section aria-labelledby="blog-updates" className="mt-14">
              <h2 id="blog-updates" className="text-2xl font-bold">
                {page > 1 ? `Club updates, page ${page}` : "Latest club updates"}
              </h2>
              {page > 1 && (result?.articleCount ?? 0) > 0 && (
                <p className="mt-1 text-sm text-muted-foreground">
                  The articles are on the{" "}
                  <Link
                    to="/blog"
                    search={{ page: 1 }}
                    className="text-primary underline underline-offset-2"
                  >
                    first page
                  </Link>
                  .
                </p>
              )}
              {posts.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  No club updates yet. Check back soon.
                </p>
              ) : (
                <div className="mt-2 divide-y border-b">
                  {posts.map((post) => (
                    <UpdateRow key={post.id} post={post} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {!error && !pageOutOfRange && totalPages > 1 && (
          <nav
            aria-label="Club updates pagination"
            className="mt-10 flex items-center justify-between"
          >
            {page > 1 ? (
              <Button asChild variant="outline">
                <Link to="/blog" search={{ page: page - 1 }}>
                  Newer
                </Link>
              </Button>
            ) : (
              <Button variant="outline" disabled aria-disabled="true">
                Newer
              </Button>
            )}
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            {page < totalPages ? (
              <Button asChild variant="outline">
                <Link to="/blog" search={{ page: page + 1 }}>
                  Older
                </Link>
              </Button>
            ) : (
              <Button variant="outline" disabled aria-disabled="true">
                Older
              </Button>
            )}
          </nav>
        )}
      </section>
    </SiteLayout>
  );
}
