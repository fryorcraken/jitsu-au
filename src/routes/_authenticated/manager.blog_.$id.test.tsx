// Same bug as manager.blog_.new.test.tsx, but this page's fix is the more
// complex of the two: `initial` is memoized off fetched `post` state, and
// `onSave` mutates that same `post` state afterward to establish the new
// baseline (see the comment at manager.blog_.$id.tsx:64-68). This pins both
// halves — typing must not be wiped mid-edit, and a save must re-seed to
// exactly what was saved rather than reverting or re-wiping the field.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const getBlogPostForEdit = vi.fn();
const updateBlogPost = vi.fn();

const post = {
  id: "post-1",
  slug: "hello-world",
  title: "Hello world",
  excerpt: "An excerpt",
  body_md: "Original body",
  status: "draft" as const,
  cover_image_path: null,
  cover_image_url: null,
  published_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useParams: () => ({ id: "post-1" }),
  }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/lib/blog.functions", () => ({
  getBlogPostForEdit: (...args: unknown[]) => getBlogPostForEdit(...args),
  updateBlogPost: (...args: unknown[]) => updateBlogPost(...args),
  uploadBlogImage: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { Route } = await import("./manager.blog_.$id");
const EditBlogPostPage = (Route as unknown as { component: () => ReactNode }).component;

beforeEach(() => {
  getBlogPostForEdit.mockReset().mockResolvedValue(post);
  updateBlogPost.mockReset().mockResolvedValue({ ok: true, slug: post.slug });
});

describe("/manager/blog/:id", () => {
  it("keeps typed text in the title field instead of resetting it on every keystroke", async () => {
    const user = userEvent.setup();
    render(<EditBlogPostPage />);

    const title = await screen.findByLabelText("Title");
    await user.type(title, " updated");

    expect(title).toHaveValue("Hello world updated");
  });

  it("re-seeds to the saved value after Save, instead of reverting or re-wiping the field", async () => {
    const user = userEvent.setup();
    render(<EditBlogPostPage />);

    const body = await screen.findByLabelText(/Body/);
    await user.clear(body);
    await user.type(body, "Rewritten body");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateBlogPost).toHaveBeenCalledTimes(1));
    const sent = updateBlogPost.mock.calls[0][0] as { data: { body_md: string } };
    expect(sent.data.body_md).toBe("Rewritten body");

    // The post-save re-seed effect (baseline now matches what was typed)
    // must not wipe the field back to the pre-save/original body.
    expect(await screen.findByLabelText(/Body/)).toHaveValue("Rewritten body");
  });
});
