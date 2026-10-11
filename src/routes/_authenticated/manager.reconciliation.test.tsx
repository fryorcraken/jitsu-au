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
const listItemInvoices = vi.fn().mockResolvedValue([]);
const matchTransactionToItem = vi.fn().mockResolvedValue({ ok: true });

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
vi.mock("@/lib/item-invoices.functions", () => ({
  listItemInvoices: (...args: unknown[]) => listItemInvoices(...args),
  matchTransactionToItem: (...args: unknown[]) => matchTransactionToItem(...args),
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

  // A transfer for a gi has to be matchable by hand like any other payment, or
  // it sits on this list for ever with nothing it can be linked to.
  it("offers unpaid item invoices for a leftover transfer, and records the match", async () => {
    listBankTransactions.mockResolvedValue([
      {
        id: "txn-1",
        posted_at: "2026-10-02",
        amount_cents: 8500,
        description: "OSKO A SMITH GI",
        reference: null,
        status: "unmatched",
        matched_membership_id: null,
        matched_at: null,
        created_at: "2026-10-02T00:00:00Z",
      },
    ]);
    listMemberships.mockResolvedValue([]);
    listItemInvoices.mockResolvedValue([
      {
        id: "inv-7",
        payment_reference: "INV0007",
        member_name: "Ada Lovelace",
        member_email: "ada@example.com",
        total_cents: 8500,
      },
    ]);
    render(<ReconciliationPage />);

    const select = await screen.findByRole("combobox", { name: /match the \$85 transfer/i });
    expect(screen.getByRole("option", { name: /INV0007/ })).toBeInTheDocument();
    await userEvent.selectOptions(select, "i:inv-7");
    expect(matchTransactionToItem).toHaveBeenCalledWith({
      data: { transaction_id: "txn-1", item_invoice_id: "inv-7" },
    });
  });

  const TXN = {
    id: "txn-1",
    posted_at: "2026-10-02",
    amount_cents: 8500,
    description: "OSKO A SMITH GI",
    reference: null,
    status: "unmatched",
    matched_membership_id: null,
    matched_at: null,
    created_at: "2026-10-02T00:00:00Z",
  };

  // Matching membership transfers must not depend on the item invoice list.
  it("keeps the page working when only the item invoices fail to load", async () => {
    listBankTransactions.mockResolvedValue([TXN]);
    listMemberships.mockResolvedValue([]);
    listItemInvoices.mockRejectedValueOnce(new Error("network"));
    render(<ReconciliationPage />);

    expect(await screen.findByText(/unpaid item invoices could not be loaded/i)).toBeVisible();
    expect(screen.getByRole("combobox", { name: /match the \$85 transfer/i })).toBeVisible();
    expect(screen.queryByText(/imported transactions could not be loaded/i)).toBeNull();
  });

  // The refusal can say a member paid twice. A toast would fade with that in it.
  it("keeps a refused match on screen beside its transfer", async () => {
    listBankTransactions.mockResolvedValue([TXN]);
    listMemberships.mockResolvedValue([]);
    listItemInvoices.mockResolvedValue([
      { id: "inv-7", payment_reference: "INV0007", member_name: "Ada", total_cents: 8500 },
    ]);
    matchTransactionToItem.mockRejectedValueOnce(
      new Error("Invoice INV0007 is already paid, so this transfer was not linked to it."),
    );
    render(<ReconciliationPage />);

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: /match the \$85 transfer/i }),
      "i:inv-7",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/INV0007 is already paid/);
  });
});
