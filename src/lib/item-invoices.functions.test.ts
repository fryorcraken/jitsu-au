// The parts of item invoicing that move money: the bank statement match and
// recording a payment. Both take their client as a parameter, so they can be
// driven here with a fake one (a `createServerFn` handler cannot be called from
// the runner at all).
//
// The fake answers any query chain on a table with a result chosen per table
// and per operation, and records every write, so a test asserts on what was
// WRITTEN rather than on how the query was spelled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });
const fails = (message: string): Result => ({ data: null, error: { message } });

type Op = "select" | "update" | "insert" | "delete";
type Write = { table: string; op: Op; patch: unknown; filters: [string, string, unknown][] };

function fakeAdmin(results: Partial<Record<string, Partial<Record<Op, Result>>>>) {
  const writes: Write[] = [];
  const admin = {
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      let op: Op = "select";
      let patch: unknown = null;
      const chain: Record<string, unknown> = {};
      const passthrough = (name: string) =>
        (chain[name] = (column?: string, value?: unknown) => {
          if (column) filters.push([name, column, value]);
          return chain;
        });
      for (const m of ["select", "eq", "is", "not", "in", "order", "limit"]) passthrough(m);
      for (const m of ["update", "insert", "delete"] as const) {
        chain[m] = (p?: unknown) => {
          op = m;
          patch = p ?? null;
          return chain;
        };
      }
      const settle = () => {
        if (op !== "select") writes.push({ table, op, patch, filters });
        return results[table]?.[op] ?? ok(op === "select" ? [] : [{ id: "row" }]);
      };
      chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve, reject);
      chain.maybeSingle = () => Promise.resolve(settle());
      chain.single = () => Promise.resolve(settle());
      return chain;
    },
  };
  return { admin, writes };
}

// No `user_id`, so no receipt is attempted: the email path is its own concern
// (`membership-email.server.ts`) and is best-effort by design.
const INVOICE = {
  id: "inv-12",
  invoice_number: 12,
  payment_reference: "INV0012",
  user_id: null,
  lines: [{ name: "Club gi", unit_price_cents: 8500, quantity: 1 }],
  total_cents: 8500,
  paid_at: null,
  payment_method: null,
  cancelled_at: null,
  created_by: null,
  client_submission_id: null,
  created_at: "2026-10-01T00:00:00Z",
};

const txn = (over: object = {}) => ({
  id: "txn-1",
  description: "OSKO PAYMENT inv0012 A SMITH",
  reference: null,
  amount_cents: 8500,
  posted_at: "2026-10-02",
  status: "unmatched",
  ...over,
});

async function settle(fake: ReturnType<typeof fakeAdmin>, txns: object[]) {
  const { settleItemInvoicesFromStatement } = await import("./item-invoices.functions");
  return settleItemInvoicesFromStatement(fake.admin as never, txns as never);
}

