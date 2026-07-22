import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseAuth = vi.fn();
const mockUseRoles = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => mockUseAuth(),
  useRoles: () => mockUseRoles(),
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
  /^users$/i,
  /signed waivers/i,
  /waiver template/i,
  /membership plans/i,
  /bank reconciliation/i,
  /club settings/i,
  /agent access/i,
];

describe("MemberLayout", () => {
  afterEach(() => {
    mockUseAuth.mockReset();
    mockUseRoles.mockReset();
  });

  it("shows member links and the sign-out / back-to-site controls for any signed-in user", () => {
    mockUseAuth.mockReturnValue({ user: { id: "u1", email: "m@example.com" } });
    mockUseRoles.mockReturnValue({ roles: ["member"], isManager: false });

    render(
      <MemberLayout>
        <div>page body</div>
      </MemberLayout>,
    );

    expect(screen.getByRole("link", { name: /account/i })).toHaveAttribute("href", "/account");
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
    // Member links remain available to managers too.
    expect(screen.getByRole("link", { name: /account/i })).toBeInTheDocument();
  });
});
