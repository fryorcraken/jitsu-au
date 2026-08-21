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
import { render, screen, waitFor } from "@testing-library/react";
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
  link_path: null as string | null,
};

/**
 * Enough of a knowledge base to exercise the reading order: two real sections,
 * one of them empty, a link entry, and an article filed in no section at all.
 *
 * A single-article fixture cannot tell a working grouping from a broken one —
 * every entry lands in the only section there is either way.
 */
const houseRules = {
  ...article,
  slug: "house-rules",
  title: "House rules",
  position: 10,
  nav_title: null,
};
const syllabus = {
  ...article,
  slug: "syllabus",
  title: "Syllabus",
  section: "belts",
  position: 10,
  nav_title: null,
};
const firstClass = {
  ...article,
  slug: "first-class",
  title: "Your first session",
  section: "belts",
  position: 20,
  nav_title: "Your first session",
  link_path: "/first-class",
  version: null as number | null,
};
const stray = {
  ...article,
  slug: "stray",
  title: "Filed nowhere",
  section: "",
  position: 10,
  nav_title: null,
};

vi.mock("@/lib/kb.functions", () => ({
  listManagerArticles: () => Promise.resolve([article, houseRules, syllabus, firstClass, stray]),
  listManagerSections: () =>
    Promise.resolve([
      { slug: "belts", title: "Belts and grading", position: 10 },
      { slug: "nothing-yet", title: "Nothing yet", position: 20 },
      { slug: "about-the-club", title: "About the club", position: 30 },
    ]),
  getManagerArticle: ({ data }: { data: { slug: string } }) =>
    Promise.resolve({
      slug: data.slug,
      title: data.slug === article.slug ? article.title : data.slug,
      body_md: `# ${data.slug}`,
      version: article.version,
      is_current_version: true,
      change_note: null,
      visibility: article.visibility,
      annotations_enabled: article.annotations_enabled,
      nav_title: data.slug === article.slug ? article.nav_title : null,
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
  // button so the keyboard sensor has something to be tabbed to. Its label
  // carries the current position, which a screen reader has no other way to
  // learn before picking something up.
  it("gives every entry and section a grab handle instead of arrows", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.queryByLabelText(/move .* (up|down)/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder History, item 2 of 2 in About the club" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder About the club, section 3 of 3" }),
    ).toBeInTheDocument();
  });

  // A single-section fixture cannot tell working grouping from broken grouping.
  it("groups entries under their own sections, in reading order", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    // Sections sort by position: Belts (10), Nothing yet (20), About (30).
    const headings = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t === "Belts and grading" || t === "About the club");
    expect(headings).toEqual(["Belts and grading", "About the club"]);
    // House rules (10) sorts above History (20) inside About the club.
    expect(
      screen.getByRole("button", { name: "Reorder House rules, item 1 of 2 in About the club" }),
    ).toBeInTheDocument();
  });

  // "Everything else" is a drop target on this screen, so an article can be
  // dragged out of every section. The reader's sidebar still hides it when empty.
  it("shows the catch-all group and what is filed in it", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.getByText(/everything else/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder Filed nowhere, item 1 of 1 in Everything else" }),
    ).toBeInTheDocument();
  });

  // A section a manager has just created has to be somewhere they can drag the
  // first entry to, or the "New section" button is one with no result.
  it("keeps an empty section visible as a drop target", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    expect(screen.getByText(/drag an entry in here to fill it/i)).toBeInTheDocument();
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

  // Two editors now share the main window, so the discard prompt has to ask
  // about whichever one is VISIBLE. Consulting the article's dirty flag alone
  // would throw away a half-typed section name without a word.
  it("warns before throwing away a half-typed section name", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    await userEvent.click(screen.getByRole("button", { name: "About the club" }));
    await userEvent.type(screen.getByLabelText(/name/i), " and its people");
    expect(screen.getByRole("button", { name: /save the name/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /^Syllabus/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/discard your unsaved changes/i);

    // Keeping the edits is the way out, and it leaves the section editor as it
    // was rather than half-navigated.
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(/name/i)).toHaveValue("About the club and its people");
  });

  it("throws the half-typed name away once, and only once, it is confirmed", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    await userEvent.click(screen.getByRole("button", { name: "About the club" }));
    await userEvent.type(screen.getByLabelText(/name/i), " and its people");

    await userEvent.click(screen.getByRole("button", { name: /^Syllabus/ }));
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    // The click that was held up goes through: the section editor is gone.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /save the name/i })).not.toBeInTheDocument(),
    );
  });
});

describe("/manager/kb link entries", () => {
  // A link entry has no version and no comments, so opening one shows a much
  // smaller form rather than an article editor full of empty panels.
  it("opens the link form, not the article editor", async () => {
    render(<KnowledgeBaseManager />);

    await screen.findByLabelText(/sidebar label/i);
    await userEvent.click(screen.getByRole("button", { name: /^Your first session/ }));

    expect(screen.getByLabelText(/where it goes/i)).toHaveValue("/first-class");
    expect(screen.getByLabelText(/name in the sidebar/i)).toHaveValue("Your first session");
    expect(screen.queryByLabelText(/body \(markdown\)/i)).not.toBeInTheDocument();
    // Nothing has been edited, so there is nothing to save.
    expect(screen.getByRole("button", { name: /save the link/i })).toBeDisabled();
  });
});
