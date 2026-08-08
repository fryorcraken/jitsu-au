// Styled `react-markdown` element overrides for the club's payment
// instructions: the account name, BSB, PayID or note a manager writes at
// `/manager/settings`.
//
// The site has no `@tailwindcss/typography` plugin, so the `prose` classes used
// elsewhere in this codebase are silently inert and Tailwind's preflight then
// strips list bullets and paragraph spacing entirely — which on this particular
// block would run a set of bank details together into one line for somebody
// trying to copy them into a banking app. `blog-markdown.tsx` solves the same
// problem for post bodies; this map is the compact version, sized to sit inside
// a card rather than to carry an article.
//
// Used by the member's "how to pay" panel AND by the manager's preview of it,
// so a manager editing the instructions is looking at what the member gets.
import type { Components } from "react-markdown";

export const invoiceMarkdownComponents: Components = {
  // Headings shift down to h4/h5: this block sits under the card's own title,
  // so a manager's `#` must not outrank it in the page's heading outline.
  h1: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  h2: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mb-1.5 mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h5 className="mb-1.5 mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h5>
  ),
  h5: ({ children }) => (
    <h6 className="mb-1.5 mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1.5 mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
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
  // Account numbers and BSBs are digit strings people transcribe. Bold and
  // monospace are the two ways a manager can make one stand out, so both have
  // to survive into what the member reads.
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg bg-muted p-3 text-sm last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-primary/30 pl-3 italic last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
};
