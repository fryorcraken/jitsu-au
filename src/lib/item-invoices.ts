// What an item invoice is, once it exists. Pure and server-import-free, so every
// rule here is a unit test (`item-invoices.test.ts`) rather than something only
// a server context can exercise.
//
// An item invoice charges somebody for things on the club's price list that are
// not a membership: a gi, a patch, a grading fee. Product spec:
// docs/item-invoices.md. Three things about it are decided here, once, so the
// manager screens, the member's page, the bank match and the agent API cannot
// come to disagree:
//
//   - **What it owes.** Unpaid means no payment recorded AND not cancelled.
//     The same two-part rule `isUnpaid` holds for a membership, minus the
//     free-plan case: an item invoice always costs something (CHECK > 0).
//   - **What it says.** Its lines are a FROZEN copy of the name and price each
//     item had when it was raised. Renaming, repricing or removing an item on
//     the price list never reaches an invoice already sent, which is the whole
//     reason the lines are copied rather than referenced.
//   - **What pays it.** A statement line carrying its reference as a whole
//     word AND exactly its total. Whole word, not substring: references are
//     `INV0001`, `INV0012`, ..., and a substring match would let a transfer
//     for INV0012 settle INV001 as well.
import { z } from "zod";
import {
  formatCents,
  haystackContainsRef,
  ITEM_INVOICE_MAX_QUANTITY,
  type UnpaidInvoice,
} from "@/lib/validation";

/** One line of an invoice, as stored: what it was called and cost when raised. */
export type ItemInvoiceLine = {
  name: string;
  unit_price_cents: number;
  quantity: number;
};

/** The shape stored in `item_invoices.lines`. Written only by this app. */
const storedLinesSchema = z
  .array(
    z.object({
      name: z.string().min(1),
      unit_price_cents: z.number().int().positive(),
      quantity: z.number().int().min(1).max(ITEM_INVOICE_MAX_QUANTITY),
    }),
  )
  .min(1);

/**
 * Read an invoice's stored lines back.
 *
 * Throws on anything malformed rather than degrading to an empty list. The only
 * writer is `buildItemInvoiceLines` below, so a bad value is a bug or a hand
 * edit, and "this invoice is for nothing" is the one answer a screen about
 * money must never show in its place.
 */
export function parseItemInvoiceLines(value: unknown): ItemInvoiceLine[] {
  const parsed = storedLinesSchema.safeParse(value);
  if (!parsed.success) throw new Error("This invoice's lines could not be read.");
  return parsed.data;
}

/** What one line costs: its price times how many. */
export function lineTotalCents(line: ItemInvoiceLine): number {
  return line.unit_price_cents * line.quantity;
}

/** Every line added up: the amount to transfer. */
export function itemInvoiceTotalCents(lines: readonly ItemInvoiceLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}

/** "2 × Club patch", or just "Club patch" for one. */
export function describeItemInvoiceLine(line: ItemInvoiceLine): string {
  return line.quantity === 1 ? line.name : `${line.quantity} × ${line.name}`;
}

/** The whole invoice on one line, for a list row or an email subject. */
export function itemInvoiceSummary(lines: readonly ItemInvoiceLine[]): string {
  return lines.map(describeItemInvoiceLine).join(", ");
}

/**
 * Turn what a manager picked into the lines to store, priced off the price list.
 *
 * The price comes from `catalogue`, never from the request: a screen that was
 * left open while somebody else repriced an item would otherwise charge the old
 * price. An item missing from the catalogue (removed since the screen loaded)
 * is refused by name rather than dropped, because an invoice quietly missing a
 * line is worse than one that has to be raised again.
 */
export function buildItemInvoiceLines(
  catalogue: readonly { id: string; name: string; price_cents: number }[],
  requested: readonly { item_id: string; quantity: number }[],
): { lines: ItemInvoiceLine[]; total_cents: number } {
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const lines = requested.map((line) => {
    const item = byId.get(line.item_id);
    if (!item)
      throw new ItemNoLongerListedError(
        "One of those items has been removed from the price list since this page loaded. Refresh and pick again.",
      );
    return { name: item.name, unit_price_cents: item.price_cents, quantity: line.quantity };
  });
  return { lines, total_cents: itemInvoiceTotalCents(lines) };
}

/** A line named an item the price list no longer has. A 4xx, not a 500. */
export class ItemNoLongerListedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemNoLongerListedError";
  }
}

/** The facts about an invoice's state, and nothing else. */
type StateFields = { paid_at: string | null; cancelled_at: string | null };

export type ItemInvoiceState = "unpaid" | "paid" | "cancelled";

/** Which of the three an invoice is in. Paid wins: the CHECK forbids both. */
export function itemInvoiceState(invoice: StateFields): ItemInvoiceState {
  if (invoice.paid_at) return "paid";
  if (invoice.cancelled_at) return "cancelled";
  return "unpaid";
}

/** Still owed: no payment recorded, and not withdrawn by a manager. */
export function isItemInvoiceUnpaid(invoice: StateFields): boolean {
  return itemInvoiceState(invoice) === "unpaid";
}

/** The words a person reads for each state. */
export const ITEM_INVOICE_STATE_LABEL: Record<ItemInvoiceState, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  cancelled: "Cancelled",
};

/**
 * Why an invoice may not be cancelled or deleted, or null when it may.
 *
 * Both are refused once it is paid, for the reason a paid membership is never
 * deletable: `paid_at` is the club's record that money actually moved. There is
 * no refund flow, deliberately (docs/item-invoices.md), so a paid invoice is
 * simply finished.
 */
export function whyItemInvoiceIsSettled(invoice: StateFields): string | null {
  return invoice.paid_at
    ? "It has been paid, so it stays as the club's record of the money. It cannot be cancelled or deleted."
    : null;
}

/**
 * The invoice as the member's "How to pay" panel shows it: one transfer, its
 * reference, and its lines. The same shape membership invoices produce, so the
 * panel needs no second way to draw a bill.
 */
export function itemInvoiceAsUnpaid(invoice: {
  id: string;
  payment_reference: string;
  total_cents: number;
  lines: readonly ItemInvoiceLine[];
}): UnpaidInvoice {
  return {
    reference: invoice.payment_reference,
    total_cents: invoice.total_cents,
    lines: invoice.lines.map((line, i) => ({
      id: `${invoice.id}:${i}`,
      name: describeItemInvoiceLine(line),
      price_cents: lineTotalCents(line),
    })),
  };
}

/**
 * True when a bank-statement line pays this invoice: its reference as a whole
 * word somewhere in the description or reference field, AND exactly the total.
 * A short or long payment is left for a manager, the same as a membership.
 */
export function statementLinePaysItemInvoice(
  haystack: string,
  amountCents: number,
  invoice: { payment_reference: string; total_cents: number },
): boolean {
  return (
    amountCents === invoice.total_cents && haystackContainsRef(haystack, invoice.payment_reference)
  );
}

/** "Invoice INV0007, $85": how a manager's list and dropdowns name one. */
export function itemInvoiceLabel(invoice: { payment_reference: string; total_cents: number }) {
  return `${invoice.payment_reference}, ${formatCents(invoice.total_cents)}`;
}
