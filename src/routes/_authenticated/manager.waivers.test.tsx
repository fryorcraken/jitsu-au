// The list pages all had the same shape: catch the load into a toast, then
// render the ordinary empty state underneath it. Four seconds later a manager
// is reading "No waivers signed yet." with no way to tell and nothing to
// press. This pins the fixed shape on one of them.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listWaivers = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/waiver.functions", () => ({
  listWaivers: (...args: unknown[]) => listWaivers(...args),
  getWaiverPdfUrl: vi.fn(),
  setWaiverApproval: vi.fn(),
}));
vi.mock("@/lib/google-drive.functions", () => ({
  getGoogleDriveStatus: () => Promise.resolve({ connected: false, folderId: null }),
  listMyDriveUploads: () => Promise.resolve([]),
  uploadWaiverToDrive: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.waivers");
const WaiversPage = (Route as unknown as { component: () => ReactNode }).component;

describe("manager waivers list", () => {
  it("keeps a failed load on screen instead of showing the empty state", async () => {
    listWaivers.mockRejectedValue(new Error("Failed to fetch"));
    render(<WaiversPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The signed waivers could not be loaded.");
    expect(alert).toHaveTextContent("This is not the same as nobody having signed one");
    expect(screen.queryByText(/no waivers signed yet/i)).not.toBeInTheDocument();
  });

  it("loads the list on a retry", async () => {
    listWaivers.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValue([]);
    render(<WaiversPage />);

    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/no waivers signed yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces the wait politely while it loads", () => {
    listWaivers.mockReturnValue(new Promise(() => {}));
    render(<WaiversPage />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });
});
