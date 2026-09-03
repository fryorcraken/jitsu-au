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

  // The default has to survive both of `fallback`'s jobs at once. A dash would
  // label the plain-text row correctly and leave the link announced as
  // "link, —"; an action word like "View" would name the link and leave the row
  // with nothing to open reading as a broken button. Only a word standing in
  // for the person does both, so the default is pinned from both sides.
  it("gives a nameless row that HAS a record a link named after the person", () => {
    render(<UserLink userId="u-2" name={null} />);
    const link = screen.getByRole("link", { name: "Unknown" });
    expect(link).toHaveAttribute("href", "/manager/users/u-2");
  });

  it("gives a nameless row with NO record the same word, as plain text", () => {
    render(<UserLink userId={null} name={null} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  // Whatever the default becomes, it has to be sayable. Punctuation names a
  // link after nothing at all.
  it("defaults to a word, never a placeholder glyph", () => {
    render(<UserLink userId="u-3" name={null} />);
    expect(screen.getByRole("link").textContent).toMatch(/^[\p{L}][\p{L} ]*$/u);
  });

  // A profile saved with a space in the name field is not a name, and rendering
  // it makes an invisible link out of the row a manager most needs to open.
  it("treats a blank name as no name", () => {
    render(<UserLink userId="u-4" name="   " />);
    expect(screen.getByRole("link", { name: "Unknown" })).toBeInTheDocument();
  });

  it("lets a caller name the person in its own words", () => {
    render(<UserLink userId="u-5" name={null} fallback="Someone at the club" />);
    expect(screen.getByRole("link", { name: "Someone at the club" })).toBeInTheDocument();
  });
});
