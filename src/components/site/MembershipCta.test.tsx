import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseAuth = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: { redirect?: string };
    children: React.ReactNode;
  }) => (
    <a
      href={search?.redirect ? `${to}?redirect=${encodeURIComponent(search.redirect)}` : to}
      {...props}
    >
      {children}
    </a>
  ),
}));

import { MembershipCta } from "./MembershipCta";

describe("MembershipCta", () => {
  afterEach(() => {
    mockUseAuth.mockReset();
  });

  // The bug this component exists for: /membership is behind the auth gate and
  // there is no self-serve sign-up, so linking a signed-out prospect at it
  // parked them in a sign-in box waiting for an email that never comes.
  it("sends a signed-out visitor into the joining funnel, never at the member area", () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    render(<MembershipCta />);

    expect(screen.getByRole("link", { name: "Join the club" })).toHaveAttribute(
      "href",
      "/register-interest",
    );
    expect(screen.queryByRole("link", { name: /manage your membership/i })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toBe("/membership");
    }
  });

  // Someone who already trains here and happens to be signed out is the other
  // half of the old "Join or manage" label. They still need a way through.
  it("offers a signed-out visitor a sign-in that lands on their membership page", () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });
    render(<MembershipCta />);

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth?redirect=%2Fmembership",
    );
  });

  it("takes a signed-in member straight to their membership page", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1" }, loading: false });
    render(<MembershipCta />);

    expect(screen.getByRole("link", { name: "Manage your membership" })).toHaveAttribute(
      "href",
      "/membership",
    );
    expect(screen.queryByRole("link", { name: "Join the club" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });

  // The session resolves a tick after hydration, and the server has no session
  // at all. Whatever is on screen in the meantime has to be pressable, and it
  // has to be the same thing the server rendered.
  it("shows the joining branch while the session is still resolving", () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });
    render(<MembershipCta />);

    expect(screen.getByRole("link", { name: "Join the club" })).toHaveAttribute(
      "href",
      "/register-interest",
    );
  });
});
