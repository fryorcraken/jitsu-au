// Reads of the `club_settings` key/value store that more than one flow needs.
//
// The club's bank account lives here under `invoice_payment_details`, as a JSON
// blob of named fields (account name, BSB, account number, bank, plus the
// overseas ones). Both the member's "how to pay" panel and the invoice email
// render it, so the read belongs to neither of them.
//
// `invoice_payment_instructions` is the free text this replaced. Nothing
// member-facing reads it any more; it survives only so the manager settings
// screen can show what was there while the new fields are still empty.
//
// Server-only by convention rather than by dependency: nothing here imports a
// secret, but every caller passes a service-role client, and the store is
// manager-only under RLS.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_INVOICE_INSTRUCTIONS, parseClubPaymentDetails } from "@/lib/validation";
import type { ClubPaymentDetails } from "@/lib/validation";

type AdminClient = SupabaseClient<Database>;

/** One key's raw value, or `ok: false` when the store could not be read. */
async function readSetting(
  admin: AdminClient,
  key: string,
): Promise<{ ok: boolean; value: string | null }> {
  try {
    const { data, error } = await admin
      .from("club_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) return { ok: false, value: null };
    return { ok: true, value: data?.value?.trim() || null };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * The club's bank account. Three outcomes, deliberately kept apart:
 *
 * - `{ ok: true, details: {...} }` — a complete set of account details.
 * - `{ ok: true, details: null }` — nobody has published them yet, or what is
 *   stored is not a complete set. A real, settled answer.
 * - `{ ok: false, details: null }` — the store could not be read at all.
 *
 * The screens say different things about the last two, which is the whole reason
 * this does not collapse them: "the club has not put its account details up yet,
 * ask us" and "we could not reach our own settings just now, try again" send a
 * member who is about to transfer money to two different places. Never throws.
 */
export async function readClubPaymentDetails(
  admin: AdminClient,
): Promise<{ ok: boolean; details: ClubPaymentDetails | null }> {
  const { ok, value } = await readSetting(admin, "invoice_payment_details");
  return { ok, details: ok ? parseClubPaymentDetails(value) : null };
}

/**
 * The free text that used to be the payment instructions. Manager screen only:
 * it is shown read-only, beside the empty form, so the values in it can be
 * copied across into the fields. Falls back to the seeded default and never
 * throws, because failing to show a reference copy is not worth an error.
 */
export async function getInvoiceInstructions(admin: AdminClient): Promise<string> {
  const { value } = await readSetting(admin, "invoice_payment_instructions");
  return value ?? DEFAULT_INVOICE_INSTRUCTIONS;
}
