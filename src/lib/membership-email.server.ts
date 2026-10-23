// Server-only helpers for the transactional emails that ask for or confirm
// money: membership invoices and receipts, and item invoices and receipts
// (docs/item-invoices.md). They share the club's bank-details block, which is
// why they share a file. The sender and the site URL are every email's, from
// `email-sender.ts` and `seo.ts` (docs/emails.md).
//
// Pulls in server-only dependencies (the Lovable send API, the React-email
// renderer) so it must never reach the client bundle — it is named `*.server.ts`
// and only ever lazy-imported from inside server-function handlers.
import * as React from "react";
import { render } from "@react-email/render";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { clubReplyTo, sendEmail } from "@/lib/send-email.server";
import { MembershipPaymentEmail } from "@/lib/email-templates/membership-payment";
import { MembershipPaidEmail } from "@/lib/email-templates/membership-paid";
import { MembershipNotificationEmail } from "@/lib/email-templates/membership-notification";
import { ItemInvoiceEmail, type ItemInvoiceEmailLine } from "@/lib/email-templates/item-invoice";
import { ItemInvoicePaidEmail } from "@/lib/email-templates/item-invoice-paid";
import { getManagerEmails } from "@/lib/manager-recipients.server";
import { resendIdempotencyKey } from "@/lib/email-resend";
import { readClubPaymentDetails } from "@/lib/club-settings.server";
import { SITE_ORIGIN } from "@/lib/seo";
import { SITE_NAME } from "@/lib/email-sender";

/** Manager dashboard where memberships are reviewed and payments reconciled. */
export const MEMBERSHIP_REVIEW_URL = `${SITE_ORIGIN}/manager/memberships`;
const ACCOUNT_URL = `${SITE_ORIGIN}/membership`;

type AdminClient = SupabaseClient<Database>;

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
  /**
   * Set when a manager resends this email: the member copy goes out under
   * `resendIdempotencyKey(<original key>, resendId)`, so the provider does not
   * swallow it as a duplicate of the first send, and no manager copy goes out.
   */
  resendId?: string | null;
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
  resendId,
}: MembershipPaymentEmailParams): Promise<{ sent: string[]; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[membership-email] LOVABLE_API_KEY not set — skipping payment email");
    return { sent: [], skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;
  // Null covers both "never published" and "could not read": either way the
  // email cannot name an account, and it says so rather than inventing one.
  const [{ details }, replyTo] = await Promise.all([
    readClubPaymentDetails(admin),
    clubReplyTo(admin),
  ]);

  const memberEl = React.createElement(MembershipPaymentEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_ORIGIN,
    // The member-facing greeting: call them what they asked to be called.
    memberName: memberGreetingName,
    forName,
    planName,
    amount,
    reference,
    details,
    membershipUrl: ACCOUNT_URL,
    replyTo,
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
    await sendEmail({
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
      idempotencyKey: resendId
        ? resendIdempotencyKey(`membership-payment-${membershipId}`, resendId)
        : `membership-payment-${membershipId}`,
      replyTo,
    });
    sent.push(memberEmail);
  } catch (e) {
    console.error(`[membership-email] failed to email member ${memberEmail}:`, e);
  }

  // Replying to the manager copy reaches whoever was sent the invoice: the
  // member, or the parent of a child on their account. A resend is the
  // member's copy again: managers were told when it was raised, and the
  // manager pressing Resend already knows.
  for (const to of resendId ? [] : managers) {
    try {
      await sendEmail({
        apiKey,
        sendUrl,
        to,
        subject: `New membership pending payment: ${memberName || memberEmail}`,
        html: managerHtml,
        text: managerText,
        idempotencyKey: `membership-pending-${membershipId}-${to}`,
        replyTo: memberEmail,
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
  /** Service-role client, used to read the club's reply-to address. */
  admin: AdminClient;
  /**
   * Set when a manager resends this email: the member copy goes out under
   * `resendIdempotencyKey(<original key>, resendId)`, so the provider does not
   * swallow it as a duplicate of the first send, and no manager copy goes out.
   */
  resendId?: string | null;
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
  admin,
  resendId,
}: MembershipPaidEmailParams): Promise<{ sent: boolean; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[membership-email] LOVABLE_API_KEY not set — skipping payment email");
    return { sent: false, skipped: true };
  }
  const sendUrl = process.env.LOVABLE_SEND_URL;

  const replyTo = await clubReplyTo(admin);
  const el = React.createElement(MembershipPaidEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_ORIGIN,
    memberName: memberGreetingName,
    forName,
    planName,
    validity,
    amount,
    accountUrl: ACCOUNT_URL,
    replyTo,
  });
  try {
    const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
    await sendEmail({
      apiKey,
      sendUrl,
      to: memberEmail,
      subject: forName
        ? `Payment received for ${forName}'s ${planName}`
        : `Payment received for ${planName}`,
      html,
      text,
      idempotencyKey: resendId
        ? resendIdempotencyKey(`membership-paid-${membershipId}`, resendId)
        : `membership-paid-${membershipId}`,
      replyTo,
    });
    return { sent: true, skipped: false };
  } catch (e) {
    console.error(`[membership-email] failed to email member ${memberEmail}:`, e);
    return { sent: false, skipped: false };
  }
}

export interface ItemInvoiceEmailParams {
  invoiceId: string;
  /** What to call the reader to their face. */
  memberGreetingName: string;
  memberEmail: string;
  /** The person the invoice is FOR, when that is not the reader (a child). */
  forName?: string | null;
  lines: ItemInvoiceEmailLine[];
  /** Human-readable total, e.g. "$110". */
  total: string;
  reference: string;
  admin: AdminClient;
  /**
   * Set when a manager resends this email: the member copy goes out under
   * `resendIdempotencyKey(<original key>, resendId)`, so the provider does not
   * swallow it as a duplicate of the first send, and no manager copy goes out.
   */
  resendId?: string | null;
}

/**
 * Email somebody an invoice for items. Best-effort, like every email here: the
 * invoice is already saved and already on their membership page, so a failed
 * send is logged rather than reported as a failed invoice, which would invite a
 * manager to raise it a second time.
 *
 * No manager copy. The membership invoice tells managers because a MEMBER can
 * raise one; an item invoice is only ever raised by a manager, who already
 * knows.
 */
export async function sendItemInvoiceEmail({
  invoiceId,
  memberGreetingName,
  memberEmail,
  forName,
  lines,
  total,
  reference,
  admin,
  resendId,
}: ItemInvoiceEmailParams): Promise<{ sent: boolean; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[item-invoice-email] LOVABLE_API_KEY not set — skipping invoice email");
    return { sent: false, skipped: true };
  }
  const [{ details }, replyTo] = await Promise.all([
    readClubPaymentDetails(admin),
    clubReplyTo(admin),
  ]);
  const el = React.createElement(ItemInvoiceEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_ORIGIN,
    memberName: memberGreetingName,
    forName,
    lines,
    total,
    reference,
    details,
    membershipUrl: ACCOUNT_URL,
    replyTo,
  });
  try {
    const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
    await sendEmail({
      apiKey,
      sendUrl: process.env.LOVABLE_SEND_URL,
      to: memberEmail,
      // Named for the child when it is theirs, for the same reason as the
      // membership invoice: a parent's inbox holds several of these.
      subject: forName
        ? `Invoice ${reference} for ${forName}: ${total}`
        : `Invoice ${reference}: ${total}`,
      html,
      text,
      idempotencyKey: resendId
        ? resendIdempotencyKey(`item-invoice-${invoiceId}`, resendId)
        : `item-invoice-${invoiceId}`,
      replyTo,
    });
    return { sent: true, skipped: false };
  } catch (e) {
    console.error(`[item-invoice-email] failed to email ${memberEmail}:`, e);
    return { sent: false, skipped: false };
  }
}

