// Server-only helper for the transactional emails sent when a waiver is signed.
//
// This module pulls in server-only dependencies (the Lovable send API, the
// React-email renderer, the service-role admin client's types) so it must never
// reach the client bundle. It is named `*.server.ts` and is only ever
// lazy-imported from inside server-function handlers.
import * as React from "react";
import { render } from "@react-email/render";
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { WaiverConfirmationEmail } from "@/lib/email-templates/waiver-confirmation";
import { WaiverNotificationEmail } from "@/lib/email-templates/waiver-notification";

// Mirror the sender configuration used by the auth-email webhook.
const SITE_NAME = "UTS Jitsu";
// Must match SENDER_DOMAIN so DKIM/SPF align under DMARC (Gmail flags
// misaligned From-domains as spam).
const FROM_DOMAIN = "notify.jitsu.au";
const SENDER_DOMAIN = "notify.jitsu.au";
const SITE_URL = "https://jitsu.au";
const FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

/** Manager dashboard where waivers are reviewed and approved. */
export const WAIVER_REVIEW_URL = `${SITE_URL}/manager/waivers`;

type AdminClient = SupabaseClient<Database>;

/**
 * Resolve the email addresses of every manager (users holding the `manager`
 * role). Uses the service-role client to read `user_roles` and look up each
 * user's email via the auth admin API. Never throws — returns whatever it could
 * resolve so a lookup hiccup can't block the confirmation email to the member.
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

async function sendOne(opts: {
  apiKey: string;
  sendUrl?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
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
    },
    { apiKey: opts.apiKey, sendUrl: opts.sendUrl },
  );
}

export interface WaiverEmailParams {
  waiverId: string;
  /** The signer's legal full name — how managers identify them. */
  memberName: string;
  /** What to call the signer to their face: preferred name, else first name. */
  memberGreetingName: string;
  memberEmail: string;
  /** Short-lived signed URL to the generated waiver PDF. */
  pdfUrl: string;
  /** Service-role client, used to resolve manager recipients. */
  admin: AdminClient;
}

/**
 * Notify both the member (a confirmation) and every manager (a review prompt)
 * that a new waiver was signed. Best-effort: a missing API key or a failed send
 * is logged and swallowed so it never fails the waiver submission itself.
 * Returns a small summary useful for logging/tests.
 */
export async function sendWaiverEmails({
  waiverId,
  memberName,
  memberGreetingName,
  memberEmail,
  pdfUrl,
  admin,
}: WaiverEmailParams): Promise<{ sent: string[]; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[waiver-email] LOVABLE_API_KEY not set — skipping waiver emails");
    return { sent: [], skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;

  const [memberHtml, notifyRecipients] = await Promise.all([
    render(
      React.createElement(WaiverConfirmationEmail, {
        siteName: SITE_NAME,
        siteUrl: SITE_URL,
        // The member-facing greeting: call them what they asked to be called.
        memberName: memberGreetingName,
        pdfUrl,
      }),
    ),
    getManagerEmails(admin),
  ]);
  const memberText = await render(
    React.createElement(WaiverConfirmationEmail, {
      siteName: SITE_NAME,
      siteUrl: SITE_URL,
      memberName: memberGreetingName,
      pdfUrl,
    }),
    { plainText: true },
  );

  const managerEl = React.createElement(WaiverNotificationEmail, {
    siteName: SITE_NAME,
    memberName,
    memberEmail,
    pdfUrl,
    reviewUrl: WAIVER_REVIEW_URL,
  });
  const managerHtml = await render(managerEl);
  const managerText = await render(managerEl, { plainText: true });

  const sent: string[] = [];

  // Confirmation to the member.
  try {
    await sendOne({
      apiKey,
      sendUrl,
      to: memberEmail,
      subject: `Your ${SITE_NAME} training waiver`,
      html: memberHtml,
      text: memberText,
      idempotencyKey: `waiver-member-${waiverId}`,
    });
    sent.push(memberEmail);
  } catch (e) {
    console.error(`[waiver-email] failed to email member ${memberEmail}:`, e);
  }

  // Review prompt to each manager.
  for (const to of notifyRecipients) {
    try {
      await sendOne({
        apiKey,
        sendUrl,
        to,
        subject: `New waiver signed by ${memberName || memberEmail}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `waiver-manager-${waiverId}-${to}`,
      });
      sent.push(to);
    } catch (e) {
      console.error(`[waiver-email] failed to email manager ${to}:`, e);
    }
  }

  return { sent, skipped: false };
}
