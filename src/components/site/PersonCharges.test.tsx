// Raising an item invoice emails somebody and cannot be unsent, so the card has
// to ask first, say who gets it, send what the manager actually picked, and
// carry the form fill's submission id so a retry cannot invoice twice.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const listChargeItems = vi.fn();
const listItemInvoices = vi.fn();
const createItemInvoice = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/item-invoices.functions", () => ({
  listChargeItems: (...args: unknown[]) => listChargeItems(...args),
  listItemInvoices: (...args: unknown[]) => listItemInvoices(...args),
  createItemInvoice: (...args: unknown[]) => createItemInvoice(...args),
  markItemInvoicePaid: vi.fn(),
  cancelItemInvoice: vi.fn(),
  deleteItemInvoice: vi.fn(),
}));

const { PersonCharges } = await import("./PersonCharges");

const GI = { id: "i-gi", name: "Club gi", price_cents: 8500, created_at: "", updated_at: "" };
const PATCH = {
  id: "i-patch",
  name: "Club patch",
  price_cents: 1250,
  created_at: "",
  updated_at: "",
};

beforeEach(() => {
  listChargeItems.mockReset().mockResolvedValue([GI, PATCH]);
  listItemInvoices.mockReset().mockResolvedValue([]);
  createItemInvoice.mockReset().mockResolvedValue({
    ok: true,
    id: "inv-7",
    reference: "INV0007",
    total_cents: 11000,
    emailed: true,
    already_raised: false,
  });
});

async function openCard(emailGoesTo: string | null = null) {
  render(<PersonCharges userId="u-1" personName="Bea Lovelace" emailGoesTo={emailGoesTo} />);
  await userEvent.click(await screen.findByRole("button", { name: "Charge items" }));
  await screen.findByRole("combobox", { name: "Add an item" });
}

describe("PersonCharges", () => {
  it("sends the items and quantities picked, after asking, with a submission id", async () => {
    await openCard();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add an item" }), "i-gi");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add an item" }), "i-patch");
    await userEvent.click(screen.getByRole("button", { name: "One more Club patch" }));

    await userEvent.click(screen.getByRole("button", { name: "Send invoice for $110" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Send Bea Lovelace an invoice for $110?");
    expect(dialog).toHaveTextContent("2 × Club patch: $25");
    expect(createItemInvoice).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Send invoice" }));
    await waitFor(() => expect(createItemInvoice).toHaveBeenCalledTimes(1));
    const { data } = createItemInvoice.mock.calls[0][0];
    expect(data).toEqual({
      user_id: "u-1",
      client_submission_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lines: [
        { item_id: "i-gi", quantity: 1 },
        { item_id: "i-patch", quantity: 2 },
      ],
    });
    expect(await screen.findByText(/INV0007 for \$110 is raised and emailed/)).toBeVisible();
  });

  it("sends nothing when the manager backs out of the confirm", async () => {
    await openCard();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add an item" }), "i-gi");
    await userEvent.click(screen.getByRole("button", { name: "Send invoice for $85" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(createItemInvoice).not.toHaveBeenCalled();
  });

  // A child has no mailbox. The manager must be told the guardian gets it.
  it("says the guardian gets the email when the person is a child", async () => {
    await openCard("Ada Lovelace");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add an item" }), "i-gi");
    await userEvent.click(screen.getByRole("button", { name: "Send invoice for $85" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "We email Ada Lovelace (Bea Lovelace's guardian)",
    );
  });

  it("says plainly when the invoice was raised but the email did not go", async () => {
    createItemInvoice.mockResolvedValue({
      ok: true,
      id: "inv-7",
      reference: "INV0007",
      total_cents: 8500,
      emailed: false,
      already_raised: false,
    });
    await openCard();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Add an item" }), "i-gi");
    await userEvent.click(screen.getByRole("button", { name: "Send invoice for $85" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send invoice" }),
    );
    expect(await screen.findByText(/the email did not go out/)).toBeVisible();
  });

  it("points at the item list when there is nothing on it to charge for", async () => {
    listChargeItems.mockResolvedValue([]);
    render(<PersonCharges userId="u-1" personName="Bea" emailGoesTo={null} />);
    await userEvent.click(await screen.findByRole("button", { name: "Charge items" }));
    expect(await screen.findByText(/nothing on the item list yet/i)).toBeVisible();
  });

  // Their invoices failing to load must not read as "no invoices yet".
  it("shows a retry, not an empty list, when their invoices cannot be loaded", async () => {
    listItemInvoices.mockRejectedValue(new Error("network"));
    render(<PersonCharges userId="u-1" personName="Bea" emailGoesTo={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /their item invoices could not be loaded/i,
    );
    expect(screen.queryByText(/no item invoices yet/i)).toBeNull();
  });
});
