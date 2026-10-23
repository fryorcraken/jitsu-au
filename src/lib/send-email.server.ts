// Server-only: the one place the app hands a transactional email to Lovable's
// send API, and the one place the sender is spelled.
//
// Every `*-email.server.ts` module used to carry its own copy of this function
// and of the From address. Keeping them in step by hand is how one copy grows
// an option the others lack, so they all send through here. The auth-email
// webhook is the exception: Lovable's `createAuthEmailHandler` sends on its own,
// and only takes the From address as configuration.
//
// Everything goes out from `noreply@`, so a reply goes nowhere unless the send
// says otherwise. The rule: a manager's copy of an email ABOUT a person (a
// contact message, a new lead, a signed waiver, a membership awaiting payment)
// sets `replyTo` to that person's address, because pressing reply is how a
// manager answers them. An email TO a person sets none.
//
// Like the modules that call it, this must never reach the client bundle: it is
// named `*.server.ts` and is only ever imported by other `*.server.ts` modules.
import { sendLovableEmail } from "@lovable.dev/email-js";

// The From domain must match the sender domain so DKIM/SPF align under DMARC
// (Gmail flags misaligned From-domains as spam).
const SENDER_DOMAIN = "notify.jitsu.au";
const FROM = `UTS Jitsu <noreply@${SENDER_DOMAIN}>`;

export async function sendEmail(opts: {
  apiKey: string;
  sendUrl?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  /**
   * Where a reply goes instead of the noreply sender. A bare address only,
   * already validated by the caller: it ends up in a mail header.
   */
  replyTo?: string;
}) {
  await sendLovableEmail(
    {
      to: opts.to,
      from: FROM,
      sender_domain: SENDER_DOMAIN,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      purpose: "transactional",
      idempotency_key: opts.idempotencyKey,
      reply_to: opts.replyTo,
    },
    { apiKey: opts.apiKey, sendUrl: opts.sendUrl },
  );
}
