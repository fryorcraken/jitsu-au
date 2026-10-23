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
import { ContactConfirmationEmail } from "@/lib/email-templates/contact-confirmation";
import { ContactNotificationEmail } from "@/lib/email-templates/contact-notification";
import {
  SITE_NAME,
  SITE_URL,
  emailConfigured,
  getManagerEmails,
  sendClubEmail,
} from "@/lib/email-send.server";
import { VENUE_PHONE_DISPLAY, VENUE_PHONE_TEL, WHATSAPP_URL } from "@/lib/venue";

/** Manager screen listing every message the contact form has received. */
export const MANAGER_CONTACT_URL = `${SITE_URL}/manager/contact-messages`;

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
  if (!emailConfigured()) {
    console.warn("[contact-email] LOVABLE_API_KEY not set — skipping contact emails");
    return { sent: [], skipped: true };
  }

  const senderEl = React.createElement(ContactConfirmationEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    name,
    subject,
    message,
    phoneDisplay: VENUE_PHONE_DISPLAY,
    phoneTel: VENUE_PHONE_TEL,
    whatsappUrl: WHATSAPP_URL,
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
    await sendClubEmail({
      to: email,
      // Fixed wording. This is the one email the site sends to an address
      // nobody has verified, so the subject line stays out of the sender's
      // hands: `name` is whatever they typed into a public form.
      subject: `We got your message at ${SITE_NAME}`,
      html: senderHtml,
      text: senderText,
      idempotencyKey: `contact-sender-${messageId}`,
    });
    sent.push(email);
  } catch (e) {
    console.error(`[contact-email] failed to email the sender:`, e);
  }

  // The message itself, to each manager.
  for (const to of notifyRecipients) {
    try {
      await sendClubEmail({
        to,
        subject: subject
          ? `Contact form: ${subject}`
          : `Contact form: new message from ${name || email}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `contact-manager-${messageId}-${to}`,
      });
      sent.push(to);
    } catch (e) {
      console.error(`[contact-email] failed to email a manager:`, e);
    }
  }

  return { sent, skipped: false };
}