export interface ItemInvoicePaidEmailParams {
  invoiceId: string;
  memberGreetingName: string;
  memberEmail: string;
  forName?: string | null;
  reference: string;
  summary: string;
  amount: string;
  /** Service-role client, used to read the club's reply-to address. */
  admin: AdminClient;
  /**
   * Set when a manager resends this email: the member copy goes out under
   * `resendIdempotencyKey(<original key>, resendId)`, so the provider does not
   * swallow it as a duplicate of the first send, and no manager copy goes out.
   */
  resendId?: string | null;
}

/** The receipt for an item invoice. Best-effort; keyed to the invoice, so sent once. */
export async function sendItemInvoicePaidEmail({
  invoiceId,
  memberGreetingName,
  memberEmail,
  forName,
  reference,
  summary,
  amount,
  admin,
  resendId,
}: ItemInvoicePaidEmailParams): Promise<{ sent: boolean; skipped: boolean }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[item-invoice-email] LOVABLE_API_KEY not set — skipping receipt");
    return { sent: false, skipped: true };
  }
  const replyTo = await clubReplyTo(admin);
  const el = React.createElement(ItemInvoicePaidEmail, {
    siteName: SITE_NAME,
    siteUrl: SITE_ORIGIN,
    memberName: memberGreetingName,
    forName,
    reference,
    summary,
    amount,
    membershipUrl: ACCOUNT_URL,
    replyTo,
  });
  try {
    const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
    await sendEmail({
      apiKey,
      sendUrl: process.env.LOVABLE_SEND_URL,
      to: memberEmail,
      subject: forName
        ? `Payment received for ${forName}'s invoice ${reference}`
        : `Payment received for invoice ${reference}`,
      html,
      text,
      idempotencyKey: resendId
        ? resendIdempotencyKey(`item-invoice-paid-${invoiceId}`, resendId)
        : `item-invoice-paid-${invoiceId}`,
      replyTo,
    });
    return { sent: true, skipped: false };
  } catch (e) {
    console.error(`[item-invoice-email] failed to email ${memberEmail}:`, e);
    return { sent: false, skipped: false };
  }
}
