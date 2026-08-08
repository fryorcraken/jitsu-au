import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_INVOICE_INSTRUCTIONS } from "./validation";
import { getInvoiceInstructions, readClubPaymentDetails } from "./club-settings.server";

const ACCOUNT = {
  account_name: "UTS Jitsu Club Inc",
  bsb: "062000",
  account_number: "12345678",
  bank_name: "Commonwealth Bank of Australia",
  swift_bic: "CTBAAU2S",
  bank_address: "Sydney NSW 2000, Australia",
  account_holder_address: "1 Broadway, Ultimo NSW 2007",
  note: "",
};

/** Fake admin whose club_settings row returns `value`. */
function settingsAdmin(value: string | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: value == null ? null : { value }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient<Database>;
}

/** Fake admin whose club_settings read comes back as a PostgREST error. */
function erroringAdmin() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        }),
      }),
    }),
  } as unknown as SupabaseClient<Database>;
}

const throwingAdmin = {
  from: () => {
    throw new Error("boom");
  },
} as unknown as SupabaseClient<Database>;

describe("readClubPaymentDetails", () => {
  it("returns the stored account", async () => {
    const res = await readClubPaymentDetails(settingsAdmin(JSON.stringify(ACCOUNT)));
    expect(res.ok).toBe(true);
    expect(res.details?.bsb).toBe("062000");
    expect(res.details?.swift_bic).toBe("CTBAAU2S");
  });

  // "Nobody published an account" and "we could not read the store" are
  // different answers, because the screens say different things about them to
  // somebody who is about to transfer money.
  it("reports a settled empty answer when nothing is stored", async () => {
    await expect(readClubPaymentDetails(settingsAdmin(null))).resolves.toEqual({
      ok: true,
      details: null,
    });
  });

  it("reports a failed read as not ok, whether it errors or throws", async () => {
    await expect(readClubPaymentDetails(erroringAdmin())).resolves.toEqual({
      ok: false,
      details: null,
    });
    await expect(readClubPaymentDetails(throwingAdmin)).resolves.toEqual({
      ok: false,
      details: null,
    });
  });

  // A blob that no longer parses must read as "not published", never as a
  // partial account: half an account is what sends money to the wrong place.
  it("treats an unparseable or incomplete blob as nothing published", async () => {
    await expect(readClubPaymentDetails(settingsAdmin("not json"))).resolves.toEqual({
      ok: true,
      details: null,
    });
    const halfAnAccount = JSON.stringify({ ...ACCOUNT, account_number: "" });
    await expect(readClubPaymentDetails(settingsAdmin(halfAnAccount))).resolves.toEqual({
      ok: true,
      details: null,
    });
  });
});

describe("getInvoiceInstructions", () => {
  it("returns the stored markdown when set", async () => {
    await expect(getInvoiceInstructions(settingsAdmin("Pay to BSB 062-000"))).resolves.toBe(
      "Pay to BSB 062-000",
    );
  });

  it("falls back to the default when unset or blank", async () => {
    await expect(getInvoiceInstructions(settingsAdmin(null))).resolves.toBe(
      DEFAULT_INVOICE_INSTRUCTIONS,
    );
    await expect(getInvoiceInstructions(settingsAdmin("   "))).resolves.toBe(
      DEFAULT_INVOICE_INSTRUCTIONS,
    );
  });

  it("falls back to the default when the lookup fails", async () => {
    await expect(getInvoiceInstructions(throwingAdmin)).resolves.toBe(DEFAULT_INVOICE_INSTRUCTIONS);
    await expect(getInvoiceInstructions(erroringAdmin())).resolves.toBe(
      DEFAULT_INVOICE_INSTRUCTIONS,
    );
  });
});
