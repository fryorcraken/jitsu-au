// Read one knowledge base article and annotate it.
//
// `robots: noindex` on purpose. These are the club's own pages (handbooks,
// policies, the syllabus) and most are members-only, so they are not marketing
// pages competing for search traffic — and a crawler that indexed one would list
// a URL whose content it is not allowed to fetch. Making a genuinely public,
// indexable article later is a deliberate change: drop the noindex, give the
// page a real canonical, and add it to `PUBLIC_PAGES` in `src/lib/seo.ts`
// (`seo.test.ts` enforces that pairing).
//
// Rendered client-side rather than in the loader: the annotation layer needs to
// know who is reading, and the reader's bearer token reaches a server function
// through `attachSupabaseAuth` on an RPC from the browser, not during SSR.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ChevronRight, ExternalLink, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { KbArticleReader } from "@/components/site/KbArticleReader";
import type { NewAnnotation } from "@/components/site/KbArticleReader";
import { useKbNav } from "@/hooks/useKbNav";
import {
  createAnnotation,
  deleteAnnotation,
  getKbArticle,
  listAnnotations,
  resolveAnnotation,
  updateAnnotation,
} from "@/lib/kb.functions";
import { adjacentEntries, entryBreadcrumbs, extractHeadings, type KbNavEntry } from "@/lib/kb-nav";
import { formatDate } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";

/** Show an "On this page" list only once an article is long enough to need one. */
const MIN_HEADINGS_FOR_CONTENTS = 3;

