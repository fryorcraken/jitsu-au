// The details a signed-in person maintains about themselves, from `/account`.
//
// This is the self-serve write path onto `profiles`. It covers what somebody
// goes by, their kit sizes, and how the club reaches them. It deliberately
// cannot reach their legal name, date of birth, UTS student number, medical
// notes, minor/guardian fields or email: those are either evidence a signed
// waiver froze, something that changes what they pay, or their identity, and
// `updateMyProfileSchema` is `.strict()` so an attempt to send one is an error
// rather than a silently dropped key.
//
// ⚠️ Approving a waiver still promotes that submission's person fields onto the
// profile (`waiverToProfileFields` in validation.ts), and that set overlaps with
// the contact fields here. So a correction made on `/account` can be overwritten
// later by a manager approving an older waiver. `/account` says so in as many
// words; see docs/database.md's `profiles` section for the full writer list.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { updateMyProfileSchema } from "@/lib/validation";
import type { UpdateMyProfileInput } from "@/lib/validation";

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateMyProfileSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Each card on /account sends only its own keys, so drop the absent ones:
    // `undefined` means "leave it alone", while an explicit `null` on a
    // nullable field means "clear it" and must survive to the UPDATE.
    // Typed rather than left as a bare index signature: `.update()` is then
    // still checked against the generated column list, so a key added to the
    // schema that is not a profiles column fails the typecheck here.
    const patch = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    ) as UpdateMyProfileInput;
    // The schema's refine already rejects an empty patch; this keeps a future
    // caller from turning that into a pointless round trip.
    if (Object.keys(patch).length === 0) return { ok: true as const, fields: [] as string[] };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = new Date().toISOString();
    // Media consent carries its own provenance, because the person page has to
    // tell a withdrawal the member made apart from one a manager recorded on
    // their behalf. Stamping the member's own id here is what makes the first
    // case distinguishable at all: `media_consent_updated_by === user_id` means
    // they set it themselves.
    const provenance =
      patch.media_consent === undefined
        ? {}
        : { media_consent_updated_at: now, media_consent_updated_by: context.userId };
    const { data: updated, error } = await supabaseAdmin
      .from("profiles")
      .update({ ...patch, ...provenance, updated_at: now })
      .eq("user_id", context.userId)
      .select("user_id");
    if (error) throw new Error(error.message);
    // PostgREST reports no error when the filter matched nothing, so without
    // this the page would toast "Saved" over a write that never happened.
    if (!updated || updated.length === 0) {
      throw new Error("We couldn't find your record to update. Please contact the club.");
    }
    return { ok: true as const, fields: Object.keys(patch) };
  });
