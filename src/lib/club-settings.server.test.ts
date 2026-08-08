import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_INVOICE_INSTRUCTIONS } from "./validation";
import { getInvoiceInstructions } from "./club-settings.server";

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

  it("falls back to the default when the lookup throws", async () => {
    const admin = {
      from: () => {
        throw new Error("boom");
      },
    } as unknown as SupabaseClient<Database>;
    await expect(getInvoiceInstructions(admin)).resolves.toBe(DEFAULT_INVOICE_INSTRUCTIONS);
  });
});
