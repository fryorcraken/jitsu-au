// The syllabus by topic: everything up to the belt you pick, topic by topic.
//
// The page a member opens before a grading, and the page an instructor reads
// down while testing somebody, so it is built for a phone held in one hand:
// one column, scrolling down, a list of topics at the top to jump with, and a
// way to keep the screen from locking halfway through. The belt and the topic
// live in the address (`?up_to=green&topic=breakfalling`), so the same view
// can be sent to a group chat.
//
// Everything on it comes from `syllabusView`, the same function the agent
// API's `get_syllabus` uses, so the two never disagree about what "up to
// green" contains. See docs/syllabus.md.
//
// `noindex` like every page under /kb, and behind the same sign-in gate.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { ArrowUp, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/site/Loading";
import { LoadFailure } from "@/components/site/LoadFailure";
import { StaleNotice } from "@/components/site/StaleNotice";
import { useSyllabus } from "@/hooks/useSyllabus";
import { kbMarkdownComponents, kbRemarkPlugins } from "@/lib/kb-markdown";
import {
  beltPageTitle,
  syllabusView,
  type SyllabusBelt,
  type ViewBeltEntry,
  type ViewTopic,
} from "@/lib/syllabus";
import { syllabusSearchSchema } from "@/lib/validation";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/kb/syllabus")({
  validateSearch: syllabusSearchSchema,
  head: () => ({
    meta: [{ title: "Syllabus by topic | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SyllabusPage,
});

/** The id a topic's heading gets on this page, for the jump list. */
const topicAnchor = (slug: string) => `topic-${slug}`;
const JUMP_LIST_ID = "syllabus-topics";

function SyllabusPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, loading, error, refetch, restoredAt } = useSyllabus();

  const view = useMemo(
    () => (data ? syllabusView(data, { upTo: search.up_to, topic: search.topic }) : null),
    [data, search.up_to, search.topic],
  );

  // `replace` so picking three belts in a row does not leave three entries in
  // the back button between the reader and the page they came from.
  const choose = (next: { up_to?: string; topic?: string }) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  const header = (
    <header>
      <h1 className="text-3xl font-bold md:text-4xl">Syllabus by topic</h1>
      <p className="mt-2 text-muted-foreground">
        Everything up to the belt you pick, one topic at a time. Each belt&apos;s own page has the
        same text, belt by belt.
      </p>
    </header>
  );

  if (loading && !data) {
    return (
      <section className="mx-auto max-w-3xl space-y-6">
        {header}
        <Loading label="Loading the syllabus" />
      </section>
    );
  }

  if (!view) {
    return (
      <section className="mx-auto max-w-3xl space-y-6">
        {header}
        <LoadFailure
          what="The syllabus"
          message={error ?? undefined}
          hint="The belt pages in the sidebar have the same text."
          onRetry={refetch}
        />
      </section>
    );
  }

  if (!view.upTo) {
    return (
      <section className="mx-auto max-w-3xl space-y-6">
        {header}
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          The syllabus has not been published yet. Ask an instructor what to work on for your next
          grading.
        </p>
      </section>
    );
  }

  const showingAll = !view.topic;

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      {header}

      {restoredAt && <StaleNotice what="syllabus" savedAt={restoredAt} onRetry={refetch} />}

      <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="syllabus-up-to">Up to</Label>
          <select
            id="syllabus-up-to"
            value={view.upTo.slug}
            onChange={(e) => choose({ up_to: e.target.value })}
            className="h-11 w-full rounded-md border bg-background px-3 text-base"
          >
            {view.choices.map((belt) => (
              <option key={belt.slug} value={belt.slug}>
                {beltPageTitle(belt)}
                {belt.visibility === "managers" ? " (draft)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="syllabus-topic">Topic</Label>
          <select
            id="syllabus-topic"
            value={view.topic?.slug ?? ""}
            onChange={(e) => choose({ topic: e.target.value || undefined })}
            className="h-11 w-full rounded-md border bg-background px-3 text-base"
          >
            <option value="">All topics</option>
            {view.allTopics.map((root) =>
              root.children.length ? (
                <optgroup key={root.slug} label={root.title}>
                  <option value={root.slug}>All of {root.title}</option>
                  {root.children.map((child) => (
                    <option key={child.slug} value={child.slug}>
                      {child.title}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={root.slug} value={root.slug}>
                  {root.title}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <BeltStrip belts={view.belts} />
          <KeepScreenOn />
        </div>
      </div>

      {view.unknownUpTo && (
        <p role="status" className="rounded-lg border border-dashed p-3 text-sm">
          This link asked for a belt called &ldquo;{view.unknownUpTo}&rdquo;, which the syllabus
          does not have, so it is showing every belt. Pick one above.
        </p>
      )}
      {view.unknownTopic && (
        <p role="status" className="rounded-lg border border-dashed p-3 text-sm">
          This link asked for a topic called &ldquo;{view.unknownTopic}&rdquo;, which the syllabus
          does not have, so it is showing every topic. Pick one above.
        </p>
      )}

      {showingAll && view.sections.length > 1 && (
        <nav
          id={JUMP_LIST_ID}
          aria-label="Jump to a topic"
          className="scroll-mt-24 rounded-lg border p-4"
        >
          <p className="text-sm font-semibold">Jump to</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {view.sections.map((section) => (
              <li key={section.slug}>
                <a
                  href={`#${topicAnchor(section.slug)}`}
                  className="inline-flex min-h-9 items-center rounded-full border px-3 text-sm hover:bg-muted"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {view.sections.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          {view.topic
            ? `Nothing on ${view.topic.title} up to ${beltPageTitle(view.upTo)} yet.`
            : `Nothing has been written up to ${beltPageTitle(view.upTo)} yet.`}
        </p>
      ) : (
        <div className="space-y-10">
          {view.topicParent && (
            <p className="text-sm text-muted-foreground">
              Part of{" "}
              <Link
                to="/kb/syllabus"
                search={{ up_to: search.up_to, topic: view.topicParent.slug }}
                className="underline underline-offset-4"
              >
                {view.topicParent.title}
              </Link>
            </p>
          )}
          {view.sections.map((section) => (
            <TopicSection key={section.slug} section={section} showBackLink={showingAll} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One topic: its belts in order, then its sub-topics. */
function TopicSection({ section, showBackLink }: { section: ViewTopic; showBackLink: boolean }) {
  const Heading = section.depth === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={topicAnchor(section.slug)} className="space-y-4">
      <Heading
        id={topicAnchor(section.slug)}
        className={cn(
          "scroll-mt-24 font-bold tracking-tight",
          section.depth === 2 ? "border-b pb-2 text-2xl" : "text-xl",
        )}
      >
        {section.title}
      </Heading>
      {section.entries.map((entry) => (
        <BeltBlock key={entry.belt.slug} entry={entry} topic={section.slug} />
      ))}
      {section.children.map((child) => (
        <TopicSection key={child.slug} section={child} showBackLink={false} />
      ))}
      {showBackLink && (
        <a
          href={`#${JUMP_LIST_ID}`}
          className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowUp className="h-4 w-4" aria-hidden="true" />
          Back to the topics
        </a>
      )}
    </section>
  );
}

/** One belt's text under one topic. */
function BeltBlock({ entry, topic }: { entry: ViewBeltEntry; topic: string }) {
  const { belt } = entry;
  const components = useMemo(() => beltComponents(belt.page_slug), [belt.page_slug]);
  return (
    <article className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <BeltSwatch belt={belt} />
        <h4 className="font-semibold">{beltPageTitle(belt)}</h4>
        {belt.visibility === "managers" && <Badge variant="secondary">Draft</Badge>}
        {belt.page_slug && (
          <Link
            to="/kb/$slug"
            params={{ slug: belt.page_slug }}
            hash={topic}
            className="ml-auto text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            On the belt page
          </Link>
        )}
      </div>
      <div className="text-sm">
        <ReactMarkdown components={components} remarkPlugins={kbRemarkPlugins}>
          {entry.body_md}
        </ReactMarkdown>
      </div>
    </article>
  );
}

/**
 * The knowledge base's own markdown, with one change: a bare `#anchor` in a
 * block was written for the BELT PAGE, where it names a heading. Here it would
 * name nothing, so it is pointed at that belt's page instead.
 */
function beltComponents(pageSlug: string | null): Components {
  // The knowledge base's link is a component of its own (it renders the
  // preview card), so it is rendered as one, with only the href changed.
  const Anchor = kbMarkdownComponents.a as (props: {
    href?: string;
    children?: ReactNode;
  }) => ReactNode;
  return {
    ...kbMarkdownComponents,
    a: ({ href, children }) => (
      <Anchor href={pageSlug && href?.startsWith("#") ? `/kb/${pageSlug}${href}` : href}>
        {children}
      </Anchor>
    ),
  };
}

/**
 * The belt's colour, as a swatch. Decoration only: the name always sits beside
 * it, so nothing depends on telling two colours apart.
 */
function BeltSwatch({ belt }: { belt: Pick<SyllabusBelt, "colour"> }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-6 shrink-0 rounded-sm border border-foreground/30"
      style={{ backgroundColor: belt.colour }}
    />
  );
}

/** The belts the page covers, as a row of swatches, so the range reads at a glance. */
function BeltStrip({ belts }: { belts: SyllabusBelt[] }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      <span className="sr-only">Showing </span>
      {belts.map((belt) => (
        <span key={belt.slug} className="inline-flex items-center gap-1">
          <BeltSwatch belt={belt} />
          <span>{belt.name}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * Keep the screen on while this page is open: for an instructor reading down
 * the syllabus while testing somebody, whose phone would otherwise lock mid
 * grading. Off until asked for, because it costs battery and a member just
 * looking something up does not want it. Only shown where the browser can do
 * it, and the lock the browser drops when the tab is hidden is taken again when
 * it comes back.
 */
function KeepScreenOn() {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => setSupported("wakeLock" in navigator), []);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release();
        else sentinel.current = lock;
      } catch {
        if (!cancelled) {
          setFailed(true);
          setOn(false);
        }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel.current?.release();
      sentinel.current = null;
    };
  }, [on]);

  if (!supported) return null;
  return (
    <div className="ml-auto flex items-center gap-2">
      {failed && !on && (
        <span role="status" className="text-xs text-muted-foreground">
          This phone would not keep the screen on.
        </span>
      )}
      <Button
        type="button"
        variant={on ? "default" : "outline"}
        size="sm"
        aria-pressed={on}
        onClick={() => {
          setFailed(false);
          setOn((value) => !value);
        }}
      >
        <Sun className="mr-1 h-4 w-4" aria-hidden="true" />
        {on ? "Screen stays on" : "Keep screen on"}
      </Button>
    </div>
  );
}
