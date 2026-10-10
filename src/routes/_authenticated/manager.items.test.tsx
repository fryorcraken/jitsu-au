// The price list and the unpaid item invoices. Two separate reads with two
// separate failure panels, because a price list that will not load must not
// hide what people owe, and an empty-looking list must never stand in for one
// that failed.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listChargeItems = vi.fn();
const listItemInvoices = vi.fn();
const saveChargeItem = vi.fn();
const deleteChargeItem = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "manager-1" }, session: null, loading: false }),
  useRoles: () => ({ roles: ["manager"], loading: false, isManager: true }),
}));
vi.mock("@/lib/item-invoices.functions", () => ({
  listChargeItems: (...args: unknown[]) => listChargeItems(...args),
  listItemInvoices: (...args: unknown[]) => listItemInvoices(...args),
  saveChargeItem: (...args: unknown[]) => saveChargeItem(...args),
  deleteChargeItem: (...args: unknown[]) => deleteChargeItem(...args),
  markItemInvoicePaid: vi.fn(),
  cancelItemInvoice: vi.fn(),
  deleteItemInvoice: vi.fn(),
}));

const { Route } = await import("./manager.items");
const ItemsPage = (Route as unknown as { component: () => ReactNode }).component;

const GI = { id: "i-gi", name: "Club gi", price_cents: 8500, created_at: "", updated_at: "1" };

const UNPAID = {
  id: "inv-7",
  payment_reference: "INV0007",
  user_id: "u-1",
  lines: [{ name: "Club gi", unit_price_cents: 8500, quantity: 1 }],
  summary: "Club gi",
  total_cents: 8500,
  state: "unpaid",
  paid_at: null,
  payment_method: null,
  cancelled_at: null,
  created_at: "2026-10-01T00:00:00Z",
  member_name: "Ada Lovelace",
  member_email: "ada@example.com",
  member_email_belongs_to: null,
};

beforeEach(() => {
  listChargeItems.mockReset().mockResolvedValue([GI]);
  listItemInvoices.mockReset().mockResolvedValue([UNPAID]);
  saveChargeItem
    .mockReset()
    .mockResolvedValue({ ...GI, id: "i-new", name: "Belt", price_cents: 1250 });
  deleteChargeItem.mockReset().mockResolvedValue({ ok: true });
});

describe("/manager/items", () => {
  it("shows the price list and what is still owed, with who owes it", async () => {
    render(<ItemsPage />);
    expect(await screen.findByText("$85", { selector: "span" })).toBeVisible();
    expect(await screen.findByText("INV0007")).toBeVisible();
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText(/1 waiting, \$85 in all/)).toBeVisible();
    expect(listItemInvoices).toHaveBeenCalledWith({ data: { state: "unpaid" } });
  });

  it("adds an item from a typed dollar price, in cents", async () => {
    render(<ItemsPage />);
    await userEvent.type(await screen.findByLabelText("Name"), "Belt");
    await userEvent.type(screen.getByLabelText("Price ($)"), "12.50");
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    await waitFor(() =>
      expect(saveChargeItem).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: "Belt", price_cents: 1250 } }),
      ),
    );
  });

  it("refuses a price that is not a price, in words, without calling the server", async () => {
    render(<ItemsPage />);
    await userEvent.type(await screen.findByLabelText("Name"), "Belt");
    await userEvent.type(screen.getByLabelText("Price ($)"), "free");
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/type a price/i);
    expect(saveChargeItem).not.toHaveBeenCalled();
  });

  it("keeps the failure beside the row when a reprice does not save", async () => {
    saveChargeItem.mockRejectedValue(new Error("We could not reach the server."));
    render(<ItemsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const price = screen.getAllByLabelText("Price ($)")[1];
    await userEvent.clear(price);
    await userEvent.type(price, "90");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("We could not reach the server.")).toBeVisible();
    // The typed value is still there to try again with.
    expect(price).toHaveValue("90");
  });

  it("says the unpaid list failed rather than that nothing is owed", async () => {
    listItemInvoices.mockRejectedValue(new Error("network"));
    render(<ItemsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unpaid invoices could not be loaded/i);
    expect(within(alert).getByText(/not the same as nothing being owed/i)).toBeVisible();
    expect(screen.queryByText(/nothing is owed/i)).toBeNull();
    // The price list still works.
    expect(screen.getByText("Club gi")).toBeVisible();
  });

  // An add form beside a list that did not load invites adding it all again.
  it("takes the add form away while the item list cannot be loaded", async () => {
    listChargeItems.mockRejectedValue(new Error("network"));
    render(<ItemsPage />);
    expect(await screen.findByText(/item list could not be loaded/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add item" })).toBeNull();
  });

  // The remove landed; only the refresh after it failed. That has to read as
  // a list to retry, never as a row frozen with its buttons greyed out.
  it("offers a retry when the refresh after a remove fails", async () => {
    render(<ItemsPage />);
    const remove = await screen.findByRole("button", { name: /remove/i });
    listChargeItems.mockRejectedValueOnce(new Error("network"));
    await userEvent.click(remove);
    await waitFor(() => expect(deleteChargeItem).toHaveBeenCalled());
    expect(await screen.findByText(/item list could not be loaded/i)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /try again/i })[0]).toBeEnabled();
  });
});
