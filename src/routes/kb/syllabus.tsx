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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/site/Loading";
import { LoadFailure } from "@/components/site/LoadFailure";
import { StaleNotice } from "@/components/site/StaleNotice";
import { useSyllabus } from "@/hooks/useSyllabus";
import { kbMarkdownComponents, kbRemarkPlugins } from "@/lib/kb-markdown";
import { beltPageTitle, syllabusView, type ViewBeltEntry, type ViewTopic } from "@/lib/syllabus";
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
      <h1 className="text-2xl font-bold sm:text-3xl md:text-4xl">Syllabus by topic</h1>
      <p className="mt-1 text-sm text-muted-foreground sm:mt-2 sm:text-base">
        Everything up to the belt you pick, one topic at a time.
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
    <section className="mx-auto max-w-3xl space-y-4">
      {header}

      {restoredAt && <StaleNotice what="syllabus" savedAt={restoredAt} onRetry={refetch} />}

      {/* Both pickers on one row even on a phone: they are the page's only
          controls, and stacked they pushed the syllabus itself below the fold. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="syllabus-up-to" className="text-xs text-muted-foreground">
            Up to
          </Label>
          <select
            id="syllabus-up-to"
            value={view.upTo.slug}
            onChange={(e) => choose({ up_to: e.target.value })}
            className="h-11 w-full rounded-md border bg-background px-2 text-base"
          >
            {view.choices.map((belt) => (
              <option key={belt.slug} value={belt.slug}>
                {belt.name}
                {belt.visibility === "managers" ? " (draft)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="syllabus-topic" className="text-xs text-muted-foreground">
            Topic
          </Label>
          <select
            id="syllabus-topic"
            value={view.topic?.slug ?? ""}
            onChange={(e) => choose({ topic: e.target.value || undefined })}
            className="h-11 w-full rounded-md border bg-background px-2 text-base"
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
      </div>

      <KeepScreenOn />

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

      {showingAll && view.sections.length > 1 && <TopicBar sections={view.sections} />}

      {view.sections.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          {view.topic
            ? `Nothing on ${view.topic.title} up to ${beltPageTitle(view.upTo)} yet.`
            : `Nothing has been written up to ${beltPageTitle(view.upTo)} yet.`}
        </p>
      ) : (
        <div className="space-y-8 pt-2">
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
            <TopicSection key={section.slug} section={section} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The topics, as a row that stays under the top bar while the page scrolls,
 * and marks the topic being read.
 *
 * It replaced a "Jump to" card at the top and a "Back to the topics" link after
 * every topic. On a phone that card was the third box before any syllabus,
 * and once scrolled past it there was no telling which topic you were in, which
 * is exactly the moment an instructor reading down the page while testing
 * somebody needs it. The row scrolls sideways when the topics do not fit, and
 * keeps the current one in view.
 */
function TopicBar({ sections }: { sections: ViewTopic[] }) {
  const { active, choose } = useActiveTopic(sections.map((s) => s.slug));
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    const chip = active ? list?.querySelector<HTMLElement>(`[data-topic="${active}"]`) : null;
    if (!list || !chip) return;
    // Scroll the ROW, never the page: `scrollIntoView` would also move the
    // page vertically, fighting the reader's own scroll. `scrollLeft` rather
    // than `scrollTo`, which older phones lack; the row's `scroll-smooth`
    // animates it where the browser can.
    list.scrollLeft = chip.offsetLeft - list.clientWidth / 2 + chip.offsetWidth / 2;
  }, [active]);

  return (
    <nav
      aria-label="Topics"
      className="sticky top-16 z-30 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur lg:mx-0 lg:px-0"
    >
      <ul
        ref={listRef}
        className="flex gap-2 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sections.map((section) => {
          const current = section.slug === active;
          return (
            <li key={section.slug} className="shrink-0">
              <a
                href={`#${topicAnchor(section.slug)}`}
                data-topic={section.slug}
                aria-current={current ? "true" : undefined}
                onClick={() => choose(section.slug)}
                className={cn(
                  "inline-flex min-h-10 items-center whitespace-nowrap rounded-full border px-3.5 text-sm transition-colors",
                  current ? "border-foreground bg-foreground text-background" : "hover:bg-muted",
                )}
              >
                {section.title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** How far down the screen a heading counts as reached: the top bar (4rem) and the topic row. */
const READ_LINE = 140;

/**
 * The topic being read: the one whose heading was last scrolled past the top
 * bar and the topic row, or the first before any has been. Measured on scroll,
 * throttled to a frame; there are only a handful of headings.
 *
 * Two cases where "last heading past the line" is wrong, both near the end of
 * the page, where the last topics are too short for their headings ever to be
 * scrolled up that far:
 *
 * - A topic TAPPED in the row stays marked while the page settles on it, until
 *   the reader scrolls for themselves. Otherwise tapping "Scenarios" at the
 *   bottom would mark "Uke", the last heading that did reach the line.
 * - Scrolled to the very bottom by hand, the first heading still below the
 *   line is the one being read, not the one above it.
 */
function useActiveTopic(slugs: string[]): {
  active: string | null;
  choose: (slug: string) => void;
} {
  const [active, setActive] = useState<string | null>(slugs[0] ?? null);
  const chosen = useRef<string | null>(null);
  const key = slugs.join(" ");

  useEffect(() => {
    let frame = 0;
    const top = (slug: string) =>
      document.getElementById(topicAnchor(slug))?.getBoundingClientRect().top ?? Infinity;
    const measure = () => {
      frame = 0;
      const pick = chosen.current;
      if (pick && top(pick) >= 0 && top(pick) < window.innerHeight) {
        setActive(pick);
        return;
      }
      let current = slugs[0] ?? null;
      for (const slug of slugs) if (top(slug) <= READ_LINE) current = slug;
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        const below = slugs.find((slug) => top(slug) > READ_LINE && top(slug) < window.innerHeight);
        if (below) current = below;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // The reader taking over: from here on, where the page is decides.
    const release = () => {
      chosen.current = null;
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    window.addEventListener("keydown", release);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      window.removeEventListener("keydown", release);
      if (frame) cancelAnimationFrame(frame);
    };
    // `key` stands for `slugs`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const choose = useCallback((slug: string) => {
    chosen.current = slug;
    setActive(slug);
  }, []);

  return { active, choose };
}

/** One topic: its belts in order, then its sub-topics. */
function TopicSection({ section }: { section: ViewTopic }) {
  const Heading = section.depth === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={topicAnchor(section.slug)} className="space-y-3">
      <Heading
        id={topicAnchor(section.slug)}
        // Clears the top bar and the sticky topic row when jumped to.
        className={cn(
          "scroll-mt-32 font-bold tracking-tight",
          section.depth === 2 ? "border-b pb-1.5 text-xl sm:text-2xl" : "pt-1 text-lg",
        )}
      >
        {section.title}
      </Heading>
      {section.entries.map((entry) => (
        <BeltBlock key={entry.belt.slug} entry={entry} topic={section.slug} />
      ))}
      {section.children.map((child) => (
        <TopicSection key={child.slug} section={child} />
      ))}
    </section>
  );
}

/**
 * One belt's text under one topic: a strip in the belt's colour down the left,
 * its name, and the text. A strip rather than a boxed card, because on a phone
 * a card per belt per topic was mostly border and padding around a two-line
 * list. The colour is decoration only; the name is always there.
 */
function BeltBlock({ entry, topic }: { entry: ViewBeltEntry; topic: string }) {
  const { belt } = entry;
  const components = useMemo(() => beltComponents(belt.page_slug), [belt.page_slug]);
  return (
    <article
      className="border-l-4 pl-3"
      style={{ borderLeftColor: belt.colour }}
      aria-label={beltPageTitle(belt)}
    >
      <div className="flex items-baseline gap-2">
        <h4 className="font-semibold">
          {belt.name}
          {belt.grade && (
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">{belt.grade}</span>
          )}
        </h4>
        {belt.visibility === "managers" && <Badge variant="secondary">Draft</Badge>}
        {belt.page_slug && (
          <Link
            to="/kb/$slug"
            params={{ slug: belt.page_slug }}
            hash={topic}
            className="ml-auto inline-flex min-h-8 items-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Belt page
          </Link>
        )}
      </div>
      {/* The knowledge base's own markdown, at reading size, with the space
          after the last list or paragraph taken off so belts sit close. */}
      <div className="mt-1 text-base [&>*:last-child]:mb-0 [&_ul]:mb-2 [&_ul]:ml-5 [&_ul]:space-y-1">
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
    <div className="-mt-1 flex items-center justify-end gap-2">
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
