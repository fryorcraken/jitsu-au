// Who every email the app sends comes from. Plain constants with no imports, so
// the auth-email webhook route can share them as safely as the server-only
// senders in `send-email.server.ts`: two copies of a sender address is how one
// of them ends up on a domain DMARC no longer aligns with.

// The From domain must match the sender domain so DKIM/SPF align under DMARC
// (Gmail flags misaligned From-domains as spam). It also has to be the domain
// the project's Lovable email setup is configured for (More -> Emails), and that
// domain must be verified before a build carrying it is published, or every
// email (sign-in links included) is refused.
export const SENDER_DOMAIN = "notify.utsjitsu.com.au";
/** The name every email is signed with, and that subjects and greetings use. */
export const SITE_NAME = "UTS Jitsu";

export const FROM = `${SITE_NAME} <noreply@${SENDER_DOMAIN}>`;
