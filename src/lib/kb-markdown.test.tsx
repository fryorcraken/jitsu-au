import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { kbMarkdownComponents, kbRemarkPlugins } from "./kb-markdown";

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
