// Server-only helper for the transactional emails sent when someone registers
// their interest (the "Start your free trial" step 1 form).
//
// Like `waiver-email.server.ts`, this pulls in server-only dependencies (the
// Lovable send API, the React-email renderer) so it must never reach the client
// bundle. It is named `*.server.ts` and is only ever lazy-imported from inside
// the `submitInterest` server-function handler.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { clubReplyTo, sendEmail } from "@/lib/send-email.server";
import { InterestConfirmationEmail } from "@/lib/email-templates/interest-confirmation";
import { InterestNotificationEmail } from "@/lib/email-templates/interest-notification";
import { getManagerEmails } from "@/lib/manager-recipients.server";
import { mayNotifyManagers } from "@/lib/manager-notice-cap.server";
import { claimVisitorEmail, releaseVisitorEmail } from "@/lib/rate-limit.server";
import { SITE_ORIGIN } from "@/lib/site-origin";
import { SITE_NAME } from "@/lib/email-sender";

/** Manager dashboard where the lead/member funnel is reviewed. */
export const MANAGER_DASHBOARD_URL = `${SITE_ORIGIN}/manager/users`;

type AdminClient = SupabaseClient<Database>;

/**
 * Build the prefilled waiver link carried over from the interest form, so the
 * applicant can sign without re-typing their details. Mirrors the in-app
 * `<Link to="/waiver" search={{ name, email, phone }} />` on the success screen.
 *
 * `token` is what makes the EMAILED version of this link different from the
 * in-app one. The name/email/phone params prove nothing (the success screen
 * builds the same URL), but a token that only ever existed in that inbox does:
 * clicking it verifies the address, and carrying it through to submission means
 * the person record is created already verified. Omitted for the in-app link.
 */
export function buildWaiverUrl(params: {
  name: string;
  email: string;
  phone?: string | null;
  token?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.name) search.set("name", params.name);
  if (params.email) search.set("email", params.email);
  if (params.phone) search.set("phone", params.phone);
  if (params.token) search.set("vt", params.token);
  const qs = search.toString();
  return qs ? `${SITE_ORIGIN}/waiver?${qs}` : `${SITE_ORIGIN}/waiver`;
}

export interface InterestEmailParams {
  /** Unique per-submission id used to key idempotent sends. */
  registrationId: string;
  name: string;
  email: string;
  phone?: string | null;
  message?: string | null;
  /** Service-role client, used to resolve manager recipients. */
  admin: AdminClient;
}

/**
 * Email the applicant a confirmation (nudging them to sign their waiver next)
 * and notify every manager of the new lead. Best-effort: a missing API key or a
 * failed send is logged and swallowed so it never fails the registration.
 *
 * Both halves are capped (#52, `src/lib/rate-limit.ts`): the applicant's copy
 * by how often the club may email that address, and in total, today; the
 * managers' by how many new-lead emails have gone out today. A capped email is
 * simply not sent. `applicantEmailed` says whether the applicant's went, so the
 * page never promises an email that is not coming.
 */
export async function sendInterestEmails({
  registrationId,
  name,
  email,
  phone,
  message,
  admin,
}: InterestEmailParams): Promise<{ sent: string[]; skipped: boolean; applicantEmailed: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[interest-email] LOVABLE_API_KEY not set — skipping interest emails");
    return { sent: [], skipped: true, applicantEmailed: false };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;
  const applicantKey = `interest-applicant-${registrationId}`;
  const [mayEmailApplicant, notifyRecipients] = await Promise.all([
    claimVisitorEmail(admin, email, applicantKey),
    getManagerEmails(admin),
  ]);
  // The managers' cap is independent of the applicant's, so it is asked now
  // and only awaited once the applicant's email is dealt with: the visitor is
  // waiting on this whole function before their screen moves on.
  const notifyManagersP = mayNotifyManagers(admin, {
    kind: "lead",
    submissionKey: registrationId,
    recipients: notifyRecipients,
    screenUrl: MANAGER_DASHBOARD_URL,
    apiKey,
    sendUrl,
  });

  const sent: string[] = [];
  let applicantEmailed = false;

  // Confirmation to the applicant, unless a cap held it back, in which case
  // there is nothing to mint or render either.
  if (mayEmailApplicant) {
    // Mint the proof-of-click token that rides on the applicant's waiver link.
    // Best-effort: if minting fails they still get a working (unverified)
    // prefill link, which is exactly the behaviour before verification existed.
    let verificationToken: string | null = null;
    try {
      const { mintVerificationToken } = await import("@/lib/email-verification.server");
      verificationToken = await mintVerificationToken(admin, { email, purpose: "interest" });
    } catch (e) {
      console.error("[interest-email] could not mint a verification token:", e);
    }

    const applicantEl = React.createElement(InterestConfirmationEmail, {
      siteName: SITE_NAME,
      siteUrl: SITE_ORIGIN,
      name,
      waiverUrl: buildWaiverUrl({ name, email, phone, token: verificationToken }),
    });
    try {
      await sendEmail({
        apiKey,
        sendUrl,
        to: email,
        subject: `You're on the list at ${SITE_NAME}. Sign your waiver next`,
        html: await render(applicantEl),
        text: await render(applicantEl, { plainText: true }),
        idempotencyKey: applicantKey,
        // Nothing in this email offers a reply, so only the header needs it.
        replyTo: await clubReplyTo(admin),
      });
      sent.push(email);
      applicantEmailed = true;
    } catch (e) {
      console.error(`[interest-email] failed to email the applicant:`, e);
      // It did not go, so it must not count against that address's day.
      await releaseVisitorEmail(admin, applicantKey);
    }
  }

  const managerEl = React.createElement(InterestNotificationEmail, {
    siteName: SITE_NAME,
    name,
    email,
    phone,
    message,
    dashboardUrl: MANAGER_DASHBOARD_URL,
  });
  const managerHtml = await render(managerEl);
  const managerText = await render(managerEl, { plainText: true });
  const notifyManagers = await notifyManagersP;

  // New-lead notification to each manager, replying to the lead (the same
  // Reply-To rule as the contact form; interestSchema validated the address).
  for (const to of notifyManagers ? notifyRecipients : []) {
    try {
      await sendEmail({
        apiKey,
        sendUrl,
        to,
        subject: `New free-trial lead: ${name || email}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `interest-manager-${registrationId}-${to}`,
        replyTo: email,
      });
      sent.push(to);
    } catch (e) {
      console.error(`[interest-email] failed to email a manager:`, e);
    }
  }

  return { sent, skipped: false, applicantEmailed };
}
