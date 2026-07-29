// Server-only side of email verification: minting, redeeming, revoking, sending.
//
// This module reaches the service-role client's types and the Lovable send API,
// so it must never land in the client bundle. It is named `*.server.ts` and is
// only ever lazy-imported from inside server-function handlers and route
// handlers, per the repo's bundling rule.
//
// The pure rules (what a token proves, how long it lives, where a link may
// land) live in `email-verification.ts` and are unit-tested there. This file is
// the plumbing around them.
import * as React from "react";
import { render } from "@react-email/render";
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { generateRawToken, hashToken, tokenPreview } from "@/lib/manager-api-tokens";
import { normalizeEmail } from "@/lib/validation";
import {
  buildVerifyUrl,
  isVerificationTokenLive,
  tokenProvesEmail,
  verificationExpiry,
  type VerificationPurpose,
} from "@/lib/email-verification";
import { VerifyEmail } from "@/lib/email-templates/verify-email";

// Mirror the sender configuration used by the other transactional senders.
const SITE_NAME = "UTS Jitsu";
// Must match SENDER_DOMAIN so DKIM/SPF align under DMARC.
const FROM_DOMAIN = "notify.jitsu.au";
const SENDER_DOMAIN = "notify.jitsu.au";
export const SITE_URL = "https://jitsu.au";
const FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

type AdminClient = SupabaseClient<Database>;

/**
 * Mint a proof-of-click token for an address and return the RAW token, which is
 * never stored and never recoverable afterwards. Only its SHA-256 hash is
 * persisted, exactly as manager API tokens and calendar feed tokens are.
 *
 * `userId` is optional because the highest-value case has no person yet: an
 * interest registration is a lead, and the token has to bind to the address so
 * the proof survives until they sign a waiver and a person record exists.
 */
export async function mintVerificationToken(
  admin: AdminClient,
  opts: { email: string; purpose: VerificationPurpose; userId?: string | null },
): Promise<string> {
  const raw = generateRawToken();
  const email = normalizeEmail(opts.email);
  const { error } = await admin.from("email_verification_tokens").insert({
    user_id: opts.userId ?? null,
    email,
    purpose: opts.purpose,
    token_prefix: tokenPreview(raw),
    token_hash: await hashToken(raw),
    expires_at: verificationExpiry(),
  });
  if (error) throw new Error(error.message);
  return raw;
}

/**
 * Retire every live token for an address.
 *
 * Called when a manager corrects someone's email: links already sitting in the
 * old inbox must go inert at once rather than waiting out their six-month
 * expiry, because whoever reads that mailbox is not the person we now hold.
 */
