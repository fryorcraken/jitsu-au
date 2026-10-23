// Server-only: the one place the app hands a transactional email to Lovable's
// send API.
//
// Every `*-email.server.ts` module used to carry its own copy of this function
// and of the From address. Keeping them in step by hand is how one copy grows
// an option the others lack, so they all send through here. The auth-email
// webhook is the exception: Lovable's `createAuthEmailHandler` sends on its own,
// and takes the same sender from `email-sender.ts`.
//
// Everything goes out from `noreply@`, so a reply goes nowhere unless the send
// says otherwise. The rule: a manager's copy of an email ABOUT a person (a
// contact message, a new lead, a signed waiver, a membership awaiting payment)
// sets `replyTo` to that person's address, because pressing reply is how a
// manager answers them. Several addresses when the reply should reach more than
// one person (a minor's waiver: their guardian and the minor), most important
// first, because the first is the only one kept if the service refuses several.
// An email TO a person sets none.
//
// Like the modules that call it, this must never reach the client bundle: it is
// named `*.server.ts` and is only ever imported by other `*.server.ts` modules.
import { sendLovableEmail } from "@lovable.dev/email-js";
import { FROM, SENDER_DOMAIN } from "@/lib/email-sender";

/**
 * Whether the email service read the request and rejected its content, which
 * is how it would answer a Reply-To it cannot take. Only 400 and 422: a 401 or
 * 403 is the API key, a 409 can mean this idempotency key is already in flight
 * (resending under a new key would then deliver twice), and a 429 or 5xx is
 * not about the request at all. Duck-typed on `EmailAPIError.status` so tests
 * that mock the SDK module need not re-export its error class.
 */
function rejectedAsInvalid(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 400 || status === 422;
}

export async function sendEmail(opts: {
  apiKey: string;
  sendUrl?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  /**
   * Where a reply goes instead of the noreply sender: one address, or several
   * when a reply should reach more than one person. Bare addresses only,
   * already validated by the caller: they end up in a mail header. The first
   * is the one kept if the service will not take several (below).
   */
  replyTo?: string | string[];
}) {
  const replyTo = typeof opts.replyTo === "string" ? [opts.replyTo] : (opts.replyTo ?? []);
  const send = (reply: string[], idempotencyKey: string) =>
    sendLovableEmail(
      {
        to: opts.to,
        from: FROM,
        sender_domain: SENDER_DOMAIN,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        purpose: "transactional",
        idempotency_key: idempotencyKey,
        reply_to: reply.length ? reply.join(", ") : undefined,
      },
      { apiKey: opts.apiKey, sendUrl: opts.sendUrl },
    );

  try {
    await send(replyTo, opts.idempotencyKey);
  } catch (e) {
    // A Reply-To listing several addresses is ordinary email, but nothing
    // documents whether Lovable's send API accepts one. If it refuses, every
    // caller swallows the error, so the email would simply never arrive: a
    // manager would not hear about a waiver at all. Losing the later addresses
    // is far cheaper, so send once more with only the first (callers list the
    // one that matters most first). Only when the request was rejected as
    // invalid: after a timeout the first attempt may have gone out, and the
    // retry's new idempotency key would deliver it twice.
    if (replyTo.length < 2 || !rejectedAsInvalid(e)) throw e;
    console.warn("[send-email] rejected with several Reply-To addresses; retrying with one", e);
    try {
      await send(replyTo.slice(0, 1), `${opts.idempotencyKey}-single-reply-to`);
    } catch (retryError) {
      // Rejected again with one address: the Reply-To was not the problem, and
      // the first error is the one that says what was. Anything else (a
      // timeout, a 5xx) is the retry's own failure, so report that.
      console.error("[send-email] retry with one Reply-To also failed", retryError);
      throw rejectedAsInvalid(retryError) ? e : retryError;
    }
  }
}
