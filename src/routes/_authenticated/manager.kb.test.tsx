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
import userEvent from "@testing-library/user-event";
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

describe("/manager/kb saving", () => {
  // Pressing Save on an article nobody has touched used to publish an identical
  // new version: it bumped the number every member's comments are pinned
  // against, and told readers the article had been updated when not a word of
  // it had changed.
  it("cannot be saved until something is edited", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    const save = screen.getByRole("button", { name: /save as new version/i });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/body/i), "\n\nA new paragraph.");
    expect(save).toBeEnabled();
  });

  // A change note describes a save rather than being part of the article, so a
  // note typed against unchanged text is not something to publish. This is the
  // one disabled-Save case that looks like a bug, so it is pinned deliberately.
  it("stays unsaveable when only the change note is filled in", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    await userEvent.type(screen.getByLabelText(/what changed/i), "Fixed a typo");
    expect(screen.getByRole("button", { name: /save as new version/i })).toBeDisabled();
  });
});

describe("/manager/kb reading order", () => {
  // The list is navigation and arrangement, nothing else. Renaming and deleting
  // moved into the main window so a click in the list can never be destructive.
  it("offers no rename or delete in the list", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.queryByLabelText(/^rename /i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^delete /i)).not.toBeInTheDocument();
  });

  // Dragging replaced the up/down arrows, and the handle is a real focusable
  // button so the keyboard sensor has something to be tabbed to.
  it("gives every entry and section a grab handle instead of arrows", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.queryByLabelText(/move .* (up|down)/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reorder History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reorder About the club" })).toBeInTheDocument();
  });

  // "Everything else" is a drop target on this screen even with nothing in it,
  // so an article can be dragged out of every section. The reader's sidebar
  // still hides it when empty.
  it("keeps an empty catch-all group as somewhere to drag things", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.getByText(/everything else/i)).toBeInTheDocument();
  });
});

describe("/manager/kb section editing", () => {
  // Where an entry sits is shown by where it sits in the list, and changed by
  // dragging it there. The old select only took effect on Save, which published
  // a new version for what was really just a move.
  it("has no section picker in the details view", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.queryByLabelText(/^section$/i)).not.toBeInTheDocument();
  });

  it("opens a section in the main window when its name is clicked", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    await userEvent.click(screen.getByRole("button", { name: "About the club" }));

    expect(screen.getByLabelText(/name/i)).toHaveValue("About the club");
    expect(screen.getByRole("button", { name: /delete this section/i })).toBeInTheDocument();
    // The key is shown but fixed: every article in the section refers to it.
    expect(screen.getByLabelText(/url key/i)).toBeDisabled();
    // Saving the name is disabled until the name is actually changed, for the
    // same reason the article's Save is.
    expect(screen.getByRole("button", { name: /save the name/i })).toBeDisabled();
  });
});
