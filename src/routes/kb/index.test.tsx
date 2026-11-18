// A member whose nav fetch fails used to be told the club has written nothing
// for them to read. That is a claim about the club, and it is the one message
// most likely to stop somebody coming back to the page.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mockUseKbNav = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/hooks/useKbNav", () => ({ useKbNav: () => mockUseKbNav() }));
// The list starts fetching an article on hover. That is behaviour of its own,
// covered in `useKbArticle`'s own tests; here it only has to not be a query
// client this suite does not have.
vi.mock("@/hooks/useKbArticle", () => ({ useKbArticlePrefetch: () => vi.fn() }));

const { Route } = await import("./index");
const KnowledgeBaseIndex = (Route as unknown as { component: () => ReactNode }).component;

describe("/kb index", () => {
  afterEach(() => mockUseKbNav.mockReset());

  it("keeps a failed load on screen with a retry, instead of the empty state", async () => {
    const refetch = vi.fn();
    mockUseKbNav.mockReturnValue({ nav: [], loading: false, error: "Failed to fetch", refetch });
    render(<KnowledgeBaseIndex />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The knowledge base could not be loaded.");
    expect(screen.queryByText(/nothing here for you to read yet/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("still says the knowledge base is empty when it genuinely is", () => {
    mockUseKbNav.mockReturnValue({ nav: [], loading: false, error: null, refetch: vi.fn() });
    render(<KnowledgeBaseIndex />);

    expect(screen.getByText(/nothing here for you to read yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces the wait rather than rendering bare text", () => {
    mockUseKbNav.mockReturnValue({ nav: [], loading: true, error: null, refetch: vi.fn() });
    render(<KnowledgeBaseIndex />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  // The by-topic view used to be reachable only from the sidebar, which a phone
  // folds away behind the menu button, so the front page offers it too.
  it("offers the syllabus by topic when there is a syllabus section", () => {
    mockUseKbNav.mockReturnValue({
      nav: [
        { slug: "syllabus", title: "Syllabus", kind: "syllabus", entries: [] },
        { slug: "start", title: "Start here", kind: "standard", entries: [] },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<KnowledgeBaseIndex />);

    const link = screen.getByRole("link", { name: /preparing for a grading/i });
    expect(link).toHaveAttribute("href", "/kb/syllabus");
  });

  it("does not offer the syllabus to a reader who has no belt page to open", () => {
    mockUseKbNav.mockReturnValue({
      nav: [{ slug: "start", title: "Start here", kind: "standard", entries: [] }],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<KnowledgeBaseIndex />);

    expect(screen.queryByRole("link", { name: /preparing for a grading/i })).toBeNull();
  });
});
