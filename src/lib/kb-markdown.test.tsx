import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";

// Article bodies link to other articles constantly, and those links go through
// the ROUTER now rather than the browser. Stood in for here, marked so a test
// can tell a router link from a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    hash,
    children,
    ...props
  }: {
    to: string;
    hash?: string;
    children: React.ReactNode;
  }) => (
    <a href={hash ? `${to}#${hash}` : to} data-router-link="" {...props}>
      {children}
    </a>
  ),
}));

import {
  internalLinkTarget,
  kbMarkdownComponents,
  kbRemarkPlugins,
  staysInThisTab,
} from "./kb-markdown";

function renderMarkdown(markdown: string) {
  return render(<ReactMarkdown components={kbMarkdownComponents}>{markdown}</ReactMarkdown>);
}

describe("kbMarkdownComponents", () => {
  // The reader used to carry `prose` classes, which do nothing without the
  // Tailwind typography plugin this repo does not have, so article bodies
  // rendered as an undifferentiated wall of text.
  it("styles paragraphs, lists and links rather than leaving them bare", () => {
    renderMarkdown("Turn up early.\n\n- Bring water\n- [Read the FAQ](/faq)");
    expect(screen.getByText("Turn up early.").className).toContain("leading-relaxed");
    expect(screen.getByRole("list").className).toContain("list-disc");
    expect(screen.getByRole("link", { name: "Read the FAQ" }).className).toContain("text-primary");
  });

  // A body `#` must not compete with the page's own `<h1>`.
  it("shifts heading levels down so the article title stays the only h1", () => {
    renderMarkdown("# Belts\n\n## Grading");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Belts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Grading" })).toBeInTheDocument();
  });

  it("keeps a same-site link in the tab and sends an external one to a new one", () => {
    renderMarkdown("[Belt system](/kb/belt-system) and [Activate](https://example.com)");
    expect(screen.getByRole("link", { name: "Belt system" })).not.toHaveAttribute("target");
    expect(screen.getByRole("link", { name: "Activate" })).toHaveAttribute("target", "_blank");
  });

  // The bug this fixes: every cross-reference between two articles was a full
  // page load. The reader lost their place, the bundle and the sidebar were
  // fetched again, and moving one page cost what opening the site costs.
  it("follows a link to another article through the router, not the browser", () => {
    renderMarkdown("See the [belt system](/kb/belt-system#grading).");
    const link = screen.getByRole("link", { name: "belt system" });
    expect(link).toHaveAttribute("data-router-link");
    expect(link).toHaveAttribute("href", "/kb/belt-system#grading");
  });

  // A fragment names a heading in the article already on screen. The reader
  // page listens for `hashchange` to jump to it, so it stays a plain anchor.
  it("leaves a fragment as a plain anchor", () => {
    renderMarkdown("Jump to [fees](#fees).");
    const link = screen.getByRole("link", { name: "fees" });
    expect(link).not.toHaveAttribute("data-router-link");
    expect(link).not.toHaveAttribute("target");
  });

  // `//host` is a protocol-relative URL to somebody else's site. The old test
  // for "internal" was `/^[/#]/`, which read it as a path and rendered it
  // same-tab with no `rel="noopener"` on it.
  it("treats a protocol-relative URL as leaving the site", () => {
    renderMarkdown("[Not us](//example.com/phish)");
    const link = screen.getByRole("link", { name: "Not us" });
    expect(link).not.toHaveAttribute("data-router-link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  // `/\host` is the same off-site URL wearing a different hat, because a browser
  // normalises the backslash to a slash before resolving it. It cannot arrive
  // that way through an article: react-markdown percent-encodes the backslash
  // first, and `%5C` is an ordinary path character no browser re-reads as an
  // authority. Pinned because that is the only thing standing between the two,
  // and `internalLinkTarget` refuses the raw form regardless.
  it("cannot be handed a backslash-authority URL by markdown at all", () => {
    renderMarkdown("[Also not us](/\\example.com/phish)");
    expect(screen.getByRole("link", { name: "Also not us" })).toHaveAttribute(
      "href",
      "/%5Cexample.com/phish",
    );
  });

  // The router will not take a query string as a bare `to`, but this is still
  // a page on this site: opening it in a new tab would be wrong.
  it("keeps a same-site path with a query string in the tab", () => {
    renderMarkdown("[Tuesday](/classes?day=tue)");
    const link = screen.getByRole("link", { name: "Tuesday" });
    expect(link).not.toHaveAttribute("data-router-link");
    expect(link).not.toHaveAttribute("target");
  });
});

describe("internalLinkTarget", () => {
  it("splits a path from its fragment", () => {
    expect(internalLinkTarget("/kb/belts")).toEqual({ to: "/kb/belts" });
    expect(internalLinkTarget("/kb/belts#grading")).toEqual({ to: "/kb/belts", hash: "grading" });
    expect(internalLinkTarget("/")).toEqual({ to: "/" });
  });

  it("refuses anything that is not a plain same-site path", () => {
    expect(internalLinkTarget("//example.com")).toBeNull();
    expect(internalLinkTarget("/\\example.com")).toBeNull();
    expect(internalLinkTarget("https://example.com")).toBeNull();
    expect(internalLinkTarget("mailto:hello@example.com")).toBeNull();
    expect(internalLinkTarget("#fees")).toBeNull();
    // A typed `search` object is what the router wants for a query string, and
    // no article has ever needed one.
    expect(internalLinkTarget("/classes?day=tue")).toBeNull();
    expect(internalLinkTarget(undefined)).toBeNull();
  });
});

describe("staysInThisTab", () => {
  it("is true for this site, whether or not the router can take it", () => {
    expect(staysInThisTab("/kb/belts")).toBe(true);
    expect(staysInThisTab("/classes?day=tue")).toBe(true);
    expect(staysInThisTab("#fees")).toBe(true);
  });

  it("is false for a destination that is not this site", () => {
    expect(staysInThisTab("https://example.com")).toBe(false);
    expect(staysInThisTab("//example.com")).toBe(false);
    expect(staysInThisTab("/\\example.com")).toBe(false);
    expect(staysInThisTab("mailto:hello@example.com")).toBe(false);
    expect(staysInThisTab(undefined)).toBe(false);
  });

  // The table styling in this map is only reachable through `kbRemarkPlugins`,
  // since CommonMark has no tables: rendered without them, a grading table is
  // still a paragraph of pipes. `remark-kb-tables.test.tsx` covers the wired-up
  // path; this pins the pairing so a caller that drops the plugins is a visible
  // failure rather than a page that quietly loses its tables.
  it("leaves a table unrendered when the plugins are not passed", () => {
    renderMarkdown("| Belt | Time |\n| --- | --- |\n| White | 0 |");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("styles a table when the knowledge base plugins are used", () => {
    render(
      <ReactMarkdown components={kbMarkdownComponents} remarkPlugins={kbRemarkPlugins}>
        {"| Belt | Time |\n| --- | --- |\n| White | 0 |"}
      </ReactMarkdown>,
    );
    expect(screen.getByRole("table").className).toContain("border-collapse");
    // The wrapper is what stops a wide syllabus table scrolling the whole page
    // sideways on a phone.
    expect(screen.getByRole("table").parentElement?.className).toContain("overflow-x-auto");
  });
});
