// The "Connected assistants" card: the only way a manager can cut off an
// assistant they approved over MCP. What is pinned is that a failed load never
// reads as "none connected", and that a failed removal says so unless the list
// shows it went through anyway. The router, server functions and Supabase are
// mocked out.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listGrants = vi.fn();
const revokeGrant = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children, to, ...rest }: { children: ReactNode; to?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));

vi.mock("@/lib/manager-api-tokens.functions", () => ({
  listApiTokens: vi.fn().mockResolvedValue([]),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "m1" } }),
  useRoles: () => ({ isManager: true, loading: false }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      oauth: {
        listGrants: (...a: unknown[]) => listGrants(...a),
        revokeGrant: (...a: unknown[]) => revokeGrant(...a),
      },
    },
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: (m: string) => toastSuccess(m) } }));

const { Route } = await import("./manager.api-tokens");
const ApiTokensPage = (Route as unknown as { component: () => ReactNode }).component;

const GRANT = {
  client: { id: "c1", name: "Claude Code", uri: "", logo_uri: "" },
  scopes: [],
  granted_at: "2026-10-20T01:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Connected assistants", () => {
  it("lists what the manager has approved", async () => {
    listGrants.mockResolvedValue({ data: [GRANT], error: null });
    render(<ApiTokensPage />);
    // "Claude Code" is also the label on the connect-command box, so look in the row.
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(remove.closest("li")).toHaveTextContent("Claude Code");
  });

  it("says there are none only when the list actually loaded", async () => {
    listGrants.mockResolvedValue({ data: [], error: null });
    render(<ApiTokensPage />);
    expect(await screen.findByText("No assistants connected.")).toBeInTheDocument();
  });

  it("shows a failed load as a failure with a retry, not as none", async () => {
    listGrants.mockResolvedValue({ data: null, error: new Error("offline") });
    render(<ApiTokensPage />);
    expect(
      await screen.findByText("Connected assistants could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No assistants connected.")).not.toBeInTheDocument();
  });

  it("removes an assistant and re-reads the list", async () => {
    listGrants
      .mockResolvedValueOnce({ data: [GRANT], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    revokeGrant.mockResolvedValue({ data: {}, error: null });
    render(<ApiTokensPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(revokeGrant).toHaveBeenCalledWith({ clientId: "c1" });
    expect(await screen.findByText("No assistants connected.")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Claude Code removed");
  });

  it("keeps a failed removal on screen while the assistant is still listed", async () => {
    listGrants.mockResolvedValue({ data: [GRANT], error: null });
    revokeGrant.mockResolvedValue({ data: null, error: new Error("Service unavailable.") });
    render(<ApiTokensPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Claude Code may still be connected. Service unavailable. Check the list and try again.",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("treats an error as done when the re-read shows it gone", async () => {
    listGrants
      .mockResolvedValueOnce({ data: [GRANT], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    revokeGrant.mockResolvedValue({ data: null, error: new Error("grant not found") });
    render(<ApiTokensPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Claude Code removed"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
