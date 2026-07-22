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

  it('labels the logged-out auth link "Member login" (not "Sign in") for prospects', () => {
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

  it('consolidates Membership and Account into a single "Member space" menu when logged in', () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1" } });
    render(<SiteHeader />);

    // The two separate desktop buttons are replaced by one "Member space" entry point.
    expect(screen.getAllByText(/member space/i).length).toBeGreaterThanOrEqual(1);
    // Both destinations remain reachable (mobile nav renders them, desktop via the menu).
    const accountLinks = screen.getAllByRole("link", { name: /account/i });
    expect(accountLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of accountLinks) {
      expect(link).toHaveAttribute("href", "/account");
    }
    const membershipLinks = screen.getAllByRole("link", { name: /membership/i });
    expect(membershipLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of membershipLinks) {
      expect(link).toHaveAttribute("href", "/membership");
    }
    expect(screen.queryByText(/member login/i)).not.toBeInTheDocument();
  });
});
