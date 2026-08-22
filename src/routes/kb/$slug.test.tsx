// Following a cross-reference from one article to a section of another.
//
// The browser cannot do this part on its own: the article's text arrives after
// the page has loaded, so at the moment the browser looks for `#grading` there
// is nothing in the document with that id, and the reader lands at the top of a
// long syllabus with no sign that anything went wrong. These pin the two halves
// of the fix — the jump once the text is there, and what a reader is told when
// the section has been renamed away since the link was written.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useParams: () => ({ slug: "belts" }),
  }),
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
  // The page reads the fragment from the router as well as from the browser,
  // because a cross-reference between two articles is a router navigation now
  // and those fire no `hashchange`. These tests set `window.location.hash`
  // directly, so the router's view of it is empty throughout.
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { hash: "" } }),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "member-1" }, loading: false }),
}));

vi.mock("@/hooks/useKbNav", () => ({
  useKbNav: () => ({ nav: [], loading: false }),
}));

vi.mock("@/hooks/useKbArticle", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The real hook, so the fetch is exercised, but without the prefetching the
  // sidebar drives: there is no sidebar in this render.
  useKbArticlePrefetch: () => vi.fn(),
}));

const BODY = [
  "# Belts",
  "",
  "The club grades three times a year.",
  "",
  "## How grading works {#grading}",
  "",
  "You are graded on what you can show.",
  "",
  "## Fees",
  "",
  "Twenty dollars.",
].join("\n");

vi.mock("@/lib/kb.functions", () => ({
  getKbArticle: () =>
    Promise.resolve({
      article: {
        slug: "belts",
        title: "Belts",
        body_md: BODY,
        version: 2,
        visibility: "members",
        change_note: null,
        updated_at: "2026-08-01T00:00:00Z",
      },
      viewer: { signed_in: true, user_id: "member-1", is_manager: false, can_annotate: true },
      redirect_to: null,
    }),
  listAnnotations: () => Promise.resolve([]),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  resolveAnnotation: vi.fn(),
  markKbArticleRead: () => Promise.resolve({ recorded: false }),
}));

const { Route } = await import("./$slug");
const ArticlePage = (Route as unknown as { component: () => ReactNode }).component;

function renderArticle(hash: string) {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ArticlePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.location.hash = "";
  // jsdom implements neither, and the article page uses both to put the reader
  // where the link pointed.
  Element.prototype.scrollIntoView = vi.fn();
  // The read-progress observer at the foot of the article; jsdom has no such
  // API, and this test is not about reading progress.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof window.requestAnimationFrame;
});

describe("/kb/$slug section anchors", () => {
  it("scrolls to the section a cross-reference names, and puts focus there", async () => {
    renderArticle("#grading");

    await waitFor(() => expect(document.getElementById("grading")).not.toBeNull());
    const section = document.getElementById("grading");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // Focus, not just scroll: without it a keyboard or screen reader carries on
    // from the top of the page, wherever the viewport happens to be.
    await waitFor(() => expect(document.activeElement).toBe(section));
  });

  it("says so when the link points at a section the article no longer has", async () => {
    renderArticle("#throws");

    expect(await screen.findByText(/does not have/i)).toBeInTheDocument();
    expect(screen.getByText("#throws")).toBeInTheDocument();
  });

  // A notification about a comment sends the member to /kb/<slug>#comment-<id>.
  // That is not a stale cross-reference, and saying it is would be alarming.
  it("says nothing when the fragment is one of the app's own comment links", async () => {
    renderArticle("#comment-2a0f6e4c-0000-4000-8000-000000000000");

    await screen.findByRole("heading", { name: "Belts", level: 1 });
    expect(screen.queryByText(/does not have/i)).not.toBeInTheDocument();
  });

  it("says nothing about sections when the reader arrived without a fragment", async () => {
    renderArticle("");

    await screen.findByRole("heading", { name: "Belts", level: 1 });
    expect(screen.queryByText(/does not have/i)).not.toBeInTheDocument();
  });
});
