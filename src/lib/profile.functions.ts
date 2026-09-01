// The details a signed-in person maintains about the people on their account,
// from `/account`. With no `userId` that is themselves, which is every caller
// today; with one it is checked by `assertActingFor` (`src/lib/household.ts`),
// so a guardian can reach a dependant and nobody else can reach anyone.
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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { updateMyProfileSchema } from "@/lib/validation";
import type { UpdateMyProfileFields, UpdateMyProfileInput } from "@/lib/validation";
import { resolveSubject } from "@/lib/household";

/**
 * The body of `updateMyProfile`, taking its client as a parameter.
 *
 * Pulled out of the `createServerFn` wrapper for one reason: the wrapper cannot
 * be called from the test runner (no Start context), so a gate left inside it
 * is a gate nothing can prove is still there. `contact-messages.functions.ts`
 * has the same split for the same reason. This is the only self-serve write
 * onto somebody else's `profiles` row, so it is the one that most needs saying.
 */
export async function updateProfileForCaller(
  admin: SupabaseClient<Database>,
  callerId: string,
  data: UpdateMyProfileInput,
): Promise<{ ok: true; fields: string[] }> {
  // `userId` names WHO this is about and is not a column, so it comes off
  // before anything else touches the patch. Absent means the caller.
  const { userId: target, ...fields } = data;

  // Resolved first, so a patch that turns out to be empty is still refused
  // rather than answered with a cheerful no-op that tells the caller their
  // target was acceptable. With no target this is the self-serve path it has
  // always been.
  const subjectId = await resolveSubject(admin, callerId, target);

  // Each card on /account sends only its own keys, so drop the absent ones:
  // `undefined` means "leave it alone", while an explicit `null` on a
  // nullable field means "clear it" and must survive to the UPDATE.
  // Typed rather than left as a bare index signature: `.update()` is then
  // still checked against the generated column list, so a key added to the
  // schema that is not a profiles column fails the typecheck here.
  const patch = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as UpdateMyProfileFields;
  // The schema's refine already rejects an empty patch; this keeps a future
  // caller from turning that into a pointless round trip.
  if (Object.keys(patch).length === 0) return { ok: true as const, fields: [] as string[] };

  const now = new Date().toISOString();
  // Media consent carries its own provenance, because the person page has to
  // tell a withdrawal the member made apart from one a manager recorded on
  // their behalf. Stamping the member's own id here is what makes the first
  // case distinguishable at all: `media_consent_updated_by === user_id` means
  // they set it themselves.
  //
  // It stamps whoever actually clicked, so a guardian answering for a
  // dependant records the GUARDIAN's id, not the dependant's. That makes three
  // possible values rather than two, and anything putting words to the column
  // has to tell all three apart. `mediaConsentProvenance` owns that rule; the
  // mistake it is written to prevent is reading "not the subject" as "a
  // manager", which reports a parent's decision about their own child as one
  // the club made.
  const provenance =
    patch.media_consent === undefined
      ? {}
      : { media_consent_updated_at: now, media_consent_updated_by: callerId };
  const { data: updated, error } = await admin
    .from("profiles")
    .update({ ...patch, ...provenance, updated_at: now })
    .eq("user_id", subjectId)
    .select("user_id");
  if (error) throw new Error(error.message);
  // PostgREST reports no error when the filter matched nothing, so without
  // this the page would toast "Saved" over a write that never happened.
  if (!updated || updated.length === 0) {
    throw new Error("We couldn't find your record to update. Please contact the club.");
  }
  return { ok: true as const, fields: Object.keys(patch) };
}

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateMyProfileSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return updateProfileForCaller(supabaseAdmin, context.userId, data);
  });
