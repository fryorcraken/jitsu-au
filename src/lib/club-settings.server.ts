// Reads of the `club_settings` key/value store that more than one flow needs.
//
// The club's receiving bank details (account name, BSB, PayID, whatever the
// managers wrote) are one value under `invoice_payment_instructions`. They used
// to live in `membership-email.server.ts` because the invoice email was the only
// thing that rendered them; the member's own membership page shows them too now,
// so they belong to neither caller.
//
// Server-only by convention rather than by dependency: nothing here imports a
// secret, but every caller passes a service-role client, and the store is
// manager-only under RLS.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_INVOICE_INSTRUCTIONS } from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/**
 * The raw read. Three outcomes, deliberately kept apart:
 *
 * - `{ ok: true, value: "..." }` — a manager has written instructions.
 * - `{ ok: true, value: null }` — nobody ever has. A real, settled answer.
 * - `{ ok: false }` — the store could not be read at all.
 *
 * The last two collapse into the same fallback for the invoice email, but not
 * for the member's page: "here is the generic wording, the club never filled in
 * its account" and "we could not reach our own settings just now" are different
 * things to put in front of someone about to transfer money, and only the second
 * is worth telling them to go back to their email for. Never throws.
 */
export async function readInvoiceInstructions(
  admin: AdminClient,
): Promise<{ ok: boolean; value: string | null }> {
  try {
    const { data, error } = await admin
      .from("club_settings")
      .select("value")
      .eq("key", "invoice_payment_instructions")
      .maybeSingle();
    if (error) return { ok: false, value: null };
    return { ok: true, value: data?.value?.trim() || null };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * The manager-set markdown payment instructions shown on invoices. Falls back to
 * a default until a manager customizes it. Never throws — a lookup hiccup falls
 * back to the default rather than blocking the invoice email or hiding the
 * payment details from a member who owes money.
 */
export async function getInvoiceInstructions(admin: AdminClient): Promise<string> {
  const { value } = await readInvoiceInstructions(admin);
  return value ?? DEFAULT_INVOICE_INSTRUCTIONS;
}
