import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseAuth = vi.fn();
const mockUseRoles = vi.fn();
const mockUseNotifications = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
  useRoles: () => mockUseRoles(),
}));

// Mocked rather than wrapped in a QueryClientProvider: this suite is about the
// navigation, and the real hook would drag a server function and the query
// cache into every case here.
vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => mockUseNotifications(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/account" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/assets/UTS_JITSU_CMYK.png.asset.json", () => ({
  default: { url: "logo.png" },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

import { MemberLayout } from "./MemberLayout";

const managerOnlyLinks = [
  /check in/i,
  /^users$/i,
  /signed waivers/i,
  /waiver template/i,
  /blog posts/i,
  /blog comments/i,
  /membership plans/i,
  /bank reconciliation/i,
  /club settings/i,
  /agent access/i,
];

describe("MemberLayout", () => {
  beforeEach(() => {
    // Nothing waiting, unless a case says otherwise.
    mockUseNotifications.mockReturnValue({ badge: 0 });
  });

  afterEach(() => {
    mockUseAuth.mockReset();
    mockUseRoles.mockReset();
    mockUseNotifications.mockReset();
  });

  it("shows member links and the sign-out / back-to-site controls for any signed-in user", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1", email: "m@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["member"], isManager: false });

    render(
      <MemberLayout>
        <div>page body</div>
      </MemberLayout>,
    );

    expect(screen.getByRole("link", { name: /^knowledge base$/i })).toHaveAttribute("href", "/kb");
    expect(screen.getByRole("link", { name: /^account$/i })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: /^membership$/i })).toHaveAttribute(
      "href",
      "/membership",
    );
    expect(screen.getByRole("link", { name: /back to site/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByText("page body")).toBeInTheDocument();
  });

  it("hides the manager links from a plain member", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1", email: "m@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["member"], isManager: false });

    render(
      <MemberLayout>
        <div />
      </MemberLayout>,
    );

    for (const name of managerOnlyLinks) {
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
  });

  it("shows the manager links only when the user is a manager", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u2", email: "boss@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["manager", "member"], isManager: true });

    render(
      <MemberLayout>
        <div />
      </MemberLayout>,
    );

    expect(screen.getByRole("link", { name: /^dashboard$/i })).toHaveAttribute("href", "/manager");
    expect(screen.getByRole("link", { name: /check in/i })).toHaveAttribute(
      "href",
      "/manager/check-in",
    );
    expect(screen.getByRole("link", { name: /^users$/i })).toHaveAttribute(
      "href",
      "/manager/users",
    );
    expect(screen.getByRole("link", { name: /signed waivers/i })).toHaveAttribute(
      "href",
      "/manager/waivers",
    );
    expect(screen.getByRole("link", { name: /bank reconciliation/i })).toHaveAttribute(
      "href",
      "/manager/reconciliation",
    );
    expect(screen.getByRole("link", { name: /blog posts/i })).toHaveAttribute(
      "href",
      "/manager/blog",
    );
    expect(screen.getByRole("link", { name: /blog comments/i })).toHaveAttribute(
      "href",
      "/manager/blog-comments",
    );
    // The contact-form inbox. Same reasoning as the documents editor below: it
    // is the only screen in the app that can show a contact message at all, so
    // without a nav entry the messages stay as invisible as they were before it
    // existed.
    expect(screen.getByRole("link", { name: /^contact messages$/i })).toHaveAttribute(
      "href",
      "/manager/contact-messages",
    );
    // The documents editor. Without a nav entry a manager has no way to reach
    // it at all, which is exactly how it shipped API-only the first time.
    expect(screen.getByRole("link", { name: /^knowledge base editor$/i })).toHaveAttribute(
      "href",
      "/manager/kb",
    );
    expect(screen.getByRole("link", { name: /^membership plans$/i })).toHaveAttribute(
      "href",
      "/manager/membership-plans",
    );
    // Member links remain available to managers too.
    expect(screen.getByRole("link", { name: /account/i })).toBeInTheDocument();
  });

  // Notifications sit in the MEMBER group, not the manager one: a member's
  // replies land there too, so it is the one place anybody looks to catch up.
  it("shows notifications to a plain member", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1", email: "m@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["member"], isManager: false });

    render(
      <MemberLayout>
        <div />
      </MemberLayout>,
    );

    expect(screen.getByRole("link", { name: /^notifications$/i })).toHaveAttribute(
      "href",
      "/notifications",
    );
  });

  it("shows the unread count next to notifications", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1", email: "m@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["member"], isManager: false });
    mockUseNotifications.mockReturnValue({ badge: 3 });

    render(
      <MemberLayout>
        <div />
      </MemberLayout>,
    );

    expect(screen.getByText("3")).toBeInTheDocument();
  });

  // A "0" pill reads as something waiting when nothing is, so zero renders
  // nothing at all.
  it("renders no badge when nothing is waiting", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1", email: "m@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["member"], isManager: false });
    mockUseNotifications.mockReturnValue({ badge: 0 });

    render(
      <MemberLayout>
        <div />
      </MemberLayout>,
    );

    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
