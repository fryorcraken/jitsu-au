import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_INVOICE_INSTRUCTIONS } from "./validation";
import { getInvoiceInstructions, readInvoiceInstructions } from "./club-settings.server";

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

describe("readInvoiceInstructions", () => {
  // "Nobody set any" and "we could not read them" both end up as the default
  // for the email, but the member's page says different things about them, so
  // the raw read has to keep them apart.
  it("reports a settled empty answer when nothing is stored", async () => {
    await expect(readInvoiceInstructions(settingsAdmin(null))).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(readInvoiceInstructions(settingsAdmin("   "))).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it("reports a failed read as not ok, whether it errors or throws", async () => {
    await expect(readInvoiceInstructions(erroringAdmin())).resolves.toEqual({
      ok: false,
      value: null,
    });
    const throwing = {
      from: () => {
        throw new Error("boom");
      },
    } as unknown as SupabaseClient<Database>;
    await expect(readInvoiceInstructions(throwing)).resolves.toEqual({ ok: false, value: null });
  });

  it("hands back the stored markdown, trimmed", async () => {
    await expect(readInvoiceInstructions(settingsAdmin("  BSB 062-000  "))).resolves.toEqual({
      ok: true,
      value: "BSB 062-000",
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

  it("falls back to the default when the lookup fails, so the email still sends", async () => {
    const throwing = {
      from: () => {
        throw new Error("boom");
      },
    } as unknown as SupabaseClient<Database>;
    await expect(getInvoiceInstructions(throwing)).resolves.toBe(DEFAULT_INVOICE_INSTRUCTIONS);
    await expect(getInvoiceInstructions(erroringAdmin())).resolves.toBe(
      DEFAULT_INVOICE_INSTRUCTIONS,
    );
  });
});
