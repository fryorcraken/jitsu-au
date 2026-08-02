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
import type { Components } from "react-markdown";

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
    // A path or a fragment stays in the tab; anything else is leaving the site
    // and gets the new-tab treatment. Club articles cross-reference each other
    // constantly, and opening a new tab for every one of those is how a reader
    // ends up with fifteen.
    const internal = typeof href === "string" && /^[/#]/.test(href);
    return (
      <a
        href={href}
        {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        className="break-words text-primary underline underline-offset-2 hover:no-underline"
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
  // Tables carry the syllabus. Wrapped in its own scroller so a wide grading
  // table never makes the whole page scroll sideways on a phone.
  table: ({ children }) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border px-3 py-2 align-top text-foreground">{children}</td>
  ),
};
