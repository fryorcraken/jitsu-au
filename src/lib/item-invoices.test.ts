import { describe, expect, it } from "vitest";
import {
  buildItemInvoiceLines,
  describeItemInvoiceLine,
  isItemInvoiceUnpaid,
  itemInvoiceAsUnpaid,
  itemInvoiceState,
  itemInvoiceSummary,
  itemInvoiceTotalCents,
  ItemNoLongerListedError,
  parseItemInvoiceLines,
  statementLinePaysItemInvoice,
  whyItemInvoiceIsSettled,
} from "./item-invoices";
import { createItemInvoiceSchema, saveChargeItemSchema } from "./validation";

const GI = { id: "11111111-1111-4111-8111-111111111111", name: "Club gi", price_cents: 8500 };
const PATCH = { id: "22222222-2222-4222-8222-222222222222", name: "Club patch", price_cents: 1250 };
const USER = "33333333-3333-4333-8333-333333333333";

describe("buildItemInvoiceLines", () => {
  it("prices every line off the price list and adds them up", () => {
    const { lines, total_cents } = buildItemInvoiceLines(
      [GI, PATCH],
      [
        { item_id: GI.id, quantity: 1 },
        { item_id: PATCH.id, quantity: 3 },
      ],
    );
    expect(lines).toEqual([
      { name: "Club gi", unit_price_cents: 8500, quantity: 1 },
      { name: "Club patch", unit_price_cents: 1250, quantity: 3 },
    ]);
    expect(total_cents).toBe(8500 + 3 * 1250);
  });

  // A screen left open while an item is removed must not raise an invoice that
  // is quietly a line short.
  it("refuses an item that is no longer on the list rather than dropping it", () => {
    expect(() => buildItemInvoiceLines([GI], [{ item_id: PATCH.id, quantity: 1 }])).toThrow(
      ItemNoLongerListedError,
    );
  });
});

describe("the stored lines", () => {
  it("reads back what was written", () => {
    const lines = [{ name: "Club gi", unit_price_cents: 8500, quantity: 2 }];
    expect(parseItemInvoiceLines(lines)).toEqual(lines);
  });

  // An unreadable invoice must fail loudly, never read as an invoice for nothing.
  it("throws on a malformed value instead of returning no lines", () => {
    expect(() => parseItemInvoiceLines([])).toThrow();
    expect(() => parseItemInvoiceLines({ name: "x" })).toThrow();
    expect(() =>
      parseItemInvoiceLines([{ name: "Gi", unit_price_cents: 0, quantity: 1 }]),
    ).toThrow();
  });

  it("names a line with its quantity only when there is more than one", () => {
    expect(describeItemInvoiceLine({ name: "Club gi", unit_price_cents: 1, quantity: 1 })).toBe(
      "Club gi",
    );
    expect(describeItemInvoiceLine({ name: "Club patch", unit_price_cents: 1, quantity: 3 })).toBe(
      "3 × Club patch",
    );
    expect(
      itemInvoiceSummary([
        { name: "Club gi", unit_price_cents: 1, quantity: 1 },
        { name: "Club patch", unit_price_cents: 1, quantity: 2 },
      ]),
    ).toBe("Club gi, 2 × Club patch");
  });

  it("totals quantity times price across every line", () => {
    expect(
      itemInvoiceTotalCents([
        { name: "a", unit_price_cents: 500, quantity: 2 },
        { name: "b", unit_price_cents: 250, quantity: 1 },
      ]),
    ).toBe(1250);
  });
});