export const Route = createFileRoute("/kb/$slug")({
  head: () => ({
    meta: [{ title: "Knowledge base | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ArticlePage,
});

function ArticlePage() {
  const { slug } = Route.useParams();
  const { loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const { nav } = useKbNav();

  const fetchArticle = useServerFn(getKbArticle);
  const fetchAnnotations = useServerFn(listAnnotations);
  const create = useServerFn(createAnnotation);
  const update = useServerFn(updateAnnotation);
  const remove = useServerFn(deleteAnnotation);
  const resolve = useServerFn(resolveAnnotation);

  const [busy, setBusy] = useState(false);

  // Wait for auth to settle before asking. The server resolves the reader from
  // the request's bearer token, so asking too early reads a members-only article
  // as a signed-out visitor and renders "not available to you" at somebody who
  // is, in fact, signed in.
  const articleQ = useQuery({
    queryKey: ["kb-article", slug],
    queryFn: () => fetchArticle({ data: { slug } }),
    enabled: !authLoading,
    retry: false,
  });

  const article = articleQ.data?.article ?? null;
  const viewer = articleQ.data?.viewer ?? null;
  const redirectTo = articleQ.data?.redirect_to ?? null;

  const annotationsQ = useQuery({
    queryKey: ["kb-annotations", slug],
    queryFn: () => fetchAnnotations({ data: { slug } }),
    enabled: !authLoading && Boolean(article),
  });

  // A link entry has no page of its own. The sidebar sends readers straight to
  // the destination, so this only fires for a URL somebody saved or shared
  // before the entry became a link. A full navigation rather than a router push:
  // the destination lives outside this shell, under the marketing chrome.
  useEffect(() => {
    if (redirectTo) window.location.replace(redirectTo);
  }, [redirectTo]);

  const headings = useMemo(() => (article ? extractHeadings(article.body_md) : []), [article]);
  const crumbs = entryBreadcrumbs(nav, slug);
  const { previous, next } = adjacentEntries(nav, slug);

  const refreshAnnotations = () =>
    queryClient.invalidateQueries({ queryKey: ["kb-annotations", slug] });

  /**
   * Run a write, refresh the thread list, and report failures in words.
   *
   * Returns whether it worked, and the caller uses that to decide whether to
   * clear what the reader typed. Swallowing the error and resolving anyway meant
   * the composer emptied itself on every failure — an expired session, a dropped
   * connection, a rejected comment — and the reader lost what they had written
   * along with any chance of retrying it. This repo already has
   * `use-resilient-submit` and `waiver-draft` for exactly that reason.
   */
  async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      await refreshAnnotations();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || articleQ.isPending || redirectTo) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (articleQ.isError || !article || !viewer) {
    return (
      <section className="max-w-3xl">
        <h1 className="text-3xl font-bold">Not available</h1>
        <p className="mt-3 text-muted-foreground">
          {articleQ.error instanceof Error
            ? articleQ.error.message
            : "That article does not exist, or is not available to you."}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <Link to="/kb">Back to the knowledge base</Link>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <article>
      <nav aria-label="Breadcrumb" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
        <Link to="/kb" className="text-muted-foreground hover:text-foreground">
          Knowledge base
        </Link>
        {crumbs?.section?.slug && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{crumbs.section.title}</span>
          </>
        )}
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{article.title}</span>
      </nav>

      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold md:text-4xl">{article.title}</h1>
          <Badge variant="outline">Version {article.version}</Badge>
          {article.visibility !== "public" && (
            <Badge variant="secondary">
              {article.visibility === "managers" ? "Managers only" : "Members"}
            </Badge>
          )}
        </div>
        {/* No em dash: AGENTS.md bans them in user-facing copy, and this is copy
            on the page. `·` is the separator the index page already uses. */}
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated {formatDate(article.updated_at)}
          {article.change_note ? ` · ${article.change_note}` : ""}
        </p>
        {!viewer.signed_in && (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            <Link to="/auth" search={{ redirect: `/kb/${slug}` }} className="underline">
              Sign in
            </Link>{" "}
            to leave a comment or keep private notes on this page.
          </p>
        )}
      </header>

      {headings.length >= MIN_HEADINGS_FOR_CONTENTS && (
        <Collapsible defaultOpen className="mb-8 rounded-lg border">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium">
            <List className="h-4 w-4 text-muted-foreground" />
            On this page
          </CollapsibleTrigger>
          <CollapsibleContent className="px-4 pb-3">
            <ul className="space-y-1 text-sm">
              {headings.map((heading) => (
                <li key={heading.id} style={{ paddingLeft: `${(heading.depth - 1) * 0.75}rem` }}>
                  <a
                    href={`#${heading.id}`}
                    className="text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      <KbArticleReader
        article={article}
        annotations={annotationsQ.data ?? []}
        viewer={viewer}
        busy={busy || annotationsQ.isFetching}
        onCreate={(input: NewAnnotation) =>
          run(
            () =>
              create({
                data: {
                  slug,
                  article_version: article.version,
                  block_id: input.block_id ?? undefined,
                  quote: input.quote ?? undefined,
                  visibility: input.visibility,
                  parent_id: input.parent_id,
                  body: input.body,
                  hp: "",
                },
              }),
            "Could not save your comment",
          )
        }
        onUpdate={(id, body) =>
          run(() => update({ data: { id, body } }), "Could not save your edit")
        }
        onDelete={async (id) => {
          await run(() => remove({ data: { id } }), "Could not delete that");
        }}
        onResolve={async (id, resolved) => {
          await run(() => resolve({ data: { id, resolved } }), "Could not update that thread");
        }}
      />

      {(previous || next) && (
        <nav
          aria-label="More in the knowledge base"
          className="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2"
        >
          <AdjacentLink entry={previous} direction="previous" />
          <AdjacentLink entry={next} direction="next" />
        </nav>
      )}
    </article>
  );
}

/**
 * One end of the reading order.
 *
 * Renders an empty cell rather than nothing when there is no neighbour, so
 * "Next" stays on the right of the row at the start of the knowledge base
 * instead of sliding under the "Previous" column.
 */
function AdjacentLink({
  entry,
  direction,
}: {
  entry: KbNavEntry | null;
  direction: "previous" | "next";
}) {
  const isNext = direction === "next";
  if (!entry) return <div className={isNext ? "sm:col-start-2" : undefined} />;

  const inner = (
    <>
      <span className="text-xs text-muted-foreground">{isNext ? "Next" : "Previous"}</span>
      <span className="flex items-center gap-1.5 font-medium">
        {!isNext && <ArrowLeft className="h-4 w-4 shrink-0" />}
        {entry.title}
        {entry.link_path && <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />}
        {isNext && <ArrowRight className="h-4 w-4 shrink-0" />}
      </span>
    </>
  );

  const className = [
    "flex flex-col gap-1 rounded-lg border p-4 text-sm transition-colors hover:bg-muted/60",
    isNext ? "sm:col-start-2 sm:items-end sm:text-right" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return entry.link_path ? (
    <a href={entry.link_path} className={className}>
      {inner}
    </a>
  ) : (
    <Link to="/kb/$slug" params={{ slug: entry.slug }} className={className}>
      {inner}
    </Link>
  );
}
