// The bug this whole safety net exists for: a manager wrote a post in the
// installed app, left it, and came back to an editor that had been relaunched
// empty. Everything they had typed was gone.
//
// The composer's only guard was `beforeunload`, which never fires for that: iOS
// ignores it, and an app the system reclaims in the background is not asked to
// unload, it is simply killed. So these tests drive the events a phone actually
// sends — `visibilitychange` to hidden — and then remount from scratch, which is
// what a relaunch is.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { BlogPostEditor, type BlogPostEditorValue } from "@/components/site/BlogPostEditor";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/blog.functions", () => ({ uploadBlogImage: vi.fn() }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const EMPTY: BlogPostEditorValue = {
  title: "",
  slug: "",
  excerpt: "",
  body_md: "",
  cover_image_path: "",
  cover_image_url: null,
  status: "draft",
};

function hidePage() {
  // What a phone sends when the app goes to the background. jsdom reports
  // "visible" by default and has no way to change it, so stub the getter.
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("BlogPostEditor draft recovery", () => {
  it("offers back a post the app was killed in the middle of", async () => {
    const user = userEvent.setup();
    const first = render(
      <BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />,
    );

    await user.type(screen.getByLabelText("Title"), "Grading day");
    await user.type(screen.getByLabelText(/Body/), "Everyone did well.");
    hidePage();
    first.unmount();

    render(<BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />);

    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/unsaved post on this device/i);

    await user.click(screen.getByRole("button", { name: /bring it back/i }));

    expect(screen.getByLabelText("Title")).toHaveValue("Grading day");
    expect(screen.getByLabelText(/Body/)).toHaveValue("Everyone did well.");
    // The offer is answered, so it does not linger over the restored form.
    expect(screen.queryByRole("button", { name: /bring it back/i })).not.toBeInTheDocument();
  });

  it("never restores on its own — the offer has to be accepted", async () => {
    const user = userEvent.setup();
    const first = render(
      <BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />,
    );
    await user.type(screen.getByLabelText("Title"), "Grading day");
    hidePage();
    first.unmount();

    render(<BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />);
    await screen.findByRole("button", { name: /bring it back/i });

    // Somebody who abandoned this draft on purpose, or who has since edited the
    // same post from a laptop, must not have this device's copy pushed over it.
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("forgets a draft that was discarded", async () => {
    const user = userEvent.setup();
    const first = render(
      <BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />,
    );
    await user.type(screen.getByLabelText("Title"), "Grading day");
    hidePage();
    first.unmount();

    const second = render(
      <BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />,
    );
    await user.click(await screen.findByRole("button", { name: /discard it/i }));
    second.unmount();

    render(<BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />);
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(""));
    expect(screen.queryByRole("button", { name: /bring it back/i })).not.toBeInTheDocument();
  });

  it("offers nothing when the draft matches what is already saved", async () => {
    const saved: BlogPostEditorValue = { ...EMPTY, title: "Grading day", body_md: "Done." };
    const user = userEvent.setup();
    const first = render(
      <BlogPostEditor initial={saved} saving={false} onSave={async () => true} />,
    );
    // Type something and take it straight back out again.
    await user.type(screen.getByLabelText("Title"), "!");
    await user.type(screen.getByLabelText("Title"), "{backspace}");
    hidePage();
    first.unmount();

    render(<BlogPostEditor initial={saved} saving={false} onSave={async () => true} />);
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Grading day"));
    expect(screen.queryByRole("button", { name: /bring it back/i })).not.toBeInTheDocument();
  });

  it("throws the draft away once the post has actually been saved", async () => {
    const user = userEvent.setup();
    const first = render(
      <BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />,
    );
    await user.type(screen.getByLabelText("Title"), "Grading day");
    await user.type(screen.getByLabelText(/Body/), "Everyone did well.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // The "new post" page navigates away rather than moving its baseline, so
    // without this the published post would be offered back as an unsaved draft
    // the next time somebody opened the composer.
    await waitFor(() => expect(window.localStorage.length).toBe(0));
    first.unmount();

    render(<BlogPostEditor initial={EMPTY} saving={false} onSave={async () => true} />);
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(""));
    expect(screen.queryByRole("button", { name: /bring it back/i })).not.toBeInTheDocument();
  });

  it("keeps the draft when the save failed", async () => {
    const user = userEvent.setup();
    const first = render(
      <BlogPostEditor initial={EMPTY} saving={false} onSave={async () => false} />,
    );
    await user.type(screen.getByLabelText("Title"), "Grading day");
    await user.type(screen.getByLabelText(/Body/), "Everyone did well.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    hidePage();
    first.unmount();

    render(<BlogPostEditor initial={EMPTY} saving={false} onSave={async () => false} />);
    await user.click(await screen.findByRole("button", { name: /bring it back/i }));
    expect(screen.getByLabelText("Title")).toHaveValue("Grading day");
  });
});
