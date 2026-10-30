import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReactMarkdown from "react-markdown";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    hash,
    children,
    ...props
  }: {
    to: string;
    params?: { slug: string };
    hash?: string;
    children: React.ReactNode;
  }) => {
    const path = params ? to.replace("$slug", params.slug) : to;
    return (
      <a href={hash ? `${path}#${hash}` : path} {...props}>
        {children}
      </a>
    );
  },
}));

const preview = vi.fn();
vi.mock("@/hooks/useKbArticle", () => ({
  useKbArticle: (slug: string) => preview(slug),
}));

import { KbLinkPreview } from "./KbLinkPreview";

const SYLLABUS = {
  isPending: false,
  isError: false,
  fetchStatus: "idle",
  error: null,
  data: {
    redirect_to: null,
    article: {
      slug: "techniques",
      title: "Techniques",
      body_md: "## Advanced body grab\n\nStep in, hips low.\n\n## Wrist lock\n\nThumb on the hand.",
    },
  },
};

function renderLink() {
  return render(
    <KbLinkPreview
      slug="techniques"
      hash="advanced-body-grab"
      renderMarkdown={(markdown: string) => <ReactMarkdown>{markdown}</ReactMarkdown>}
    >
      <a href="/kb/techniques#advanced-body-grab">advanced body grab</a>
    </KbLinkPreview>,
  );
}

/** A click, reporting whether something stopped the browser following it. */
function click(element: HTMLElement): boolean {
  const event = createEvent.click(element);
  fireEvent(element, event);
  return event.defaultPrevented;
}

describe("KbLinkPreview", () => {
  // A phone has no hover. The first tap is the only way a member on one can
  // see what a technique is without leaving the syllabus.
  it("opens the card on the first tap instead of following the link", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });

    fireEvent.pointerDown(link, { pointerType: "touch" });
    expect(click(link)).toBe(true);

    expect(await screen.findByText("Step in, hips low.")).toBeInTheDocument();
    expect(screen.queryByText("Thumb on the hand.")).not.toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith("techniques");
  });

  // Otherwise a touch reader could look but never go.
  it("follows the link on the second tap", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });

    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);
    await screen.findByText("Step in, hips low.");

    fireEvent.pointerDown(link, { pointerType: "touch" });
    expect(click(link)).toBe(false);
  });

  it("offers a button in the card that goes to the section", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);

    const go = await screen.findByRole("link", { name: /Go to this section/ });
    expect(go).toHaveAttribute("href", "/kb/techniques#advanced-body-grab");
  });

  // A mouse click is somebody who has already decided.
  it("leaves a mouse click alone", () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });

    fireEvent.pointerDown(link, { pointerType: "mouse" });
    expect(click(link)).toBe(false);
  });

  it("says so when the preview could not be loaded", async () => {
    preview.mockReturnValue({
      isPending: false,
      isError: true,
      fetchStatus: "idle",
      error: new Error("That article does not exist, or is not available to you."),
      data: undefined,
    });
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That article does not exist, or is not available to you.",
    );
  });

  // A pen on a tablet has no hover either, so it peeks like a finger.
  it("treats a pen like a finger", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });

    fireEvent.pointerDown(link, { pointerType: "pen" });
    expect(click(link)).toBe(true);
    expect(await screen.findByText("Step in, hips low.")).toBeInTheDocument();
  });

  // A keyboard Enter is a click with no pointer behind it: that reader chose
  // the link and goes, rather than being made to press twice.
  it("follows a click with no pointer behind it", () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    expect(click(screen.getByRole("link", { name: "advanced body grab" }))).toBe(false);
  });

  // A `#section` jump stays on the page, so the card has to close itself.
  it("closes the card when the second tap follows the link", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);
    await screen.findByText("Step in, hips low.");

    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);
    await waitFor(() => expect(screen.queryByText("Step in, hips low.")).not.toBeInTheDocument());
  });

  /** Opens the card with a tap, and waits for its dismiss layer to start listening. */
  async function openByTap() {
    const link = screen.getByRole("link", { name: "advanced body grab" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);
    await screen.findByText("Step in, hips low.");
    // The layer attaches its outside-press listener on the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // A finger put down on the article is usually the start of a scroll, which
  // ends without a click. Closing on the touch itself would take the card away
  // the moment somebody tries to read past it.
  it("stays open when a finger lands elsewhere and scrolls", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    await openByTap();

    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    fireEvent.pointerCancel(document.body, { pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("Step in, hips low.")).toBeInTheDocument();
  });

  it("closes when a finger taps elsewhere", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    await openByTap();

    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    fireEvent.click(document.body);

    await waitFor(() => expect(screen.queryByText("Step in, hips low.")).not.toBeInTheDocument());
  });

  it("stays open when a finger taps inside the card", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    await openByTap();
    const passage = screen.getByText("Step in, hips low.");

    fireEvent.pointerDown(passage, { pointerType: "touch" });
    fireEvent.click(passage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("Step in, hips low.")).toBeInTheDocument();
  });

  it("closes straight away when a mouse presses elsewhere", async () => {
    preview.mockReturnValue(SYLLABUS);
    renderLink();
    await openByTap();

    fireEvent.pointerDown(document.body, { pointerType: "mouse" });

    await waitFor(() => expect(screen.queryByText("Step in, hips low.")).not.toBeInTheDocument());
  });

  // React Query holds a fetch with no connection rather than failing it, so
  // "Loading" would otherwise never end.
  it("says so when it is offline with nothing saved", async () => {
    preview.mockReturnValue({
      isPending: true,
      isError: false,
      fetchStatus: "paused",
      error: null,
      data: undefined,
    });
    renderLink();
    const link = screen.getByRole("link", { name: "advanced body grab" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);

    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
  });

  // A link to the whole article, not a section of it.
  it("titles a whole-article preview once", async () => {
    preview.mockReturnValue(SYLLABUS);
    render(
      <KbLinkPreview
        slug="techniques"
        renderMarkdown={(markdown: string) => <ReactMarkdown>{markdown}</ReactMarkdown>}
      >
        <a href="/kb/techniques">techniques</a>
      </KbLinkPreview>,
    );
    const link = screen.getByRole("link", { name: "techniques" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    click(link);

    expect(await screen.findAllByText("Techniques")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Read the article/ })).toHaveAttribute(
      "href",
      "/kb/techniques",
    );
  });
});
