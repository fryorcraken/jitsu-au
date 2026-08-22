// Styled `react-markdown` element overrides for knowledge base article bodies.
//
// Same reason `blog-markdown.tsx` exists: the site has no
// `@tailwindcss/typography` plugin, so the `prose` utility classes this reader
// used to carry were silently inert, and Tailwind's preflight then stripped
// paragraph spacing, list bullets and link colour entirely. An onboarding guide
// that renders as an undifferentiated wall of text is one nobody reads.
//
// Kept separate from the blog's map rather than shared, because the two differ
// where it matters: an article is long-form reference read with a table of
// contents beside it, so its headings stay visually distinct at three levels,
// and its links are same-site by default (a syllabus links to the belt system,
// not off to another domain).
//
// Heading levels are shifted down by one — a body `#` renders as an `<h2>` — so
// a manager's markdown never produces a second `<h1>` competing with the page's
// own title, keeping the heading outline correct for assistive tech.
import { Link } from "@tanstack/react-router";
import type { Components } from "react-markdown";
import { remarkKbAnchors } from "@/lib/remark-kb-anchors";
import { remarkKbTables } from "@/lib/remark-kb-tables";

/**
 * Where a link in an article body points, when it points somewhere on this site.
 *
 * Split out and exported because getting it wrong is expensive in both
 * directions. Too narrow and a cross-reference between two articles reloads the
 * whole application to move one page (the sidebar, the shell, the router and
 * every bundle again, on a phone, mid-class) — which is exactly what club
 * articles do most. Too wide and `//evil.example` reads as "a path", which is a
 * protocol-relative URL to another host: the old test for an internal link was
 * `/^[/#]/`, so that one was rendered as a same-tab link with no
 * `rel="noopener"` on it.
 *
 * Returns null for anything that is not a plain same-site path, including a
 * fragment (which belongs to the page already on screen) and a path carrying a
 * query string (a typed `search` object is what the router wants there, and no
 * article has ever needed one).
 */
export function internalLinkTarget(href: string | undefined): { to: string; hash?: string } | null {
  if (typeof href !== "string") return null;
  // One leading slash, and no `?`: `//host` and `/a?b=c` both fall through to
  // the plain-anchor branch below.
  const match = /^\/(?!\/)([^?#]*)(#(.*))?$/.exec(href);
  if (!match) return null;
  const hash = match[3];
  return { to: `/${match[1]}`, ...(hash ? { hash } : {}) };
}

/**
 * The remark plugins every knowledge base rendering surface uses: the reader,
 * one block at a time, and the manager preview, which renders a whole body.
 *
 * Exported as one list rather than wired up separately in each, because a table
 * that renders for a member but not in the preview a manager checked it in is
 * the version of this bug that is hardest to notice.
 */
export const kbRemarkPlugins = [remarkKbTables, remarkKbAnchors];

export const kbMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h2 className="mb-3 mt-10 scroll-mt-24 text-2xl font-bold tracking-tight text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="mb-3 mt-10 scroll-mt-24 text-xl font-bold tracking-tight text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-2 mt-8 scroll-mt-24 text-lg font-semibold text-foreground first:mt-0">
      {children}
    </h4>
  ),
  h4: ({ children }) => (
    <h5 className="mb-2 mt-6 scroll-mt-24 text-base font-semibold text-foreground first:mt-0">
      {children}
    </h5>
  ),
  h5: ({ children }) => (
    <h6 className="mb-2 mt-5 text-base font-semibold text-foreground first:mt-0">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="mb-2 mt-5 text-sm font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="mb-4 leading-relaxed text-foreground">{children}</p>,
  ul: ({ children }) => <ul className="mb-4 ml-6 list-disc space-y-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 ml-6 list-decimal space-y-1.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed text-foreground">{children}</li>,
  a: ({ children, href }) => {
    const className = "break-words text-primary underline underline-offset-2 hover:no-underline";

    // A same-site path goes through the ROUTER, not the browser. A club article
    // links to another club article constantly, and rendering those as bare
    // anchors made every one of them a full page load: blank screen, the whole
    // bundle again, auth resolved again, the sidebar fetched again, and the
    // reader's place in the knowledge base thrown away to move one page.
    const target = internalLinkTarget(href);
    if (target) {
      return (
        <Link {...target} className={className}>
          {children}
        </Link>
      );
    }

    // A fragment stays in the tab and stays a plain anchor: it names a heading
    // in the article already on screen, and the reader page listens for
    // `hashchange` to jump to it. Anything else is leaving the site and gets
    // the new-tab treatment.
    const fragment = typeof href === "string" && href.startsWith("#");
    return (
      <a
        href={href}
        {...(fragment ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        className={className}
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-primary/30 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg bg-muted p-4 text-sm">{children}</pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{children}</code>
  ),
  hr: () => <hr className="my-8 border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      loading="lazy"
      className="my-6 h-auto w-full rounded-xl"
    />
  ),
  // Live via `remarkKbTables`, this repo's own pipe-table plugin, rather than
  // `remark-gfm` — see `src/lib/remark-kb-tables.ts` for why a dependency was
  // the wrong price for the one piece of GFM a syllabus needs.
  //
  // The scroller is the part that matters: a wide grading table must never make
  // the whole page scroll sideways on a phone.
  table: ({ children }) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  // `style` is forwarded, and it is the only reason a column alignment survives:
  // an alignment marker (`| :-: |`) reaches the renderer as an inline
  // `text-align` on the cell, so an override that took only `children` would
  // silently centre nothing. The inline style wins over `text-left` below, which
  // is the default for a cell that named no alignment.
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-border px-3 py-2 text-left font-semibold text-foreground"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-border px-3 py-2 align-top text-foreground">
      {children}
    </td>
  ),
};
