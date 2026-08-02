import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { kbMarkdownComponents } from "./kb-markdown";
import { remarkKbTables } from "./remark-kb-tables";

/** Rendered exactly the way the reader renders an article block. */
function renderMarkdown(markdown: string) {
  return render(
    <ReactMarkdown components={kbMarkdownComponents} remarkPlugins={[remarkKbTables]}>
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remarkKbTables", () => {
  // The whole point of the plugin: this exact markdown used to reach a member
  // as a paragraph of pipe characters.
  it("renders a pipe table as a real table", () => {
    renderMarkdown("| Belt | Time |\n| --- | --- |\n| White | 0 |\n| Yellow | 6 months |");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Belt", "Time"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("cell", { name: "6 months" })).toBeInTheDocument();
    // The header cells go through the `th` override, not a bare element.
    expect(screen.getAllByRole("columnheader")[0].className).toContain("font-semibold");
  });

  it("accepts a table written without the outer pipes", () => {
    renderMarkdown("Belt | Time\n--- | ---\nWhite | 0");
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Belt", "Time"]);
    expect(screen.getByRole("cell", { name: "White" })).toBeInTheDocument();
  });

  // Cells keep their inline markdown because the nodes are moved into the cell
  // already parsed, rather than the cell text being re-read as plain text.
  it("keeps links, emphasis and code working inside a cell", () => {
    renderMarkdown("| What | Where |\n| --- | --- |\n| **Gi** | [the FAQ](/faq) and `mats` |");
    expect(screen.getByRole("link", { name: "the FAQ" })).toHaveAttribute("href", "/faq");
    expect(screen.getByText("Gi").tagName).toBe("STRONG");
    expect(screen.getByText("mats").tagName).toBe("CODE");
  });

  it("reads the alignment markers", () => {
    renderMarkdown("| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |");
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]).not.toHaveStyle({ textAlign: "center" });
    expect(headers[1]).toHaveStyle({ textAlign: "center" });
    expect(headers[2]).toHaveStyle({ textAlign: "right" });
  });

  // A short row is padded rather than throwing the whole table away: a manager
  // who forgot a pipe on row nine should get nine rows and one gap.
  it("pads a short row and drops the excess from a long one", () => {
    renderMarkdown("| A | B |\n| --- | --- |\n| 1 |\n| 2 | 3 | 4 |");
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1].querySelectorAll("td")).toHaveLength(2);
    expect(rows[2].querySelectorAll("td")).toHaveLength(2);
    expect(screen.queryByRole("cell", { name: "4" })).not.toBeInTheDocument();
  });

  // A pipe a manager escaped is text in a cell, not a column break. Without
  // this the row below would silently gain a third column and shed a word.
  it("treats an escaped pipe as text rather than a cell break", () => {
    renderMarkdown("| Move | Notes |\n| --- | --- |\n| Sweep | left \\| right |");
    expect(screen.getAllByRole("cell")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "left | right" })).toBeInTheDocument();
  });

  it("leaves ordinary prose that happens to contain a pipe alone", () => {
    renderMarkdown("Press ctrl | to continue.\n\nAnd then stop.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/Press ctrl \| to continue\./)).toBeInTheDocument();
  });

  // The delimiter row is what makes it a table. Two lines of pipes with no
  // dashes between them are a sentence somebody wrapped.
  it("needs a delimiter row", () => {
    renderMarkdown("| Belt | Time |\n| White | 0 |");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("refuses a delimiter row with the wrong number of columns", () => {
    renderMarkdown("| Belt | Time |\n| --- |\n| White | 0 |");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a single-column table written with edge pipes", () => {
    renderMarkdown("| Belt |\n| --- |\n| White |");
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Belt"]);
  });

  it("finds a table inside a block quote", () => {
    renderMarkdown("> | A | B |\n> | --- | --- |\n> | 1 | 2 |");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
  });

  // A fenced code sample that contains a table is code. Splitting it would both
  // mangle the sample and invent a table nobody wrote.
  it("leaves a table inside a code fence as code", () => {
    renderMarkdown("```\n| A | B |\n| --- | --- |\n```");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
