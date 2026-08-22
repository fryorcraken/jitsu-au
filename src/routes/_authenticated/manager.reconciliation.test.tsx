// The worst version of the missing-load-error bug: this screen told a manager
// "Everything imported has been matched." when the transactions had not
// arrived at all. It is a money screen, so an all-clear it cannot back up is
// worse than no answer.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listBankTransactions = vi.fn();
const listMemberships = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/membership.functions", () => ({
  importBankStatement: vi.fn(),
  listBankTransactions: (...args: unknown[]) => listBankTransactions(...args),
  listMemberships: (...args: unknown[]) => listMemberships(...args),
  matchTransaction: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));

const { Route } = await import("./manager.reconciliation");
const ReconciliationPage = (Route as unknown as { component: () => ReactNode }).component;

// Every test sets both mocks itself, so there is nothing to reset between
// them. Clearing a mock whose rejected promise vitest is still tracking makes
// that rejection surface as an unhandled error and fails the run.
describe("manager reconciliation", () => {
  it("never reports the all-clear when the transactions could not be loaded", async () => {
    listBankTransactions.mockRejectedValue(new Error("Failed to fetch"));
    listMemberships.mockResolvedValue([]);
    render(<ReconciliationPage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The imported transactions could not be loaded.");
    expect(alert).toHaveTextContent("Failed to fetch");
    expect(screen.queryByText(/everything imported has been matched/i)).not.toBeInTheDocument();
  });

  it("retries the same fetch from the panel", async () => {
    listBankTransactions.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValue([]);
    listMemberships.mockResolvedValue([]);
    render(<ReconciliationPage />);

    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/everything imported has been matched/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still says everything is matched when the load worked and there is nothing left", async () => {
    listBankTransactions.mockResolvedValue([]);
    listMemberships.mockResolvedValue([]);
    render(<ReconciliationPage />);

    expect(await screen.findByText(/everything imported has been matched/i)).toBeInTheDocument();
  });
});
