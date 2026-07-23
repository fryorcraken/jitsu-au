// Server-only helper for the transactional emails sent when someone registers
// their interest (the "Start your free trial" step 1 form).
//
// Like `waiver-email.server.ts`, this pulls in server-only dependencies (the
// Lovable send API, the React-email renderer) so it must never reach the client
// bundle. It is named `*.server.ts` and is only ever lazy-imported from inside
// the `submitInterest` server-function handler.
import * as React from "react";
import { render } from "@react-email/render";
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { InterestConfirmationEmail } from "@/lib/email-templates/interest-confirmation";
import { InterestNotificationEmail } from "@/lib/email-templates/interest-notification";
import { getManagerEmails } from "@/lib/waiver-email.server";

// Sender configuration mirrors the auth-email webhook and the waiver emails.
const SITE_NAME = "UTS Jitsu";
// Must match SENDER_DOMAIN so DKIM/SPF align under DMARC.
const FROM_DOMAIN = "notify.jitsu.au";
const SENDER_DOMAIN = "notify.jitsu.au";
const SITE_URL = "https://jitsu.au";
const FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

/** Manager dashboard where the lead/member funnel is reviewed. */
export const MANAGER_DASHBOARD_URL = `${SITE_URL}/manager/users`;

type AdminClient = SupabaseClient<Database>;

/**
 * Build the prefilled waiver link carried over from the interest form, so the
 * applicant can sign without re-typing their details. Mirrors the in-app
 * `<Link to="/waiver" search={{ name, email, phone }} />` on the success screen.
 */
export function buildWaiverUrl(params: {
  name: string;
  email: string;
  phone?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.name) search.set("name", params.name);
  if (params.email) search.set("email", params.email);
  if (params.phone) search.set("phone", params.phone);
  const qs = search.toString();
  return qs ? `${SITE_URL}/waiver?${qs}` : `${SITE_URL}/waiver`;
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

export interface InterestEmailParams {
  /** Stable id (the inserted registration row) used to key idempotent sends. */
  registrationId: string;
  name: string;
  email: string;
  phone?: string | null;
  experience?: string | null;
  message?: string | null;
  /** Service-role client, used to resolve manager recipients. */
  admin: AdminClient;
}

/**
 * Email the applicant a confirmation (nudging them to sign their waiver next)
 * and notify every manager of the new lead. Best-effort: a missing API key or a
 * failed send is logged and swallowed so it never fails the registration.
 * Returns a small summary useful for logging/tests.
 */
export async function sendInterestEmails({
  registrationId,
  name,
  email,
  phone,
  experience,
  message,
  admin,
}: InterestEmailParams): Promise<{ sent: string[]; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[interest-email] LOVABLE_API_KEY not set — skipping interest emails");
    return { sent: [], skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;

  const waiverUrl = buildWaiverUrl({ name, email, phone });

  const applicantEl = React.createElement(InterestConfirmationEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    name,
    waiverUrl,
  });
  const [applicantHtml, notifyRecipients] = await Promise.all([
    render(applicantEl),
    getManagerEmails(admin),
  ]);
  const applicantText = await render(applicantEl, { plainText: true });

  const managerEl = React.createElement(InterestNotificationEmail, {
    siteName: SITE_NAME,
    name,
    email,
    phone,
    experience,
    message,
    dashboardUrl: MANAGER_DASHBOARD_URL,
  });
  const managerHtml = await render(managerEl);
  const managerText = await render(managerEl, { plainText: true });

  const sent: string[] = [];

  // Confirmation to the applicant.
  try {
    await sendOne({
      apiKey,
      sendUrl,
      to: email,
      subject: `You're on the list at ${SITE_NAME}. Sign your waiver next`,
      html: applicantHtml,
      text: applicantText,
      idempotencyKey: `interest-applicant-${registrationId}`,
    });
    sent.push(email);
  } catch (e) {
    console.error(`[interest-email] failed to email applicant ${email}:`, e);
  }

  // New-lead notification to each manager.
  for (const to of notifyRecipients) {
    try {
      await sendOne({
        apiKey,
        sendUrl,
        to,
        subject: `New free-trial lead: ${name || email}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `interest-manager-${registrationId}-${to}`,
      });
      sent.push(to);
    } catch (e) {
      console.error(`[interest-email] failed to email manager ${to}:`, e);
    }
  }

  return { sent, skipped: false };
}