describe("an item invoice's state", () => {
  const open = { paid_at: null, cancelled_at: null };

  it("is unpaid until a payment is recorded or a manager cancels it", () => {
    expect(itemInvoiceState(open)).toBe("unpaid");
    expect(isItemInvoiceUnpaid(open)).toBe(true);
    expect(itemInvoiceState({ ...open, paid_at: "2026-10-01T00:00:00Z" })).toBe("paid");
    expect(itemInvoiceState({ ...open, cancelled_at: "2026-10-01T00:00:00Z" })).toBe("cancelled");
    expect(isItemInvoiceUnpaid({ ...open, cancelled_at: "2026-10-01T00:00:00Z" })).toBe(false);
  });

  it("can be cancelled or deleted only while it has not been paid", () => {
    expect(whyItemInvoiceIsSettled(open)).toBeNull();
    expect(whyItemInvoiceIsSettled({ ...open, cancelled_at: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(whyItemInvoiceIsSettled({ ...open, paid_at: "2026-10-01T00:00:00Z" })).toMatch(
      /has been paid/,
    );
  });
});

describe("itemInvoiceAsUnpaid", () => {
  // The member's "How to pay" panel draws membership and item invoices with one
  // shape, so an item invoice has to arrive in it looking like one transfer.
  it("is one transfer under its own reference, with a line per item", () => {
    expect(
      itemInvoiceAsUnpaid({
        id: "inv",
        payment_reference: "INV0007",
        total_cents: 11000,
        lines: [
          { name: "Club gi", unit_price_cents: 8500, quantity: 1 },
          { name: "Club patch", unit_price_cents: 1250, quantity: 2 },
        ],
      }),
    ).toEqual({
      reference: "INV0007",
      total_cents: 11000,
      lines: [
        { id: "inv:0", name: "Club gi", price_cents: 8500 },
        { id: "inv:1", name: "2 × Club patch", price_cents: 2500 },
      ],
    });
  });
});

describe("statementLinePaysItemInvoice", () => {
  const invoice = { payment_reference: "INV0012", total_cents: 8500 };

  it("matches the reference anywhere in the line, however the bank spaces it", () => {
    expect(statementLinePaysItemInvoice("TRANSFER FROM A SMITH inv0012", 8500, invoice)).toBe(true);
    expect(statementLinePaysItemInvoice("Ref:INV0012/gi", 8500, invoice)).toBe(true);
  });

  it("refuses the wrong amount, so a short payment waits for a manager", () => {
    expect(statementLinePaysItemInvoice("INV0012", 8000, invoice)).toBe(false);
  });

  // References are sequential, so a substring match would let one invoice's
  // transfer settle another's.
  it("needs the whole reference, not a prefix of a longer one", () => {
    expect(statementLinePaysItemInvoice("INV00120", 8500, invoice)).toBe(false);
    expect(
      statementLinePaysItemInvoice("INV001", 8500, {
        payment_reference: "INV0012",
        total_cents: 8500,
      }),
    ).toBe(false);
  });
});

describe("saveChargeItemSchema", () => {
  it("accepts a name and a price", () => {
    expect(saveChargeItemSchema.parse({ name: "  Club gi ", price_cents: 8500 })).toEqual({
      name: "Club gi",
      price_cents: 8500,
    });
  });

  it("refuses a free item, a fractional cent and a blank name", () => {
    expect(saveChargeItemSchema.safeParse({ name: "Gi", price_cents: 0 }).success).toBe(false);
    expect(saveChargeItemSchema.safeParse({ name: "Gi", price_cents: 10.5 }).success).toBe(false);
    expect(saveChargeItemSchema.safeParse({ name: "   ", price_cents: 100 }).success).toBe(false);
  });

  it("refuses a field it does not own", () => {
    expect(saveChargeItemSchema.safeParse({ name: "Gi", price_cents: 100, stock: 4 }).success).toBe(
      false,
    );
  });
});

describe("createItemInvoiceSchema", () => {
  it("takes items by id with a quantity", () => {
    const parsed = createItemInvoiceSchema.parse({
      user_id: USER,
      lines: [{ item_id: GI.id, quantity: 2 }],
    });
    expect(parsed.lines[0].quantity).toBe(2);
  });

  it("refuses an empty invoice and a zero quantity", () => {
    expect(createItemInvoiceSchema.safeParse({ user_id: USER, lines: [] }).success).toBe(false);
    expect(
      createItemInvoiceSchema.safeParse({ user_id: USER, lines: [{ item_id: GI.id, quantity: 0 }] })
        .success,
    ).toBe(false);
  });

  // Usually a double click. Saying so beats charging for two lines of the same thing.
  it("refuses the same item twice, pointing at the quantity instead", () => {
    const result = createItemInvoiceSchema.safeParse({
      user_id: USER,
      lines: [
        { item_id: GI.id, quantity: 1 },
        { item_id: GI.id, quantity: 1 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/quantity/);
  });

  // The price is read off the price list on the server. A price in the request
  // must be refused rather than silently ignored, or a caller would believe it
  // had set one.
  it("refuses a price sent with a line", () => {
    expect(
      createItemInvoiceSchema.safeParse({
        user_id: USER,
        lines: [{ item_id: GI.id, quantity: 1, unit_price_cents: 1 }],
      }).success,
    ).toBe(false);
  });
});
