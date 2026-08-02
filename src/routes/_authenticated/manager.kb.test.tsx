// The mount effect that opens the first article on load used to reset that
// article's section, position and sidebar label to blank the moment it was
// next saved.
//
// The effect only runs once (`useEffect(..., [fetchArticles, fetchSections])`,
// both stable), so it calls the `openDocument` closure fixed at the render
// where the effect was created — where `articles` was still `[]`. `setArticles`
// schedules a re-render; it does not reach back into an already-created
// closure. `openDocument` read placement off that stale, empty array, applied
// blank values, and stored THOSE blank values as the baseline — so nothing on
// screen looked dirty, and the next "Save as new version" wrote the blanks
// straight to the database. This pins that autoload shows the real placement.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  useNavigate: () => vi.fn(),
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const article = {
  slug: "our-history",
  title: "Our history",
  version: 3,
  versions: 3,
  visibility: "members" as const,
  annotations_enabled: true,
  change_note: null,
  updated_at: "2026-01-01T00:00:00Z",
  // The fields the bug reset to blank.
  section: "about-the-club",
  position: 20,
  nav_title: "History",
  link_path: null,
};

vi.mock("@/lib/kb.functions", () => ({
  listManagerArticles: () => Promise.resolve([article]),
  listManagerSections: () =>
    Promise.resolve([{ slug: "about-the-club", title: "About the club", position: 30 }]),
  getManagerArticle: () =>
    Promise.resolve({
      slug: article.slug,
      title: article.title,
      body_md: "# Our history",
      version: article.version,
      is_current_version: true,
      change_note: null,
      visibility: article.visibility,
      annotations_enabled: article.annotations_enabled,
      nav_title: article.nav_title,
      updated_at: article.updated_at,
    }),
  listArticleVersions: () =>
    Promise.resolve([
      {
        id: "v3",
        version: 3,
        title: article.title,
        change_note: null,
        is_current: true,
        created_at: article.updated_at,
      },
    ]),
  listManagerAnnotations: () => Promise.resolve([]),
  saveManagerArticle: vi.fn(),
  saveManagerSection: vi.fn(),
  deleteManagerSection: vi.fn(),
  setCurrentArticleVersion: vi.fn(),
}));

const { Route } = await import("./manager.kb");
const KnowledgeBaseManager = (Route as unknown as { component: () => ReactNode }).component;

describe("/manager/kb autoload", () => {
  it("shows the first article's real sidebar label, not a blank one", async () => {
    render(<KnowledgeBaseManager />);

    const navTitle = await screen.findByLabelText(/sidebar label/i);
    expect(navTitle).toHaveValue(article.nav_title);
  });

  it("does not report the freshly opened article as having unsaved changes", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
  });
});
