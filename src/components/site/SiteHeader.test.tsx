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

  it('shows the "Account" link when logged in instead of the auth link', () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1" } });
    render(<SiteHeader />);

    expect(screen.getAllByRole("link", { name: /account/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/member login/i)).not.toBeInTheDocument();
  });
});
