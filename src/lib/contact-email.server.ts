// Server-only helper for the transactional emails sent when someone uses the
// contact form.
//
// Like `interest-email.server.ts`, this pulls in server-only dependencies (the
// Lovable send API, the React-email renderer) so it must never reach the client
// bundle. It is named `*.server.ts` and is only ever lazy-imported from inside
// the `submitContact` server-function handler.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { clubReplyTo, sendEmail } from "@/lib/send-email.server";
import { ContactConfirmationEmail } from "@/lib/email-templates/contact-confirmation";
import { ContactNotificationEmail } from "@/lib/email-templates/contact-notification";
import { getManagerEmails } from "@/lib/manager-recipients.server";
import { VENUE_PHONE_DISPLAY, VENUE_PHONE_TEL, WHATSAPP_URL } from "@/lib/venue";
import { SITE_ORIGIN } from "@/lib/seo";
import { SITE_NAME } from "@/lib/email-sender";

/** Manager screen listing every message the contact form has received. */
export const MANAGER_CONTACT_URL = `${SITE_ORIGIN}/manager/contact-messages`;

type AdminClient = SupabaseClient<Database>;

export interface ContactEmailParams {
  /** Unique per-submission id used to key idempotent sends. */
  messageId: string;
  name: string;
  email: string;
  subject?: string | null;
  message: string;
  /** Service-role client, used to resolve manager recipients. */
  admin: AdminClient;
}

/**
 * Acknowledge the sender and notify every manager. Best-effort: a missing API
 * key or a failed send is logged and swallowed so it never fails the message the
 * visitor just sent — the row is already committed by the time this runs, and a
 * message stored without an email beats an error screen over a stored message.
 * Returns a small summary useful for logging/tests.
 */
export async function sendContactEmails({
  messageId,
  name,
  email,
  subject,
  message,
  admin,
}: ContactEmailParams): Promise<{ sent: string[]; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[contact-email] LOVABLE_API_KEY not set — skipping contact emails");
    return { sent: [], skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;

  // Resolved once, before rendering, so the footer's promise and the header
  // agree (see `clubReplyTo`).
  const replyTo = await clubReplyTo(admin);
  const senderEl = React.createElement(ContactConfirmationEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_ORIGIN,
    name,
    subject,
    message,
    phoneDisplay: VENUE_PHONE_DISPLAY,
    phoneTel: VENUE_PHONE_TEL,
    whatsappUrl: WHATSAPP_URL,
    replyTo,
  });
  const [senderHtml, notifyRecipients] = await Promise.all([
    render(senderEl),
    getManagerEmails(admin),
  ]);
  const senderText = await render(senderEl, { plainText: true });

  const managerEl = React.createElement(ContactNotificationEmail, {
    siteName: SITE_NAME,
    name,
    email,
    subject,
    message,
    inboxUrl: MANAGER_CONTACT_URL,
  });
  const managerHtml = await render(managerEl);
  const managerText = await render(managerEl, { plainText: true });

  const sent: string[] = [];

  // Acknowledgement to whoever wrote in.
  try {
    await sendEmail({
      apiKey,
      sendUrl,
      to: email,
      // Fixed wording. This is the one email the site sends to an address
      // nobody has verified, so the subject line stays out of the sender's
      // hands: `name` is whatever they typed into a public form.
      subject: `We got your message at ${SITE_NAME}`,
      html: senderHtml,
      text: senderText,
      idempotencyKey: `contact-sender-${messageId}`,
      replyTo,
    });
    sent.push(email);
  } catch (e) {
    console.error(`[contact-email] failed to email the sender:`, e);
  }

  // The message itself, to each manager. Reply-To is the visitor, so a
  // manager's own "Reply" button answers them rather than the noreply sender.
  // The bare address only: `name` is free text from a public form and has no
  // business in a header. contactSchema has already rejected anything that is
  // not a single well-formed address.
  for (const to of notifyRecipients) {
    try {
      await sendEmail({
        apiKey,
        sendUrl,
        to,
        subject: subject
          ? `Contact form: ${subject}`
          : `Contact form: new message from ${name || email}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `contact-manager-${messageId}-${to}`,
        replyTo: email,
      });
      sent.push(to);
    } catch (e) {
      console.error(`[contact-email] failed to email a manager:`, e);
    }
  }

  return { sent, skipped: false };
}
