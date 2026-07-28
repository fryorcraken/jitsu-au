// Server-only helpers for the transactional emails in the membership flow.
//
// Pulls in server-only dependencies (the Lovable send API, the React-email
// renderer) so it must never reach the client bundle — it is named `*.server.ts`
// and only ever lazy-imported from inside server-function handlers.
//
// The club's receiving bank details live here (server-side only) because they
// are only needed to render the payment-instructions email — they are never
// returned to the browser.
import * as React from "react";
import { render } from "@react-email/render";
import { sendLovableEmail } from "@lovable.dev/email-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { MembershipClient } from "@/lib/membership-types";
import { MembershipPaymentEmail } from "@/lib/email-templates/membership-payment";
import { MembershipActivatedEmail } from "@/lib/email-templates/membership-activated";
import { MembershipNotificationEmail } from "@/lib/email-templates/membership-notification";
import { getManagerEmails } from "@/lib/waiver-email.server";
import { DEFAULT_INVOICE_INSTRUCTIONS } from "@/lib/validation";

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

/**
 * The manager-set markdown payment instructions shown on invoices. Read from
 * the `club_settings` store; falls back to a default until a manager customizes
 * it. Never throws — a lookup hiccup falls back to the default so it can't block
 * the invoice email.
 */
export async function getInvoiceInstructions(admin: AdminClient): Promise<string> {
  try {
    // `club_settings` isn't in the generated Database types yet; the memberships
    // client type knows it (see membership-types.ts).
    const client = admin as unknown as MembershipClient;
    const { data } = await client
      .from("club_settings")
      .select("value")
      .eq("key", "invoice_payment_instructions")
      .maybeSingle();
    const value = (data as { value?: string } | null)?.value?.trim();
    return value || DEFAULT_INVOICE_INSTRUCTIONS;
  } catch {
    return DEFAULT_INVOICE_INSTRUCTIONS;
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

export interface MembershipPaymentEmailParams {
  membershipId: string;
  /** The member's legal full name — how managers identify them. */
  memberName: string;
  /** What to call the member to their face: preferred name, else first name. */
  memberGreetingName: string;
  memberEmail: string;
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
  const instructions = await getInvoiceInstructions(admin);

  const memberEl = React.createElement(MembershipPaymentEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    // The member-facing greeting: call them what they asked to be called.
    memberName: memberGreetingName,
    planName,
    amount,
    reference,
    instructions,
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
      subject: `Pay ${amount} to activate your ${planName}`,
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

export interface MembershipActivatedEmailParams {
  membershipId: string;
  /** What to call the member to their face: preferred name, else first name.
   * This email has no manager copy, so the legal name is never needed. */
  memberGreetingName: string;
  memberEmail: string;
  planName: string;
  /** Human-readable validity/credit summary. */
  validity: string;
}

/** Confirm to the member that their membership is active. Best-effort. */
export async function sendMembershipActivatedEmail({
  membershipId,
  memberGreetingName,
  memberEmail,
  planName,
  validity,
}: MembershipActivatedEmailParams): Promise<{ sent: boolean; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[membership-email] LOVABLE_API_KEY not set — skipping activation email");
    return { sent: false, skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;

  const el = React.createElement(MembershipActivatedEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    memberName: memberGreetingName,
    planName,
    validity,
    accountUrl: ACCOUNT_URL,
  });
  try {
    const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
    await sendOne({
      apiKey,
      sendUrl,
      to: memberEmail,
      subject: `Your ${planName} is active`,
      html,
      text,
      idempotencyKey: `membership-active-${membershipId}`,
    });
    return { sent: true, skipped: false };
  } catch (e) {
    console.error(`[membership-email] failed to email member ${memberEmail}:`, e);
    return { sent: false, skipped: false };
  }
}
