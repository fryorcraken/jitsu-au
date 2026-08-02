// The knowledge base front page: where to start, and everything there is.
//
// `noindex`, like every page under /kb. Most of what it lists is members-only,
// and the index would otherwise advertise the slug of every managers-only draft
// to a crawler that cannot read any of them. See docs/knowledge-base.md ("SEO")
// for what making one article indexable would take.
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useKbNav } from "@/hooks/useKbNav";
import { flattenKbNav } from "@/lib/kb-nav";

export const Route = createFileRoute("/kb/")({
  head: () => ({
    meta: [{ title: "Knowledge base | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: KnowledgeBaseIndex,
});

function KnowledgeBaseIndex() {
  const { nav, loading } = useKbNav();
  // The first entry in reading order IS "start here": the order a manager set is
  // the onboarding path, so there is nothing else to point a new member at.
  const first = flattenKbNav(nav)[0] ?? null;

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-4xl font-bold">Knowledge base</h1>
      <p className="mt-3 text-muted-foreground">
        How we train, how grading works, and everything else worth knowing about the club. Read it
        in order, or jump to what you need.
      </p>

      {first && (
        <div className="mt-8 rounded-xl border bg-muted/40 p-6">
          <p className="text-sm font-medium text-muted-foreground">New here?</p>
          <p className="mt-1 text-lg font-semibold">Start with {first.title}.</p>
          <Button asChild className="mt-4">
            {first.link_path ? (
              <a href={first.link_path}>
                Start reading
                <ArrowRight className="ml-1 h-4 w-4" />
              </a>
            ) : (
              <Link to="/kb/$slug" params={{ slug: first.slug }}>
                Start reading
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            )}
          </Button>
        </div>
      )}

      {loading && <p className="mt-10 text-sm text-muted-foreground">Loading...</p>}

      {!loading && !nav.length && (
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
                const label = (
                  <>
                    <span className="font-medium">{entry.title}</span>
                    {entry.link_path ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        On the main site
                        <ExternalLink className="h-3 w-3" />
                      </span>
                    ) : (
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </>
                );
                return (
                  <li key={entry.slug}>
                    {entry.link_path ? (
                      <a href={entry.link_path} className={className}>
                        {label}
                      </a>
                    ) : (
                      <Link to="/kb/$slug" params={{ slug: entry.slug }} className={className}>
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
