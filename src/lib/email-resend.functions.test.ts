// A manager's resend, end to end through the real composer and the real
// sender, with only the database, the household lookup and the mail provider
// faked. What is pinned: it reaches the guardian for a child, it goes out
// under a key the provider will not drop, a second press inside a minute is
// refused while a retry of the first is not, and a record that has moved on
// is refused without sending anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const sendLovableEmail = vi.hoisted(() => vi.fn());
vi.mock("@lovable.dev/email-js", () => ({ sendLovableEmail }));

const deliveryRecipientFor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/household-email", () => ({
  deliveryRecipientFor,
  loadHouseholdContacts: vi.fn(),
}));

vi.mock("@/lib/club-settings.server", () => ({
  readClubPaymentDetails: () => Promise.resolve({ ok: true, details: null }),
  readClubReplyTo: () => Promise.resolve({ ok: true, address: null }),
}));

const { claimResendSlot, resendEmail, previewResend, ResendNotSentError } =
  await import("./email-resend.functions");

type Result<T> = { data: T | null; error: { code?: string; message: string } | null };
const ok = <T>(data: T): Result<T> => ({ data, error: null });

const INVOICE_ID = "7d4b6f0e-3a39-4a77-9d8b-2a1c1f0e5b11";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";

const UNPAID = {
  id: INVOICE_ID,
  user_id: CHILD_ID,
  payment_reference: "INV0007",
  lines: [{ name: "Club gi", unit_price_cents: 8500, quantity: 1 }],
  total_cents: 8500,
  paid_at: null as string | null,
  cancelled_at: null as string | null,
};

/**
 * `item_invoices` holding one row, and a `club_settings` store that behaves
 * like the real one where the claim depends on it: insert refuses a duplicate
 * key with 23505, and the conditional update really compares the stored value.
 */
