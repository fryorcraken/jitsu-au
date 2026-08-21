import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { kbMarkdownComponents, kbRemarkPlugins } from "./kb-markdown";

function renderMarkdown(markdown: string) {
  return render(
    <ReactMarkdown components={kbMarkdownComponents} remarkPlugins={kbRemarkPlugins}>
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remarkKbAnchors", () => {
  // The anchor is plumbing. A member reading the syllabus must never see it.
  it("takes a pinned anchor off the heading it is shown with", () => {
    renderMarkdown("## How grading works {#grading}");
    expect(screen.getByRole("heading", { name: "How grading works" })).toBeInTheDocument();
    expect(screen.queryByText(/\{#grading\}/)).not.toBeInTheDocument();
  });

  // The anchor lands in a text node of its own when the heading ends in
  // emphasis or a link, which is the case a naive "strip the last text node"
  // gets wrong in the other direction.
  it("strips it from a heading that ends in emphasis", () => {
    renderMarkdown("## The **blue** belt {#blue}");
    const heading = screen.getByRole("heading", { name: "The blue belt" });
    expect(heading.textContent).toBe("The blue belt");
  });

  it("strips it from a heading whose last word is emphasised", () => {
    renderMarkdown("## The blue **belt** {#blue}");
    expect(screen.getByRole("heading", { name: "The blue belt" }).textContent).toBe(
      "The blue belt",
    );
  });

  it("leaves ordinary braces in a heading alone", () => {
    renderMarkdown("## Using {{first_name}} in an email");
    expect(
      screen.getByRole("heading", { name: "Using {{first_name}} in an email" }),
    ).toBeInTheDocument();
  });

  // Stripping this would leave a heading with no words in it, so the braces are
  // the heading's text. `parseHeading` agrees, which is what keeps the contents
  // list and the page showing the same thing.
  it("leaves a heading that is nothing but an anchor alone", () => {
    renderMarkdown("## {#orphan}");
    expect(screen.getByRole("heading", { name: "{#orphan}" })).toBeInTheDocument();
  });

  it("does not touch braces in a paragraph", () => {
    renderMarkdown("Write {#grading} at the end of a heading to pin its link.");
    expect(screen.getByText(/\{#grading\}/)).toBeInTheDocument();
  });
});
