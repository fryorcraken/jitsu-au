import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseAuth = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/assets/UTS_JITSU_CMYK.png.asset.json", () => ({
  default: { url: "logo.png" },
}));

import { SiteHeader } from "./SiteHeader";

describe("SiteHeader", () => {
  afterEach(() => {
    mockUseAuth.mockReset();
  });

  it('labels the logged-out auth link "Member login" (not "Sign in") for logged-out visitors', () => {
    mockUseAuth.mockReturnValue({ user: null });
    render(<SiteHeader />);

    // Rendered once in the desktop nav and once in the mobile nav.
    const links = screen.getAllByRole("link", { name: /member login/i });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/auth");
    }
    expect(screen.queryByText(/^sign in$/i)).not.toBeInTheDocument();
  });

  it('replaces the Membership and Account links with a single "Member space" link when logged in', () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1" } });
    render(<SiteHeader />);

    // One consolidated entry point, rendered in both the desktop and mobile nav,
    // pointing at the member area.
    const memberSpaceLinks = screen.getAllByRole("link", { name: /member space/i });
    expect(memberSpaceLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of memberSpaceLinks) {
      expect(link).toHaveAttribute("href", "/account");
    }
    // No standalone "Membership" item remains in the header.
    expect(screen.queryByRole("link", { name: /^membership$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/member login/i)).not.toBeInTheDocument();
  });

  // The marketing header is for people deciding whether to come. The knowledge
  // base needs a login and is reached from the member area, so advertising it
  // here would put a link to a sign-in wall in the middle of the nav a visitor
  // is browsing. Signed in or out: this header does not link to it.
  it("does not link to the knowledge base, which is members-only", () => {
    for (const user of [null, { id: "u1" }]) {
      mockUseAuth.mockReturnValue({ user });
      const { unmount } = render(<SiteHeader />);
      expect(screen.queryByRole("link", { name: /knowledge base/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("links to the public blog", () => {
    mockUseAuth.mockReturnValue({ user: null });
    render(<SiteHeader />);

    const links = screen.getAllByRole("link", { name: /^blog$/i });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/blog");
    }
  });
});