function fakeDb(invoice: typeof UNPAID | null) {
  const settings = new Map<string, string>();
  const db = {
    from: (table: string) => {
      if (table === "item_invoices") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ok(invoice)) }) }),
        };
      }
      if (table === "club_settings") {
        return {
          insert: (row: { key: string; value: string }) => {
            if (settings.has(row.key))
              return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
            settings.set(row.key, row.value);
            return Promise.resolve({ error: null });
          },
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: () =>
                Promise.resolve(ok(settings.has(key) ? { value: settings.get(key)! } : null)),
            }),
          }),
          update: (patch: { value: string }) => {
            const filter: { key?: string; lt?: string } = {};
            const chain = {
              eq: (_col: string, key: string) => ((filter.key = key), chain),
              lt: (_col: string, cutoff: string) => ((filter.lt = cutoff), chain),
              select: () => {
                const current = settings.get(filter.key!);
                if (current !== undefined && current < filter.lt!) {
                  settings.set(filter.key!, patch.value);
                  return Promise.resolve(ok([{ key: filter.key }]));
                }
                return Promise.resolve(ok([]));
              },
            };
            return chain;
          },
          delete: () => {
            const filter: Record<string, string> = {};
            const chain = {
              eq: (col: string, value: string) => ((filter[col] = value), chain),
              then: (resolve: (r: { error: null }) => void) => {
                if (settings.get(filter.key) === filter.value) settings.delete(filter.key);
                resolve({ error: null });
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { settings, db: db as unknown as SupabaseClient<Database> };
}

const sent = () =>
  sendLovableEmail.mock.calls.map(
    ([p]) => p as { to: string; subject: string; idempotency_key: string },
  );

beforeEach(() => {
  process.env.LOVABLE_API_KEY = "test-key";
  sendLovableEmail.mockReset().mockResolvedValue({ success: true });
  // A child's invoice: the address and the greeting are the guardian's.
  deliveryRecipientFor
    .mockReset()
    .mockResolvedValue({ email: "ada@example.com", greetingName: "Ada", forName: "Bea" });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("resending an item invoice", () => {
  it("goes to the guardian for a child, and says whose address it is", async () => {
    const { db } = fakeDb(UNPAID);
    const preview = await previewResend(db, "item_invoice", INVOICE_ID);
    expect(preview).toMatchObject({ available: true, to: "ada@example.com", toBelongsTo: "Ada" });

    const result = await resendEmail(
      db,
      { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-1" },
      "manager-1",
    );
    expect(result).toEqual({ sent: true, to: "ada@example.com", toBelongsTo: "Ada" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].to).toBe("ada@example.com");
    expect(sent()[0].subject).toContain("Bea");
  });

  it("goes out under a key of its own, not the original send's", async () => {
    const { db } = fakeDb(UNPAID);
    await resendEmail(
      db,
      { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-1" },
      "manager-1",
    );
    expect(sent()[0].idempotency_key).toBe(`item-invoice-${INVOICE_ID}:resend:click-1`);
  });

  it("refuses a second press inside a minute, and sends nothing", async () => {
    const { db } = fakeDb(UNPAID);
    await resendEmail(
      db,
      { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-1" },
      "manager-1",
    );
    const second = await resendEmail(
      db,
      { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-2" },
      "manager-1",
    );
    expect(second).toMatchObject({ sent: false, reason: "rate_limited" });
    expect(second.sent === false && second.retryAfterSeconds).toBeGreaterThan(0);
    expect(sent()).toHaveLength(1);
  });

  it("lets a retry of the same press through, under the same key", async () => {
    const { db } = fakeDb(UNPAID);
    const input = { kind: "item_invoice" as const, record_id: INVOICE_ID, resendId: "click-1" };
    await resendEmail(db, input, "manager-1");
    const retry = await resendEmail(db, input, "manager-1");
    expect(retry.sent).toBe(true);
    // Two calls to the provider, one key: it delivers one email.
    expect(new Set(sent().map((p) => p.idempotency_key)).size).toBe(1);
  });

  it("gives the slot back when the send fails, so the manager can press again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, settings } = fakeDb(UNPAID);
    sendLovableEmail.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      resendEmail(
        db,
        { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-1" },
        "manager-1",
      ),
    ).rejects.toBeInstanceOf(ResendNotSentError);
    expect(settings.size).toBe(0);

    const again = await resendEmail(
      db,
      { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-2" },
      "manager-1",
    );
    expect(again.sent).toBe(true);
  });

  it("refuses the invoice once it is paid, pointing at the receipt", async () => {
    const { db } = fakeDb({ ...UNPAID, paid_at: "2026-10-01T00:00:00Z" });
    const result = await resendEmail(
      db,
      { kind: "item_invoice", record_id: INVOICE_ID, resendId: "click-1" },
      "manager-1",
    );
    expect(result).toMatchObject({ sent: false, reason: "paid" });
    expect(result.sent === false && result.message).toMatch(/resend the receipt/i);
    expect(sent()).toHaveLength(0);
  });

  it("refuses when nobody on the account has an address", async () => {
    deliveryRecipientFor.mockResolvedValue({ email: null, greetingName: "", forName: "Bea" });
    const { db } = fakeDb(UNPAID);
    const preview = await previewResend(db, "item_invoice", INVOICE_ID);
    expect(preview).toMatchObject({ available: false, reason: "no_address" });
  });
});

describe("claimResendSlot", () => {
  const now = new Date("2026-10-23T04:00:00.000Z");
  const later = (s: number) => new Date(now.getTime() + s * 1000);

  it("frees up again once the minute has passed", async () => {
    const { db } = fakeDb(null);
    expect(await claimResendSlot(db, "item_invoice", INVOICE_ID, "a", now)).toEqual({
      claimed: true,
    });
    expect(await claimResendSlot(db, "item_invoice", INVOICE_ID, "b", later(30))).toEqual({
      claimed: false,
      waitSeconds: 30,
    });
    expect(await claimResendSlot(db, "item_invoice", INVOICE_ID, "b", later(61))).toEqual({
      claimed: true,
    });
  });

  it("keeps each email for each record separate", async () => {
    const { db } = fakeDb(null);
    await claimResendSlot(db, "item_invoice", INVOICE_ID, "a", now);
    expect(await claimResendSlot(db, "item_invoice_receipt", INVOICE_ID, "b", now)).toEqual({
      claimed: true,
    });
  });
});
