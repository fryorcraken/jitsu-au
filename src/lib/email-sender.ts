// Who every email the app sends comes from. Plain constants with no imports, so
// the auth-email webhook route can share them as safely as the server-only
// senders in `send-email.server.ts`: two copies of a sender address is how one
// of them ends up on a domain DMARC no longer aligns with.

// The From domain must match the sender domain so DKIM/SPF align under DMARC
// (Gmail flags misaligned From-domains as spam).
export const SENDER_DOMAIN = "notify.jitsu.au";
/** The name every email is signed with, and that subjects and greetings use. */
export const SITE_NAME = "UTS Jitsu";

export const FROM = `${SITE_NAME} <noreply@${SENDER_DOMAIN}>`;
