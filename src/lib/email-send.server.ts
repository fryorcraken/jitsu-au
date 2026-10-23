// The one way this app sends an email.
//
// Every email the club sends goes out under one identity and through one call.
// Before this module there were seven copies of the sender configuration and
// seven private `sendOne`s, one per email module, so any change that had to
// touch every email (a reply-to address, a resend) meant making it seven times
// and hoping none was missed. `docs/emails.md` is the inventory of what goes
// through here; `scripts/email-conventions.test.ts` fails if a module calls the Lovable send
// API directly again.
//
// What this module owns, and what it deliberately does not:
//
// - It owns WHO the mail is from and HOW it travels: the sender identity, the
//   API key, the transactional purpose, and the manager recipient list four
//   flows share.
// - It does NOT own what an email says or who it is about. Each email's
//   template, subject, recipient and idempotency key stay in its own module,
//   next to the flow that triggers it. The goal is one transport, not one
//   giant file.
//
// Server-only: it reads `LOVABLE_API_KEY`. Named `*.server.ts` and only ever
// lazy-imported from inside server-function handlers and route handlers.
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** The name every email is signed with and every subject line uses. */
export const SITE_NAME = "UTS Jitsu";

/** The address every link in an email is built on. */
export const SITE_URL = "https://jitsu.au";

/**
 * The domain mail is sent from (Mailgun, via Lovable). The `From` address must
 * sit on this same domain so DKIM and SPF align under DMARC: Gmail files a
 * misaligned From-domain as spam. So this never moves to a domain we merely
 * own; it moves only together with the sending setup.
 */
export const SENDER_DOMAIN = "notify.jitsu.au";

/** The `From` header on every email, the auth emails included. */
export const FROM = `${SITE_NAME} <noreply@${SENDER_DOMAIN}>`;

type AdminClient = SupabaseClient<Database>;

/**
 * Whether email can be sent at all in this environment.
 *
 * Every sender checks this before it does any work (reading the database,
 * minting a token, rendering a template), so a deploy without the key skips
 * cleanly rather than half-composing mail it can never send.
 */
export function emailConfigured(): boolean {
  return Boolean(process.env.LOVABLE_API_KEY);
}

export interface ClubEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * The provider discards a second send under the same key, which is what
   * makes every sender safe to call twice. Each email's key pattern is listed
   * in `docs/emails.md`.
   */
  idempotencyKey: string;
}

/**
 * Send one email. Throws on failure.
 *
 * Every email here is best-effort for the flow that triggers it (a waiver is
 * saved whether or not its confirmation goes out), so callers wrap this in
 * their own try/catch and log; the throw is what lets them tell "sent" from
 * "not sent". There is no `purpose` argument because nothing the club sends is
 * anything but transactional: Lovable treats any other purpose as marketing,
 * which needs an unsubscribe the club has no use for.
 */
export async function sendClubEmail(email: ClubEmail): Promise<void> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not set, so no email can be sent.");
  await sendLovableEmail(
    {
      to: email.to,
      from: FROM,
      sender_domain: SENDER_DOMAIN,
      subject: email.subject,
      html: email.html,
      text: email.text,
      purpose: "transactional",
      idempotency_key: email.idempotencyKey,
    },
    { apiKey, sendUrl: process.env.LOVABLE_SEND_URL },
  );
}

/**
 * Resolve the email addresses of every manager (users holding the `manager`
 * role). Uses the service-role client to read `user_roles` and look up each
 * user's email via the auth admin API. Never throws — returns whatever it could
 * resolve so a lookup hiccup can't block the confirmation email to the member.
 *
 * Every manager is emailed at their login address. Shared by the contact,
 * interest, waiver and membership notifications.
 */
export async function getManagerEmails(admin: AdminClient): Promise<string[]> {
  try {
    const { data: roles, error } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "manager");
    if (error || !roles) return [];

    const emails: string[] = [];
    for (const { user_id } of roles as { user_id: string }[]) {
      const { data, error: uErr } = await admin.auth.admin.getUserById(user_id);
      const email = data?.user?.email;
      if (!uErr && email) emails.push(email);
    }
    // De-duplicate in case a user somehow holds the role twice.
    return [...new Set(emails)];
  } catch {
    return [];
  }
}
