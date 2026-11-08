// On a belt page, a topic heading links to that topic for every belt up to the
// one being read: the next thing somebody preparing for this grading wants.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { KbArticleReader } from "./KbArticleReader";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to: _to,
    ...rest
  }: {
    children: ReactNode;
    search?: Record<string, string>;
    to?: string;
    [key: string]: unknown;
  }) => (
    <a href="#" data-search={JSON.stringify(search)} {...rest}>
      {children}
    </a>
  ),
}));

const article = {
  slug: "green-belt",
  title: "Green belt (5th Kyu)",
  body_md: "## Breakfalling\n\n- Judo rolls\n\n## Notes\n\nNot a topic.",
  version: 2,
  change_note: null,
  updated_at: "2026-11-01T00:00:00Z",
};

function renderReader(topicLink?: Parameters<typeof KbArticleReader>[0]["topicLink"]) {
  render(
    <KbArticleReader
      article={article}
      annotations={[]}
      viewer={{ signed_in: true, user_id: "u", is_manager: false, can_annotate: false }}
      topicLink={topicLink}
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onResolve={vi.fn()}
    />,
  );
}

describe("KbArticleReader on a belt page", () => {
  it("links a topic heading to that topic up to this belt, and only a topic heading", () => {
    renderReader((heading) =>
      heading.id === "breakfalling"
        ? {
            topic: "breakfalling",
            upTo: "green",
            label: "Breakfalling, every belt up to Green",
            short: "Every belt up to Green",
          }
        : null,
    );
    const link = screen.getByRole("link", { name: "Breakfalling, every belt up to Green" });
    expect(link).toHaveTextContent("Every belt up to Green");
    expect(JSON.parse(link.dataset.search!)).toEqual({ up_to: "green", topic: "breakfalling" });
    expect(screen.queryByRole("link", { name: /Notes, every belt/ })).not.toBeInTheDocument();
  });

  it("adds nothing to an ordinary article", () => {
    renderReader();
    expect(screen.queryByText(/every belt up to/i)).not.toBeInTheDocument();
  });
});
