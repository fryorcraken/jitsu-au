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
 * The manager-set markdown payment instructions shown on invoices. Falls back to
 * a default until a manager customizes it. Never throws — a lookup hiccup falls
 * back to the default rather than blocking the invoice email or hiding the
 * payment details from a member who owes money.
 */
export async function getInvoiceInstructions(admin: AdminClient): Promise<string> {
  try {
    const { data } = await admin
      .from("club_settings")
      .select("value")
      .eq("key", "invoice_payment_instructions")
      .maybeSingle();
    return data?.value?.trim() || DEFAULT_INVOICE_INSTRUCTIONS;
  } catch {
    return DEFAULT_INVOICE_INSTRUCTIONS;
  }
}
