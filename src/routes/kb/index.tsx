// The knowledge base front page: where to start, and everything there is.
//
// `noindex`, like every page under /kb. Most of what it lists is members-only,
// and the index would otherwise advertise the slug of every managers-only draft
// to a crawler that cannot read any of them. See docs/knowledge-base.md ("SEO")
// for what making one article indexable would take.
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Check, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { StaleNotice } from "@/components/site/StaleNotice";
import { Loading } from "@/components/site/Loading";
import { useKbNav } from "@/hooks/useKbNav";
import { useKbArticlePrefetch } from "@/hooks/useKbArticle";
import { flattenKbNav, kbProgress, readState } from "@/lib/kb-nav";

export const Route = createFileRoute("/kb/")({
  head: () => ({
    meta: [{ title: "Knowledge base | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: KnowledgeBaseIndex,
});

function KnowledgeBaseIndex() {
  const { nav, loading, error, restoredAt, refetch } = useKbNav();
  // Every article here is one click away, so the fetch starts on the hover, the
  // keyboard focus or the touch that precedes the click.
  const prefetchArticle = useKbArticlePrefetch();
  const progress = kbProgress(nav);
  const started = progress.read > 0 || progress.updated > 0;
  // Where to send them: the next thing they have not read, or the very first
  // entry for somebody who has not started. The order a manager set IS the
  // onboarding path, so there is nothing else to point a new member at.
  const target = progress.next ?? flattenKbNav(nav)[0] ?? null;
  const finished = started && !progress.next;

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-4xl font-bold">Knowledge base</h1>
      <p className="mt-3 text-muted-foreground">
        How we train, how grading works, and everything else worth knowing about the club. Read it
        in order, or jump to what you need.
      </p>

      {target && (
        <div className="mt-8 rounded-xl border bg-muted/40 p-6">
          <p className="text-sm font-medium text-muted-foreground">
            {started ? "Carry on where you left off" : "New here?"}
          </p>
          <p className="mt-1 text-lg font-semibold">
            {started ? target.title : `Start with ${target.title}.`}
          </p>
          <Button asChild className="mt-4">
            {target.link_path ? (
              <Link to={target.link_path}>
                {started ? "Keep reading" : "Start reading"}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            ) : (
              <Link
                to="/kb/$slug"
                params={{ slug: target.slug }}
                onMouseEnter={() => prefetchArticle(target.slug)}
                onFocus={() => prefetchArticle(target.slug)}
                onTouchStart={() => prefetchArticle(target.slug)}
              >
                {started ? "Keep reading" : "Start reading"}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            )}
          </Button>
        </div>
      )}

      {/* Everything read, and nothing rewritten since. Worth saying out loud:
          the panel above disappears at exactly this point, and a member who has
          just finished should be told they have rather than find the thing that
          was guiding them has quietly gone. */}
      {finished && (
        <div className="mt-8 flex items-center gap-2 rounded-xl border bg-muted/40 p-6">
          <Check className="h-5 w-5 shrink-0 text-muted-foreground" />
          <p className="text-sm">
            You have read everything here. We will mark anything that changes, and you will find it
            on this page.
          </p>
        </div>
      )}

      {/* Progress, and only once there is any: "0 of 9 read" is a scoreboard
          shown to somebody who has done nothing wrong. Link entries are not
          counted, because a page on the marketing site cannot report back that
          it was read, and a tick nobody can earn would leave the total
          permanently out of reach. */}
      {progress.total > 0 && started && (
        <div className="mt-6">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {progress.read} of {progress.total} read
              {progress.updated > 0
                ? ` · ${progress.updated} updated since you read ${progress.updated === 1 ? "it" : "them"}`
                : ""}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.read}
            aria-label="How much of the knowledge base you have read"
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.round((progress.read / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {loading && <Loading className="mt-10" />}

      {/* Before the empty state, and instead of it. "There is nothing here for
          you to read yet" is a claim about the club, and a member who is told
          it because a fetch failed has no reason to ever come back. */}
      {/* `error` is only set when there is NO list to show: with the contents
          kept on the device, a failed background refresh still has a perfectly
          good one, and that is the notice below rather than this panel. */}
      {!loading && error && (
        <LoadFailure
          className="mt-10"
          what="The knowledge base"
          message={error}
          hint="It is still there. This is a problem reaching it, not an empty knowledge base."
          onRetry={refetch}
        />
      )}

      {!loading && restoredAt ? (
        <StaleNotice className="mt-10" what="contents" savedAt={restoredAt} onRetry={refetch} />
      ) : null}

      {!loading && !error && !nav.length && (
        <p className="mt-10 text-sm text-muted-foreground">
          There is nothing here for you to read yet. If you think there should be, tell a coach.
        </p>
      )}

      <div className="mt-10 space-y-8">
        {nav.map((section) => (
          <div key={section.slug ?? "unsectioned"}>
            <h2 className="text-xl font-semibold">{section.title}</h2>
            <ul className="mt-3 divide-y rounded-lg border">
              {section.entries.map((entry) => {
                const className =
                  "flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/60";
                const state = readState(entry);
                const label = (
                  <>
                    <span className="font-medium">
                      {entry.title}
                      {entry.visibility === "managers" && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          Draft
                        </span>
                      )}
                    </span>
                    {entry.link_path ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        On the main site
                        <ExternalLink className="h-3 w-3" />
                      </span>
                    ) : state === "read" ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />
                        Read
                      </span>
                    ) : state === "updated" ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <RefreshCw className="h-3 w-3" />
                        Updated
                      </span>
                    ) : (
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </>
                );
                return (
                  <li key={entry.slug}>
                    {entry.link_path ? (
                      // Site-relative by validation, so the router takes it and
                      // the browser never reloads the application to follow it.
                      <Link to={entry.link_path} className={className}>
                        {label}
                      </Link>
                    ) : (
                      <Link
                        to="/kb/$slug"
                        params={{ slug: entry.slug }}
                        className={className}
                        onMouseEnter={() => prefetchArticle(entry.slug)}
                        onFocus={() => prefetchArticle(entry.slug)}
                        onTouchStart={() => prefetchArticle(entry.slug)}
                      >
                        {label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
