import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SiteBannerBar } from "./SiteBanner";

const BANNER = {
  enabled: true,
  message: "Free trials are paused for now.",
  link_label: "Register your interest",
  link_href: "https://example.com/register",
};

describe("SiteBannerBar", () => {
  it("shows the message and its link, which a visitor can follow and close", () => {
    const onDismiss = vi.fn();
    render(<SiteBannerBar banner={BANNER} pathname="/" onDismiss={onDismiss} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com/register");
    expect(link).toHaveTextContent("Free trials are paused for now. Register your interest");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // A hover underline on the whole line drew a second line under the link text.
  it("underlines the link text once, and nothing else", () => {
    render(<SiteBannerBar banner={BANNER} pathname="/" onDismiss={() => {}} />);
    const link = screen.getByRole("link");
    // Under any variant: hover:, focus-visible:, group-hover/banner:, md:hover:...
    expect(link.className).not.toMatch(/(^|\s|:)underline(\s|$)/);
    const underlined = link.querySelectorAll(".underline");
    expect(underlined).toHaveLength(1);
    expect(underlined[0]).toHaveTextContent("Register your interest");
  });

  // The cue is the link's own: keyboard focus gets what hover gets.
  it("cues the link on keyboard focus as well as hover", () => {
    render(<SiteBannerBar banner={BANNER} pathname="/" onDismiss={() => {}} />);
    const link = screen.getByRole("link");
    expect(link.className).toMatch(/(^|\s)hover:bg-/);
    expect(link.className).toMatch(/(^|\s)focus-visible:bg-/);
    expect(link.className).toMatch(/(^|\s)focus-visible:ring-2(\s|$)/);
    const label = link.querySelector(".underline")!;
    expect(label.className).toContain("group-hover/banner:");
    expect(label.className).toContain("group-focus-visible/banner:");
  });

  it("shows a notice with no link as plain text", () => {
    render(
      <SiteBannerBar
        banner={{ ...BANNER, link_label: "", link_href: "" }}
        pathname="/"
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Free trials are paused for now.")).toBeInTheDocument();
  });

  // The manager's preview: trying the link must not leave an unsaved form.
  it("as a preview, has nothing to click", () => {
    render(<SiteBannerBar banner={BANNER} pathname="/" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Register your interest")).toBeInTheDocument();
  });
});