describe("settleItemInvoicesFromStatement", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("records the payment and marks the statement line matched", async () => {
    const fake = fakeAdmin({ item_invoices: { select: ok([INVOICE]) } });
    const matched = await settle(fake, [txn()]);
    expect([...matched]).toEqual(["txn-1"]);
    const paid = fake.writes.find((w) => w.table === "item_invoices" && w.op === "update");
    expect(paid?.patch).toEqual({ paid_at: expect.any(String), payment_method: "bank_transfer" });
    const line = fake.writes.find((w) => w.table === "bank_transactions");
    expect(line?.patch).toMatchObject({ matched_item_invoice_id: "inv-12", status: "matched" });
  });

  // A short transfer (a bank fee taken out on the way) is a manager's call.
  it("leaves a line for the wrong amount alone", async () => {
    const fake = fakeAdmin({ item_invoices: { select: ok([INVOICE]) } });
    expect((await settle(fake, [txn({ amount_cents: 8000 })])).size).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it("leaves a line that fits two invoices for a manager rather than guessing", async () => {
    const twin = { ...INVOICE, id: "inv-13", payment_reference: "INV0013" };
    const fake = fakeAdmin({ item_invoices: { select: ok([INVOICE, twin]) } });
    expect((await settle(fake, [txn({ description: "INV0012 INV0013" })])).size).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  // Two transfers quoting the same reference: the first pays it, and the
  // second must not be recorded against an invoice that is already settled.
  it("settles an invoice once, however many lines quote it", async () => {
    const fake = fakeAdmin({ item_invoices: { select: ok([INVOICE]) } });
    const matched = await settle(fake, [txn(), txn({ id: "txn-2" })]);
    expect([...matched]).toEqual(["txn-1"]);
  });

  it("throws when the open invoices cannot be read, rather than matching nothing", async () => {
    const fake = fakeAdmin({ item_invoices: { select: fails("statement timeout") } });
    await expect(settle(fake, [txn()])).rejects.toThrow("statement timeout");
  });

  // A manager marked it paid a moment before the import ran. The money on this
  // line is still what paid it, so the line is matched; the guarded write is
  // what stops a second payment and a second receipt being recorded.
  it("still matches the line when another writer recorded the payment first", async () => {
    const fake = fakeAdmin({ item_invoices: { select: ok([INVOICE]), update: ok([]) } });
    expect((await settle(fake, [txn()])).size).toBe(1);
  });
});

describe("recordItemInvoicePayment", () => {
  it("does nothing to an invoice that is already paid", async () => {
    const { recordItemInvoicePayment } = await import("./item-invoices.functions");
    const fake = fakeAdmin({});
    await expect(
      recordItemInvoicePayment(fake.admin as never, {
        invoice: { ...INVOICE, paid_at: "2026-10-01T00:00:00Z" },
        method: "manual",
      }),
    ).resolves.toEqual({ recorded: false });
    expect(fake.writes).toEqual([]);
  });

  it("refuses a cancelled invoice: there is nothing to pay on it", async () => {
    const { recordItemInvoicePayment, ItemInvoiceSettledError } =
      await import("./item-invoices.functions");
    const fake = fakeAdmin({});
    await expect(
      recordItemInvoicePayment(fake.admin as never, {
        invoice: { ...INVOICE, cancelled_at: "2026-10-01T00:00:00Z" },
        method: "manual",
      }),
    ).rejects.toBeInstanceOf(ItemInvoiceSettledError);
  });

  // Only pays an invoice that is still open at the moment of writing, so two
  // managers pressing at once record one payment.
  it("writes only while the invoice is still unpaid and not cancelled", async () => {
    const { recordItemInvoicePayment } = await import("./item-invoices.functions");
    const fake = fakeAdmin({});
    await recordItemInvoicePayment(fake.admin as never, { invoice: INVOICE, method: "manual" });
    const write = fake.writes.find((w) => w.table === "item_invoices");
    expect(write?.filters).toEqual(
      expect.arrayContaining([
        ["is", "paid_at", null],
        ["is", "cancelled_at", null],
      ]),
    );
  });
});

describe("cancelling and deleting", () => {
  it("refuses to cancel or delete a paid invoice", async () => {
    const { cancelItemInvoiceRow, deleteItemInvoiceRow, ItemInvoiceSettledError } =
      await import("./item-invoices.functions");
    const paid = { ...INVOICE, paid_at: "2026-10-01T00:00:00Z" };
    const fake = fakeAdmin({ item_invoices: { select: ok(paid) } });
    await expect(cancelItemInvoiceRow(fake.admin as never, "inv-12")).rejects.toBeInstanceOf(
      ItemInvoiceSettledError,
    );
    await expect(deleteItemInvoiceRow(fake.admin as never, "inv-12")).rejects.toBeInstanceOf(
      ItemInvoiceSettledError,
    );
    expect(fake.writes).toEqual([]);
  });

  // The guard on the write itself: a payment landing between the read and the
  // delete must win.
  it("deletes only while still unpaid, and says so when a payment won the race", async () => {
    const { deleteItemInvoiceRow } = await import("./item-invoices.functions");
    const fake = fakeAdmin({ item_invoices: { select: ok(INVOICE), delete: ok([]) } });
    await expect(deleteItemInvoiceRow(fake.admin as never, "inv-12")).rejects.toThrow(
      /paid a moment ago/,
    );
    expect(fake.writes[0].filters).toContainEqual(["is", "paid_at", null]);
  });

  it("treats cancelling an already-cancelled invoice as done", async () => {
    const { cancelItemInvoiceRow } = await import("./item-invoices.functions");
    const fake = fakeAdmin({
      item_invoices: { select: ok({ ...INVOICE, cancelled_at: "2026-10-01T00:00:00Z" }) },
    });
    await expect(cancelItemInvoiceRow(fake.admin as never, "inv-12")).resolves.toBeUndefined();
    expect(fake.writes).toEqual([]);
  });
});

describe("createItemInvoiceForUser", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  // The price on the invoice is the price list's, at the moment it is raised.
  it("charges the price list's price, not anything the caller sent", async () => {
    const { createItemInvoiceForUser } = await import("./item-invoices.functions");
    const fake = fakeAdmin({
      profiles: { select: ok({ user_id: "u1" }) },
      charge_items: { select: ok([{ id: "i1", name: "Club gi", price_cents: 8500 }]) },
      item_invoices: { insert: ok({ ...INVOICE, id: "new" }) },
    });
    const res = await createItemInvoiceForUser(
      fake.admin as never,
      { user_id: "u1", lines: [{ item_id: "i1", quantity: 2 }] },
      "manager-1",
    );
    expect(res.total_cents).toBe(17000);
    const insert = fake.writes.find((w) => w.table === "item_invoices" && w.op === "insert");
    expect(insert?.patch).toEqual({
      user_id: "u1",
      lines: [{ name: "Club gi", unit_price_cents: 8500, quantity: 2 }],
      total_cents: 17000,
      created_by: "manager-1",
      client_submission_id: null,
    });
  });

  // The screen retries a raise that timed out, and the first attempt may have
  // committed. The retry must find that invoice, not raise and email another.
  it("hands back the invoice a retried raise already made, and writes nothing", async () => {
    const { createItemInvoiceForUser } = await import("./item-invoices.functions");
    const fake = fakeAdmin({
      item_invoices: {
        select: ok({
          id: "inv-12",
          payment_reference: "INV0012",
          total_cents: 8500,
          user_id: "u1",
        }),
      },
    });
    const res = await createItemInvoiceForUser(
      fake.admin as never,
      {
        user_id: "u1",
        client_submission_id: "44444444-4444-4444-8444-444444444444",
        lines: [{ item_id: "i1", quantity: 1 }],
      },
      "manager-1",
    );
    expect(res).toMatchObject({ id: "inv-12", already_raised: true, emailed: false });
    expect(fake.writes).toEqual([]);
  });

  it("refuses somebody the club has no record of, before writing anything", async () => {
    const { createItemInvoiceForUser, ItemRecordNotFoundError } =
      await import("./item-invoices.functions");
    const fake = fakeAdmin({ profiles: { select: ok(null) } });
    await expect(
      createItemInvoiceForUser(
        fake.admin as never,
        { user_id: "nobody", lines: [{ item_id: "i1", quantity: 1 }] },
        null,
      ),
    ).rejects.toBeInstanceOf(ItemRecordNotFoundError);
    expect(fake.writes).toEqual([]);
  });
});
