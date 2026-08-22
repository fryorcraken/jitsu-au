// The editor writes a new live version out of whatever is in its fields, so an
// editor rendered over a failed load is dangerous rather than merely
// unhelpful: the body would be empty, and saving would publish that as the
// document people sign.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listWaiverTemplates = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock("@/lib/waiver.functions", () => ({
  listWaiverTemplates: (...args: unknown[]) => listWaiverTemplates(...args),
  saveWaiverTemplate: vi.fn(),
  setCurrentWaiverTemplate: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.waiver-template");
const EditorPage = (Route as unknown as { component: () => ReactNode }).component;

const template = {
  id: "t1",
  version: 3,
  title: "Training waiver",
  body_md: "The live waiver text.",
  acknowledgements: [],
  is_current: true,
  created_at: "2026-08-01T00:00:00.000Z",
};

describe("manager waiver template editor", () => {
  it("refuses to open a blank editor over the live waiver when the load fails", async () => {
    listWaiverTemplates.mockRejectedValue(new Error("Failed to fetch"));
    render(<EditorPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The waiver template could not be loaded.");
    expect(alert).toHaveTextContent("saving would publish an empty waiver over it");
    expect(screen.queryByLabelText(/^title$/i)).not.toBeInTheDocument();
  });

  it("opens the editor once a retry lands", async () => {
    listWaiverTemplates
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue([template]);
    render(<EditorPage />);

    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByDisplayValue("The live waiver text.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // A non-manager is redirected rather than shown a failure, which is what the
  // Forbidden branch was always for. Keep it out of the new panel.
  it("leaves a Forbidden refusal to the redirect", async () => {
    listWaiverTemplates.mockRejectedValue(new Error("Forbidden"));
    render(<EditorPage />);

    await screen.findByRole("heading", { name: /waiver template/i });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
