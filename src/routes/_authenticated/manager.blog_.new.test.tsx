// The "New post" page passed BlogPostEditor a fresh `initial={{...}}` object
// literal on every render. BlogPostEditor re-seeds its fields whenever that
// object's reference changes, and typing a single character flips its
// `dirty` flag, which this page reported via `onDirtyChange(setDirty)` —
// causing exactly the re-render that handed BlogPostEditor a new `initial`
// reference. The result: every keystroke was immediately wiped back to the
// empty starting value. This pins that a real object identity (via
// `useMemo`) keeps typed text on the page.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const createBlogPost = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/blog.functions", () => ({
  createBlogPost: (...args: unknown[]) => createBlogPost(...args),
  uploadBlogImage: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./manager.blog_.new");
const NewBlogPostPage = (Route as unknown as { component: () => ReactNode }).component;

describe("/manager/blog/new", () => {
  it("keeps typed text in the title field instead of resetting it on every keystroke", async () => {
    const user = userEvent.setup();
    render(<NewBlogPostPage />);

    await user.type(screen.getByLabelText("Title"), "Hello world");

    expect(screen.getByLabelText("Title")).toHaveValue("Hello world");
  });

  it("keeps typed text in the body field instead of resetting it on every keystroke", async () => {
    const user = userEvent.setup();
    render(<NewBlogPostPage />);

    await user.type(screen.getByLabelText(/Body/), "Some post content");

    expect(screen.getByLabelText(/Body/)).toHaveValue("Some post content");
  });
});
