// The point of the copy button is that a manager can hand out a post's real
// public address without opening it and reading the browser bar, so what is
// pinned here is the exact string it puts on the clipboard: the canonical
// jitsu.au URL, whatever host the manager happens to be signed in on. Drafts
// have no working URL (the public route filters to published), so they get no
// button rather than a link that 404s for whoever it is sent to.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listAllBlogPosts = vi.fn();
const deleteBlogPost = vi.fn();

const published = {
  id: "post-1",
  slug: "2026-08-01-hello-world",
  title: "Hello world",
  status: "published" as const,
  published_at: "2026-08-01T00:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};
const draft = {
  ...published,
  id: "post-2",
  slug: "2026-08-02-not-yet",
  title: "Not yet",
  status: "draft" as const,
  published_at: null,
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/blog.functions", () => ({
  listAllBlogPosts: (...args: unknown[]) => listAllBlogPosts(...args),
  deleteBlogPost: (...args: unknown[]) => deleteBlogPost(...args),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.blog");
const BlogPostsPage = (Route as unknown as { component: () => ReactNode }).component;

async function renderLoaded() {
  render(<BlogPostsPage />);
  await screen.findByRole("table");
}

function rowFor(title: string) {
  return within(screen.getByText(title).closest("tr")!);
}

beforeEach(() => {
  listAllBlogPosts.mockReset().mockResolvedValue([published, draft]);
  deleteBlogPost.mockReset();
});

describe("/manager/blog", () => {
  it("copies the post's canonical public URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderLoaded();

    await userEvent.click(rowFor("Hello world").getByRole("button", { name: /copy link/i }));

    expect(writeText).toHaveBeenCalledWith("https://jitsu.au/blog/2026-08-01-hello-world");
  });

  it("names each button after its own post, so a screen reader can tell them apart", async () => {
    await renderLoaded();
    expect(screen.getByRole("button", { name: "Copy link to Hello world" })).toBeInTheDocument();
  });

  it("offers no link for a draft, whose public URL is a 404", async () => {
    await renderLoaded();
    expect(rowFor("Not yet").queryByRole("button", { name: /copy link/i })).toBeNull();
  });

  it("puts the button in the title cell, which is reachable without scrolling the table", async () => {
    await renderLoaded();
    const cells = screen.getByText("Hello world").closest("tr")!.querySelectorAll("td");
    expect(
      within(cells[0] as HTMLElement).getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
  });
});
