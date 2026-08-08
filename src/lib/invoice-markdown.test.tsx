import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { invoiceMarkdownComponents } from "./invoice-markdown";

function renderMarkdown(markdown: string) {
  return render(<ReactMarkdown components={invoiceMarkdownComponents}>{markdown}</ReactMarkdown>);
}

describe("invoiceMarkdownComponents", () => {
  // Bank details are typically written as a list. With no typography plugin in
  // this repo, an unstyled list loses its bullets and its spacing, which is the
  // difference between reading an account number and squinting at a blob.
  it("styles the list a set of bank details is usually written as", () => {
    renderMarkdown("Pay to:\n\n- Account: UTS Jitsu Club\n- BSB: 062-000\n- Account: 1234 5678");
    expect(screen.getByText("Pay to:").className).toContain("leading-relaxed");
    expect(screen.getByRole("list").className).toContain("list-disc");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  // The block sits under the card's own "How to pay" title.
  it("shifts headings down so nothing in the instructions outranks the card", () => {
    renderMarkdown("# Bank transfer\n\n### PayID");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "Bank transfer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 5, name: "PayID" })).toBeInTheDocument();
  });

  it("keeps emphasis a manager used to make a number stand out", () => {
    renderMarkdown("BSB **062-000**, PayID `pay@jitsu.au`");
    expect(screen.getByText("062-000").className).toContain("font-semibold");
    expect(screen.getByText("pay@jitsu.au").className).toContain("font-mono");
  });

  it("sends a link in the instructions to a new tab", () => {
    renderMarkdown("[Our bank](https://example.com)");
    const link = screen.getByRole("link", { name: "Our bank" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