export async function revokeVerificationTokensForEmail(
  admin: AdminClient,
  email: string,
): Promise<void> {
  const { error } = await admin
    .from("email_verification_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("email", normalizeEmail(email))
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

/**
 * Resolve a raw token to its live row, or null.
 *
 * Separate from `redeemVerificationToken` because the waiver submission needs to
 * ask "was this address proven?" WITHOUT confirming anything yet: at that point
 * the person may not exist, and the answer decides whether they are created
 * confirmed. Returns null for anything expired, revoked, or unknown.
 */
export async function lookupVerificationToken(
  admin: AdminClient,
  rawToken: string,
): Promise<{ id: string; user_id: string | null; email: string } | null> {
  const token_hash = await hashToken(rawToken);
  const { data: row } = await admin
    .from("email_verification_tokens")
    .select("id, user_id, email, expires_at, revoked_at")
    .eq("token_hash", token_hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (!row || !isVerificationTokenLive(row)) return null;
  return { id: row.id, user_id: row.user_id, email: row.email };
}

/** What a redemption did, for the caller to log or act on. Never shown to a visitor. */
export type RedemptionOutcome =
  /** No live token with that hash. Expired, revoked, or never existed. */
  | { result: "no_token" }
  /** Live token, but the address has no person record yet (a lead). Proof held. */
  | { result: "no_person"; email: string }
  /** Live token whose address no longer matches the account's. Deliberately inert. */
  | { result: "stale"; email: string; userId: string }
  /** The address is now confirmed (or already was). */
  | { result: "verified"; email: string; userId: string };

/**
 * Redeem a raw token: confirm the address it proves, if there is an account
 * holding that exact address.
 *
 * Idempotent by design — these links stay usable for months and people click
 * them twice. Never throws for an unusable token: callers redirect the visitor
 * onward either way, because an endpoint that behaved differently for a valid
 * and an invalid token would be a way to probe which addresses are on file.
 */
export async function redeemVerificationToken(
  admin: AdminClient,
  rawToken: string,
): Promise<RedemptionOutcome> {
  const token_hash = await hashToken(rawToken);
  const { data: row } = await admin
    .from("email_verification_tokens")
    .select("id, user_id, email, expires_at, revoked_at")
    .eq("token_hash", token_hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (!row || !isVerificationTokenLive(row)) return { result: "no_token" };

  // Stamp the redemption. Best-effort: a PostgrestBuilder is a lazy thenable,
  // so the .then() is what actually issues the request (and swallows failure).
  admin
    .from("email_verification_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(
      () => {},
      () => {},
    );

  // A lead's token carries no user id; resolve the address to a person if one
  // exists by now. A token minted for a person still re-resolves through its
  // stored user_id, so a later email change is caught by the match check below.
  let userId = row.user_id;
  if (!userId) {
    const { data: resolved } = await admin.rpc("user_id_by_email", { _email: row.email });
    userId = resolved ?? null;
  }
  // No person record yet. Not a failure: the token stays live and the waiver
  // submission will apply this proof at the moment the person is created.
  if (!userId) return { result: "no_person", email: row.email };

  const { data: got, error: getErr } = await admin.auth.admin.getUserById(userId);
  if (getErr || !got.user) return { result: "no_person", email: row.email };

  // The guard the whole design rests on: a link proves the address it was mailed
  // to, and nothing else. If the account moved on, this token is inert.
  if (!tokenProvesEmail(row.email, got.user.email)) {
    return { result: "stale", email: row.email, userId };
  }

  const { error: confirmErr } = await admin.auth.admin.updateUserById(userId, {
    email_confirm: true,
  });
  if (confirmErr) throw new Error(confirmErr.message);
  return { result: "verified", email: row.email, userId };
}

/**
 * Mint a token and email the "confirm your email address" link to an address.
 *
 * Best-effort by contract: a missing API key or a failed send is logged and
 * swallowed, so a waiver submission or a manager's email correction never fails
 * because the mail provider was down. Returns whether anything went out.
 */
export async function sendVerificationEmail(opts: {
  admin: AdminClient;
  to: string;
  greetingName?: string | null;
  purpose: VerificationPurpose;
  userId?: string | null;
  /** Where the link lands after confirming. Allowlisted downstream. */
  next?: string;
}): Promise<{ sent: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[email-verification] LOVABLE_API_KEY not set — skipping verification email");
    return { sent: false };
  }

  try {
    const token = await mintVerificationToken(opts.admin, {
      email: opts.to,
      purpose: opts.purpose,
      userId: opts.userId ?? null,
    });
    const el = React.createElement(VerifyEmail, {
      siteName: SITE_NAME,
      siteUrl: SITE_URL,
      memberName: opts.greetingName || "",
      verifyUrl: buildVerifyUrl({ siteUrl: SITE_URL, token, next: opts.next }),
    });
    const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);

    await sendLovableEmail(
      {
        to: opts.to,
        from: FROM,
        sender_domain: SENDER_DOMAIN,
        subject: "Confirm your email address",
        html,
        text,
        purpose: "transactional",
        // Distinct per send: a resend must not be swallowed as a duplicate of
        // the one the member says never arrived.
        idempotency_key: `verify-${await hashToken(token)}`,
      },
      { apiKey, sendUrl: process.env.LOVABLE_SEND_URL },
    );
    return { sent: true };
  } catch (e) {
    console.error(`[email-verification] failed to send verification to ${opts.to}:`, e);
    return { sent: false };
  }
}
