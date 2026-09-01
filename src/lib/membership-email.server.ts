// Server-only helpers for the transactional emails in the membership flow.
//
// Pulls in server-only dependencies (the Lovable send API, the React-email
// renderer) so it must never reach the client bundle — it is named `*.server.ts`
// and only ever lazy-imported from inside server-function handlers.
import * as React from "react";
import { render } from "@react-email/render";
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MembershipPaymentEmail } from "@/lib/email-templates/membership-payment";
import { MembershipPaidEmail } from "@/lib/email-templates/membership-paid";
import { MembershipNotificationEmail } from "@/lib/email-templates/membership-notification";
import { getManagerEmails } from "@/lib/waiver-email.server";
import { readClubPaymentDetails } from "@/lib/club-settings.server";

const SITE_NAME = "UTS Jitsu";
// Must match SENDER_DOMAIN so DKIM/SPF align under DMARC.
const FROM_DOMAIN = "notify.jitsu.au";
const SENDER_DOMAIN = "notify.jitsu.au";
const SITE_URL = "https://jitsu.au";
const FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

/** Manager dashboard where memberships are reviewed and payments reconciled. */
export const MEMBERSHIP_REVIEW_URL = `${SITE_URL}/manager/memberships`;
const ACCOUNT_URL = `${SITE_URL}/membership`;

type AdminClient = SupabaseClient<Database>;

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

export interface MembershipPaymentEmailParams {
  membershipId: string;
  /** The member's legal full name — how managers identify them. */
  memberName: string;
  /** What to call the member to their face: preferred name, else first name. */
  memberGreetingName: string;
  memberEmail: string;
  /**
   * The person the membership is FOR, when that is not the person being
   * written to. A dependant has no mailbox, so everything about them reaches
   * their guardian; the greeting is the guardian's and this names the child.
   * Null for the ordinary case, where the two are the same person.
   */
  forName?: string | null;
  planName: string;
  /** Human-readable amount, e.g. "$245". */
  amount: string;
  reference: string;
  admin: AdminClient;
}

/**
 * Email the member their bank-transfer instructions (amount + unique reference)
 * and notify managers that a new membership is awaiting payment. Best-effort: a
 * missing API key or a failed send is logged and swallowed so it never fails the
 * enrollment, which is already durably saved.
 */
export async function sendMembershipPaymentEmail({
  membershipId,
  memberName,
  memberGreetingName,
  memberEmail,
  forName,
  planName,
  amount,
  reference,
  admin,
}: MembershipPaymentEmailParams): Promise<{ sent: string[]; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[membership-email] LOVABLE_API_KEY not set — skipping payment email");
    return { sent: [], skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;
  // Null covers both "never published" and "could not read": either way the
  // email cannot name an account, and it says so rather than inventing one.
  const { details } = await readClubPaymentDetails(admin);

  const memberEl = React.createElement(MembershipPaymentEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    // The member-facing greeting: call them what they asked to be called.
    memberName: memberGreetingName,
    forName,
    planName,
    amount,
    reference,
    details,
    membershipUrl: ACCOUNT_URL,
  });
  const [memberHtml, memberText, managers] = await Promise.all([
    render(memberEl),
    render(memberEl, { plainText: true }),
    getManagerEmails(admin),
  ]);

  const managerEl = React.createElement(MembershipNotificationEmail, {
    siteName: SITE_NAME,
    memberName,
    memberEmail,
    // Same address, same caption as the screens: `memberEmail` is the contact
    // person's, and for a dependant that is not the person named beside it.
    emailBelongsTo: forName ? memberGreetingName : null,
    planName,
    amount,
    reference,
    reviewUrl: MEMBERSHIP_REVIEW_URL,
  });
  const [managerHtml, managerText] = await Promise.all([
    render(managerEl),
    render(managerEl, { plainText: true }),
  ]);

  const sent: string[] = [];
  try {
    await sendOne({
      apiKey,
      sendUrl,
      to: memberEmail,
      // The plan named as the READER's or as the child's, because a parent
      // with three children gets three of these and an inbox full of "your
      // membership" tells them nothing about which one to pay.
      subject: forName
        ? `Pay ${amount} to activate ${forName}'s ${planName}`
        : `Pay ${amount} to activate your ${planName}`,
      html: memberHtml,
      text: memberText,
      idempotencyKey: `membership-payment-${membershipId}`,
    });
    sent.push(memberEmail);
  } catch (e) {
    console.error(`[membership-email] failed to email member ${memberEmail}:`, e);
  }

  for (const to of managers) {
    try {
      await sendOne({
        apiKey,
        sendUrl,
        to,
        subject: `New membership pending payment: ${memberName || memberEmail}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `membership-pending-${membershipId}-${to}`,
      });
      sent.push(to);
    } catch (e) {
      console.error(`[membership-email] failed to email manager ${to}:`, e);
    }
  }

  return { sent, skipped: false };
}

export interface MembershipPaidEmailParams {
  membershipId: string;
  /** What to call the member to their face: preferred name, else first name.
   * This email has no manager copy, so the legal name is never needed. */
  memberGreetingName: string;
  memberEmail: string;
  /**
   * The person the membership is FOR, when that is not the person being
   * written to. A dependant has no mailbox, so everything about them reaches
   * their guardian; the greeting is the guardian's and this names the child.
   * Null for the ordinary case, where the two are the same person.
   */
  forName?: string | null;
  planName: string;
  /** Human-readable validity/credit summary. */
  validity: string;
  /** What they paid, already formatted. */
  amount: string;
}

/**
 * Confirm to the member that their payment landed. Best-effort.
 *
 * The receipt half of the lifecycle. Being authorised to train is settled when
 * the membership is raised and the invoice email says so, so this one is only
 * ever about money arriving — which is also why its idempotency key is keyed to
 * the payment rather than to activation.
 */
export async function sendMembershipPaidEmail({
  membershipId,
  memberGreetingName,
  memberEmail,
  forName,
  planName,
  validity,
  amount,
}: MembershipPaidEmailParams): Promise<{ sent: boolean; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[membership-email] LOVABLE_API_KEY not set — skipping payment email");
    return { sent: false, skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;

  const el = React.createElement(MembershipPaidEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    memberName: memberGreetingName,
    forName,
    planName,
    validity,
    amount,
    accountUrl: ACCOUNT_URL,
  });
  try {
    const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
    await sendOne({
      apiKey,
      sendUrl,
      to: memberEmail,
      subject: forName
        ? `Payment received for ${forName}'s ${planName}`
        : `Payment received for ${planName}`,
      html,
      text,
      idempotencyKey: `membership-paid-${membershipId}`,
    });
    return { sent: true, skipped: false };
  } catch (e) {
    console.error(`[membership-email] failed to email member ${memberEmail}:`, e);
    return { sent: false, skipped: false };
  }
}
