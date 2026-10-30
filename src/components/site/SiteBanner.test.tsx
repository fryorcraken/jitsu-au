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
