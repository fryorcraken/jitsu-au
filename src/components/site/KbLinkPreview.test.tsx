import { describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
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
  useKbArticlePreview: (slug: string) => preview(slug),
}));

import { KbLinkPreview } from "./KbLinkPreview";

const SYLLABUS = {
  isPending: false,
  isError: false,
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
      renderMarkdown={(markdown) => <ReactMarkdown>{markdown}</ReactMarkdown>}
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
});
