// Server functions for email verification that are not manager actions.
//
// The manager-facing ones (correct an address, resend to somebody else) live in
// `club-user.functions.ts` alongside the rest of the person-detail screen.
//
// ⚠️ This file is bundled to the client, so the service-role client is only ever
// lazy-imported inside a handler, never at the top level.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const tokenSchema = z.object({ token: z.string().trim().min(1).max(120) });

/**
 * Redeem a verification token from the `?vt=` on a waiver prefill link.
 *
 * Called on page open, because arriving here from an emailed link is already
 * proof the address is real: waiting for a submission that may never happen
 * would throw that proof away.
 *
 * Public on purpose (signing a waiver needs no login) and deliberately opaque:
 * it always resolves to `{ ok: true }`, whatever the token turned out to be.
 * The caller has nothing to do with the difference, and an endpoint that
 * reported it would be a way to test which addresses the club holds.
 */
export const redeemWaiverEmailVerification = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { redeemVerificationToken } = await import("@/lib/email-verification.server");
      await redeemVerificationToken(supabaseAdmin, data.token);
    } catch (e) {
      console.error("[redeemWaiverEmailVerification] redemption failed:", e);
    }
    return { ok: true as const };
  });

/**
 * Send the signed-in member a fresh "confirm your email address" link.
 *
 * Backs the button on their own account page. The address is taken from their
 * login record rather than from the request, so this can only ever mail the
 * person who asked, at the address the club already holds.
 */
export const requestMyEmailVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: got, error } = await supabaseAdmin.auth.admin.getUserById(context.userId);
    if (error || !got.user?.email) throw new Error("Could not find your account email.");
    // Already proven: nothing to send, and saying so beats an email that only
    // repeats what is already true.
    if (got.user.email_confirmed_at) return { ok: true as const, alreadyVerified: true };

    const { sendVerificationEmail } = await import("@/lib/email-verification.server");
    const { sent } = await sendVerificationEmail({
      admin: supabaseAdmin,
      to: got.user.email,
      purpose: "self_resend",
      userId: context.userId,
      next: "/account",
    });
    if (!sent) throw new Error("We couldn't send that email just now. Try again shortly.");
    return { ok: true as const, alreadyVerified: false };
  });
