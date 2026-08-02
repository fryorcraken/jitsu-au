import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { kbMarkdownComponents } from "./kb-markdown";

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

  // > [!IMPORTANT]
  // > This test pins a LIMITATION, not a feature. `react-markdown` is
  // > CommonMark-only without `remark-gfm`, which this repo does not depend on,
  // > so the `table`/`th`/`td` overrides in the components map are inert and a
  // > manager who writes a grading table gets a paragraph of pipes with no
  // > warning. When `remark-gfm` is added, this test should FAIL — invert it
  // > then, and drop the warning from docs/knowledge-base.md.
  it("does not render a markdown table yet, because remark-gfm is not installed", () => {
    renderMarkdown("| Belt | Time |\n| --- | --- |\n| White | 0 |");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/\| Belt \| Time \|/)).toBeInTheDocument();
  });
});
