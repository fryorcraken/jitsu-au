import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
      {...props}
    >
      {children}
    </a>
  ),
}));

import { UserLink } from "./UserLink";

describe("UserLink", () => {
  it("opens the person's record from their name", () => {
    render(<UserLink userId="u-1" name="Sam Lee" />);
    const link = screen.getByRole("link", { name: "Sam Lee" });
    expect(link).toHaveAttribute("href", "/manager/users/u-1");
  });

  // The bug this component was extracted for: half the manager tables printed
  // the name as dead text, so a manager had to go back to the directory and
  // search for the person they were already looking at.
  it("is a link a phone can see, not one that waits for a hover", () => {
    render(<UserLink userId="u-1" name="Sam Lee" />);
    expect(screen.getByRole("link", { name: "Sam Lee" }).className).toContain("underline");
  });

  // A 12px line of text is not a thumb-sized target, and two of these sit in
  // `text-xs` rows. The negative margin hands the space back, so the hit area
  // grows without the row moving.
  it("carries a tap target bigger than its own text", () => {
    render(<UserLink userId="u-1" name="Sam Lee" />);
    const link = screen.getByRole("link", { name: "Sam Lee" });
    expect(link.className).toContain("py-1");
    expect(link.className).toContain("-my-1");
  });

  it("prints the name as plain text when there is no record to open", () => {
    render(<UserLink userId={null} name="Kim Tran" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Kim Tran")).toBeInTheDocument();
  });

  it("still gives a nameless row something to click", () => {
    render(<UserLink userId="u-2" name={null} fallback="Unknown" />);
    expect(screen.getByRole("link", { name: "Unknown" })).toHaveAttribute(
      "href",
      "/manager/users/u-2",
    );
  });

  // A profile saved with a space in the name field is not a name, and rendering
  // it makes an invisible link out of the row a manager most needs to open.
  it("treats a blank name as no name", () => {
    render(<UserLink userId="u-3" name="   " fallback="Unknown" />);
    expect(screen.getByRole("link", { name: "Unknown" })).toBeInTheDocument();
  });

  it("falls back to an em dash when there is neither a name nor a record", () => {
    const { container } = render(<UserLink userId={null} name={null} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container).toHaveTextContent("—");
  });
});

// The regression this guards: the default fallback is an em dash, and a row
// with a record but no name would then render a link whose entire accessible
// name is "—". A screen reader announces "link, —", which says nothing about
// where it goes. Every call site that can link therefore names its fallback.
describe("UserLink callers", () => {
  it("never leaves a link labelled only by the placeholder dash", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = "src/routes/_authenticated";
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const source = readFileSync(`${dir}/${file}`, "utf8");
      // Each <UserLink ...> element, opening tag only.
      for (const [element] of source.matchAll(/<UserLink[\s\S]*?\/>/g)) {
        if (!/fallback=/.test(element)) offenders.push(`${file}: ${element.replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
