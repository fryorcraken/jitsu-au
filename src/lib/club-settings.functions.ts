// Manager reads and writes of the club-wide settings in `club_settings`, the
// manager-only key/value store. `/manager/settings` and the manager agent API
// both come through here, so a value an agent saves and one a manager saves are
// the same row written the same way.
//
// Each key keeps its own validation (the `saveClubSettingsSchema` union in
// `validation.ts`) and its own read in `club-settings.server.ts`. What this file
// adds is the one rule every key shares: a manager is never shown an empty
// form when the truth is "we could not read it", because saving that form
// would overwrite a real value with blanks.
//
// ⚠️ Bundled to the client like every `*.functions.ts`, so the service-role
// client and the server reads are only ever lazy-imported inside a function.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MembershipClient } from "@/lib/membership-types";
import { requireManager } from "@/lib/require-manager";
import { saveClubSettingsSchema, type SaveClubSettingsInput } from "@/lib/validation";

async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * Every setting a manager edits (the bank account, the reply-to address), for
 * the screen and the agent API alike, plus whatever free text is left in the
 * old `invoice_payment_instructions` row. That legacy string is shown read-only beside an empty form so a manager can
 * copy the account details across; nothing member-facing renders it any more.
 *
 * Throws when the store could not be read, for the reason in the header.
 */
export async function loadClubSettings(admin: MembershipClient) {
  const { readClubPaymentDetails, readClubReplyTo, getInvoiceInstructions } =
    await import("@/lib/club-settings.server");
  const [payment, replyTo, legacyInstructions] = await Promise.all([
    readClubPaymentDetails(admin),
    readClubReplyTo(admin),
    getInvoiceInstructions(admin),
  ]);
  // One screen, one load: if either read failed, the screen shows no form at
  // all rather than one half-filled from what happened to come back.
  if (!payment.ok || !replyTo.ok) throw new Error("Could not read the club settings. Try again.");
  return {
    details: payment.details,
    email_reply_to: replyTo.address,
    legacy_instructions: legacyInstructions,
  };
}

/** How each key's validated value is stored in the `value` text column. */
function storedValue(input: SaveClubSettingsInput): string {
  switch (input.key) {
    case "invoice_payment_details":
      return JSON.stringify(input.value);
    case "email_reply_to":
      // Already trimmed and lowercased; "" is a cleared address, which reads
      // back as unset.
      return input.value;
  }
}

/** Write one setting. `input` must already have passed `saveClubSettingsSchema`. */
export async function writeClubSetting(
  admin: MembershipClient,
  input: SaveClubSettingsInput,
  actorId: string,
): Promise<{ ok: true }> {
  const { error } = await admin.from("club_settings").upsert(
    {
      key: input.key,
      value: storedValue(input),
      updated_at: new Date().toISOString(),
      updated_by: actorId,
    },
    { onConflict: "key" },
  );
  if (error) {
    // The database's own words help nobody at a settings screen. Log them, and
    // tell the manager the one thing they can do.
    console.error(`[club-settings] could not save ${input.key}:`, error.message);
    throw new Error("That was not saved. Nothing has changed.");
  }
  return { ok: true as const };
}

export const getClubSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    return loadClubSettings(await adminClient());
  });

export const saveClubSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveClubSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return writeClubSetting(await adminClient(), data, context.userId);
  });
