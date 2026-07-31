// Styled `react-markdown` element overrides for blog post bodies.
//
// The site has no `@tailwindcss/typography` plugin (confirmed: absent from
// package.json and styles.css), so the `prose` utility classes used
// elsewhere in this codebase (the waiver template preview) are silently
// inert — Tailwind's own preflight then strips paragraph spacing, list
// bullets and link colour entirely. `CodeOfConductDocument.tsx` already
// works around this by hand-styling every element instead of reaching for
// `prose`; this file is the same idea, generalised into a `components` map
// so `ReactMarkdown` can use it directly rather than hand-parsing blocks.
//
// Heading levels are shifted down by one (`# ` renders as an `h3`-sized,
// `<h3>`-tagged element, etc.) so a manager's `#`/`##` inside a post body
// never produces a second `<h1>`/duplicate of the page's own title, keeping
// the page's heading outline correct for assistive tech.
import type { Components } from "react-markdown";

export const blogMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h3 className="mb-3 mt-8 text-2xl font-bold tracking-tight text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-3 mt-8 text-2xl font-bold tracking-tight text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-2 mt-6 text-xl font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className="mb-2 mt-5 text-lg font-semibold text-foreground first:mt-0">{children}</h5>
  ),
  h5: ({ children }) => (
    <h6 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="mb-4 leading-relaxed text-foreground">{children}</p>,
  ul: ({ children }) => <ul className="mb-4 ml-6 list-disc space-y-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 ml-6 list-decimal space-y-1.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed text-foreground">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-words text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  ),
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
};
