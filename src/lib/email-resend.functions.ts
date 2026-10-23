// A manager resending an email: the server half. The rules (keys, the
// once-a-minute limit, the refusals) are in `email-resend.ts`; which emails
// are resendable, and why the rest are not, is `docs/emails.md`.
//
// **Rebuild, never replay.** Nothing here stores or re-sends a copy of an
// email. Each resend composes the email again from the database through the
// same function the original send used (`emailMembershipRecord`,
// `emailItemInvoiceRecord`, `sendWaiverConfirmation`, `emailAccountActivated`,
// `sendVerificationEmail`), so it carries what is true NOW: the current amount
// and the club's current bank details on an invoice, a fresh link to the
// signed PDF, a freshly minted token where the email carries one. A raw token
// is never stored or logged to make this easier; one is minted per send.
//
// **Who it goes to** is decided the same way the original decided it: the
// person's household contact (`deliveryRecipientFor`), which is their guardian
// for a dependant. So a resend reaches the address on file today, which may be
// a corrected one rather than the one the first email went to.
//
// The screen and the manager agent API's `resend_email` both come through
// `resendEmail`, so they refuse for the same reasons in the same words.
//
// ⚠️ Bundled to the client like every `*.functions.ts`: the service-role client
// and every `*.server.ts` module are lazy-imported inside a function.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MembershipClient } from "@/lib/membership-types";
import { requireManager } from "@/lib/require-manager";
import { deliveryRecipientFor, type DeliveryRecipient } from "@/lib/household-email";
import { isDependantUser } from "@/lib/household";
import { invoiceReference } from "@/lib/item-invoices";
import {
  formatCents,
  isPaperWaiver,
  resendEmailSchema,
  resendPreviewSchema,
} from "@/lib/validation";
import {
  RESEND_COOLDOWN_SECONDS,
  formatResendMarker,
  parseResendMarker,
  resendCutoff,
  resendIdempotencyKey,
  resendMarkerKey,
  resendWaitSeconds,
  type ResendKind,
  type ResendPreview,
  type ResendRefusal,
} from "@/lib/email-resend";

async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

type Refused = { available: false; reason: ResendRefusal; message: string };

/** A resend worked out but not yet sent: what the screen shows, and how to send it. */
type Planned = {
  available: true;
  to: string;
  toBelongsTo: string | null;
  what: string;
  /** Send it under this click's id. True when it went out. */
  send: (resendId: string) => Promise<boolean>;
};

function refuse(reason: ResendRefusal, message: string): Refused {
  return { available: false, reason, message };
}

/** The guardian's name when the address is theirs rather than the subject's. */
function belongsTo(recipient: DeliveryRecipient): string | null {
  return recipient.forName ? recipient.greetingName || "their guardian" : null;
}

function noAddress(recipient: DeliveryRecipient): Refused {
  return refuse(
    "no_address",
    recipient.forName
      ? `${recipient.forName} is on somebody else's account, and that account has no email address on file.`
      : "This person has no email address on file, so there is nowhere to send it.",
  );
}

async function planMembership(
  admin: MembershipClient,
  kind: "membership_invoice" | "membership_receipt",
  id: string,
): Promise<Planned | Refused> {
  const { data: row, error } = await admin
    .from("memberships")
    .select("id, user_id, plan_id, price_cents, paid_at, status, payment_reference")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !row.user_id)
    return refuse("not_found", "That membership is no longer there. Refresh the page.");
  if (row.price_cents === 0)
    return refuse("free", "This membership is free, so there is no invoice or receipt to send.");
  if (kind === "membership_invoice" && row.paid_at)
    return refuse("paid", "This invoice has been paid. Resend the receipt instead.");
  if (kind === "membership_invoice" && row.status === "cancelled")
    return refuse("cancelled", "This membership was cancelled, so nothing is owed on it.");
  if (kind === "membership_invoice" && !row.payment_reference)
    return refuse("free", "Nothing is owed on this membership, so there is no invoice to send.");
  if (kind === "membership_receipt" && !row.paid_at)
    return refuse(
      "unpaid",
      "No payment has been recorded yet, so there is no receipt. Resend the invoice instead.",
    );

  const [recipient, { data: plan }] = await Promise.all([
    deliveryRecipientFor(admin, row.user_id),
    admin.from("membership_plans").select("name").eq("id", row.plan_id).maybeSingle(),
  ]);
  if (!recipient.email) return noAddress(recipient);
  const planName = plan?.name ?? "this membership";

  const { emailMembershipRecord } = await import("@/lib/membership.functions");
  return {
    available: true,
    to: recipient.email,
    toBelongsTo: belongsTo(recipient),
    what:
      kind === "membership_invoice"
        ? `The invoice for ${planName} (${row.payment_reference}), with the amount owed today and the club's current bank details.`
        : `The receipt for ${planName}, ${formatCents(row.price_cents)}.`,
    send: async (resendId) => {
      const outcome = await emailMembershipRecord(admin, row.id, { resendId });
      return (
        outcome.sent && outcome.email === (kind === "membership_invoice" ? "invoice" : "receipt")
      );
    },
  };
}

async function planItemInvoice(
  admin: MembershipClient,
  kind: "item_invoice" | "item_invoice_receipt",
  id: string,
): Promise<Planned | Refused> {
  const { data: invoice, error } = await admin
    .from("item_invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice || !invoice.user_id)
    return refuse("not_found", "That invoice is no longer there. Refresh the page.");
  const reference = invoiceReference(invoice);
  if (kind === "item_invoice" && invoice.paid_at)
    return refuse("paid", "This invoice has been paid. Resend the receipt instead.");
  if (kind === "item_invoice" && invoice.cancelled_at)
    return refuse("cancelled", "This invoice was cancelled, so nothing is owed on it.");
  if (kind === "item_invoice_receipt" && !invoice.paid_at)
    return refuse(
      "unpaid",
      "No payment has been recorded yet, so there is no receipt. Resend the invoice instead.",
    );

  const recipient = await deliveryRecipientFor(admin, invoice.user_id);
  if (!recipient.email) return noAddress(recipient);

  const { emailItemInvoiceRecord } = await import("@/lib/item-invoices.functions");
  return {
    available: true,
    to: recipient.email,
    toBelongsTo: belongsTo(recipient),
    what:
      kind === "item_invoice"
        ? `Invoice ${reference} for ${formatCents(invoice.total_cents)}, with the club's current bank details.`
        : `The receipt for invoice ${reference}, ${formatCents(invoice.total_cents)}.`,
    send: async (resendId) => (await emailItemInvoiceRecord(admin, invoice, { resendId })).sent,
  };
}

/** The waiver columns both waiver emails are rebuilt from. */
const WAIVER_COLUMNS =
  "id, user_id, first_name, middle_name, last_name, preferred_name, guardian_name, pdf_path, approval_status, signer_meta";

async function planWaiverConfirmation(
  admin: MembershipClient,
  id: string,
): Promise<Planned | Refused> {
  const { data: waiver, error } = await admin
    .from("waivers")
    .select(WAIVER_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!waiver || !waiver.user_id)
    return refuse("not_found", "That waiver is no longer there. Refresh the page.");
  // Filed from a scan by a manager: no confirmation was ever sent, so there is
  // nothing to send again, and a "thanks for signing" now would be news to them.
  if (isPaperWaiver(waiver.signer_meta))
    return refuse(
      "paper",
      "This waiver was filed from paper, so no confirmation email was ever sent for it.",
    );
  const recipient = await deliveryRecipientFor(admin, waiver.user_id);
  if (!recipient.email) return noAddress(recipient);
  const to = recipient.email;
  const approved = waiver.approval_status === "approved";

  return {
    available: true,
    to,
    toBelongsTo: belongsTo(recipient),
    what: waiver.pdf_path
      ? "The waiver confirmation, with a fresh link to the signed PDF."
      : "The waiver confirmation. No PDF is stored for this waiver, so it says a copy will follow.",
    send: async (resendId) => {
      const { waiverAccountContact } = await import("@/lib/waiver.functions");
      const contact = await waiverAccountContact(admin, waiver);
      // A fresh link, the same seven days the original email's link had.
      let pdfUrl: string | null = null;
      if (waiver.pdf_path) {
        const { data: signed } = await admin.storage
          .from("waivers")
          .createSignedUrl(waiver.pdf_path, 60 * 60 * 24 * 7);
        pdfUrl = signed?.signedUrl ?? null;
      }
      // A freshly minted code-of-conduct token, exactly as the signing path
      // mints one (purpose `code_of_conduct`, which never proves a mailbox),
      // and never for a child's waiver: a token identifies its holder by an
      // address, and a dependant has none (see `submitWaiverWithPdf`).
      let codeOfConductToken: string | null = null;
      if (!contact.forDependant) {
        try {
          const { mintVerificationToken } = await import("@/lib/email-verification.server");
          codeOfConductToken = await mintVerificationToken(admin, {
            email: to,
            purpose: "code_of_conduct",
            userId: waiver.user_id,
          });
        } catch (e) {
          console.error("[email-resend] could not mint a code-of-conduct link:", e);
        }
      }
      const { sendWaiverConfirmation } = await import("@/lib/waiver-email.server");
      const result = await sendWaiverConfirmation({
        waiverId: waiver.id,
        memberGreetingName: recipient.greetingName,
        memberEmail: to,
        pdfUrl,
        admin,
        // The contact, never the child: this asks whether the address the email
        // goes to is proven, and offers to prove it if not.
        userId: contact.userId,
        codeOfConductToken,
        resendId,
        approved,
      });
      return result.sent;
    },
  };
}

async function planAccountActivated(
  admin: MembershipClient,
  id: string,
): Promise<Planned | Refused> {
  const { data: waiver, error } = await admin
    .from("waivers")
    .select(WAIVER_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!waiver || !waiver.user_id)
    return refuse("not_found", "That waiver is no longer there. Refresh the page.");
  if (waiver.approval_status !== "approved")
    return refuse(
      "not_approved",
      "This waiver has not been approved, so there is no open account to tell them about.",
    );
  const { waiverAccountContact, emailAccountActivated } = await import("@/lib/waiver.functions");
  const [contact, recipient] = await Promise.all([
    waiverAccountContact(admin, waiver),
    deliveryRecipientFor(admin, waiver.user_id),
  ]);
  // The email says the account is open. It is not, so it would be a lie.
  if (contact.locked)
    return refuse(
      "locked",
      "Their login is still locked, so the email would say an account is open when it is not. Approve the waiver again to open it.",
    );
  if (!contact.email) return noAddress(recipient);
  return {
    available: true,
    to: contact.email,
    toBelongsTo: contact.forDependant ? belongsTo(recipient) : null,
    what: "The “your account is active” email, with the address they sign in with.",
    send: async (resendId) =>
      (await emailAccountActivated(admin, waiver, contact, { resendId })).sent,
  };
}

async function planVerification(
  admin: MembershipClient,
  userId: string,
): Promise<Planned | Refused> {
  // A dependant has no mailbox of their own, so there is nothing to verify, and
  // minting a token against their reserved address is the incoherence
  // the person page's resend has always refused for the same reason (#102).
  if (await isDependantUser(admin, userId))
    return refuse(
      "dependant",
      "This person is on somebody else's account and has no email of their own. Send the link to the account holder instead.",
    );
  const { data: got, error } = await admin.auth.admin.getUserById(userId);
  if (error) throw new Error(error.message);
  const email = got.user?.email;
  if (!email)
    return refuse(
      "no_address",
      "This person has no email address on file, so there is nowhere to send it.",
    );
  if (got.user?.email_confirmed_at)
    return refuse(
      "already_verified",
      "That address is already confirmed. There is nothing to send.",
    );
  return {
    available: true,
    to: email,
    toBelongsTo: null,
    what: "A fresh “confirm your email address” link.",
    send: async (resendId) => {
      const { sendVerificationEmail } = await import("@/lib/email-verification.server");
      const { sent } = await sendVerificationEmail({
        admin,
        to: email,
        purpose: "manager_resend",
        userId,
        next: "/account",
        resendIdempotencyKey: resendIdempotencyKey(`verify-${userId}`, resendId),
      });
      return sent;
    },
  };
}

/** Work out a resend: who it goes to and what it says, or why it cannot happen. */
async function planResend(
  admin: MembershipClient,
  kind: ResendKind,
  recordId: string,
): Promise<Planned | Refused> {
  switch (kind) {
    case "membership_invoice":
    case "membership_receipt":
      return planMembership(admin, kind, recordId);
    case "item_invoice":
    case "item_invoice_receipt":
      return planItemInvoice(admin, kind, recordId);
    case "waiver_confirmation":
      return planWaiverConfirmation(admin, recordId);
    case "account_activated":
      return planAccountActivated(admin, recordId);
    case "email_verification":
      return planVerification(admin, recordId);
  }
}

/** What the screen shows under the button before anything is sent. Never sends. */
export async function previewResend(
  admin: MembershipClient,
  kind: ResendKind,
  recordId: string,
): Promise<ResendPreview> {
  const plan = await planResend(admin, kind, recordId);
  if (!plan.available) return plan;
  return { available: true, to: plan.to, toBelongsTo: plan.toBelongsTo, what: plan.what };
}

/**
 * Claim this email's once-a-minute slot for one click, or say how long to wait.
 *
 * A compare-and-swap in the database rather than a read then a write, so two
 * presses landing together cannot both win: insert the marker, and if one is
 * already there, overwrite it only if it is older than a minute (or is this
 * same click's, which is a retry of the same send).
 */
export async function claimResendSlot(
  admin: MembershipClient,
  kind: ResendKind,
  recordId: string,
  resendId: string,
  now: Date = new Date(),
): Promise<{ claimed: true } | { claimed: false; waitSeconds: number }> {
  const key = resendMarkerKey(kind, recordId);
  const value = formatResendMarker({ at: now.toISOString(), resendId });

  const { error: insertError } = await admin
    .from("club_settings")
    .insert({ key, value, updated_at: now.toISOString() });
  if (!insertError) return { claimed: true };
  if (insertError.code !== "23505") throw new Error(insertError.message);

  const { data: existing, error: readError } = await admin
    .from("club_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const marker = parseResendMarker(existing?.value);
  // A retry of the click that holds the slot: let it through untouched.
  if (marker?.resendId === resendId) return { claimed: true };

  const { data: swapped, error: swapError } = await admin
    .from("club_settings")
    .update({ value, updated_at: now.toISOString() })
    .eq("key", key)
    .lt("value", resendCutoff(now))
    .select("key");
  if (swapError) throw new Error(swapError.message);
  if (swapped && swapped.length > 0) return { claimed: true };
  return {
    claimed: false,
    waitSeconds: Math.max(1, resendWaitSeconds(marker, resendId, now) || RESEND_COOLDOWN_SECONDS),
  };
}

/**
 * Give the slot back after a send that did not go out, so the manager can press
 * again straight away. Only this click's marker: never one a later press holds.
 */
async function releaseResendSlot(
  admin: MembershipClient,
  kind: ResendKind,
  recordId: string,
  resendId: string,
): Promise<void> {
  const { data } = await admin
    .from("club_settings")
    .select("value")
    .eq("key", resendMarkerKey(kind, recordId))
    .maybeSingle();
  const marker = parseResendMarker(data?.value);
  if (marker?.resendId !== resendId) return;
  await admin
    .from("club_settings")
    .delete()
    .eq("key", resendMarkerKey(kind, recordId))
    .eq("value", data!.value);
}

/** Thrown when the email was composed but did not go out: worth a retry. */
export class ResendNotSentError extends Error {
  constructor() {
    super("We couldn't send that email just now. Try again shortly.");
    this.name = "ResendNotSentError";
  }
}

export type ResendResult =
  | { sent: true; to: string; toBelongsTo: string | null }
  | { sent: false; reason: ResendRefusal; message: string; retryAfterSeconds?: number };

/**
 * Resend one email for one record. Refusals come back as a result the screen
 * shows; a send that failed throws `ResendNotSentError`, which the screen's
 * retry (and an agent's) repeats under the same `resendId`.
 */
export async function resendEmail(
  admin: MembershipClient,
  input: { kind: ResendKind; record_id: string; resendId: string },
  actorId: string,
): Promise<ResendResult> {
  const plan = await planResend(admin, input.kind, input.record_id);
  if (!plan.available) return { sent: false, reason: plan.reason, message: plan.message };

  const slot = await claimResendSlot(admin, input.kind, input.record_id, input.resendId);
  if (!slot.claimed) {
    return {
      sent: false,
      reason: "rate_limited",
      message: `This was sent less than a minute ago. You can send it again in ${slot.waitSeconds} second${slot.waitSeconds === 1 ? "" : "s"}.`,
      retryAfterSeconds: slot.waitSeconds,
    };
  }

  const sent = await plan.send(input.resendId).catch((e) => {
    console.error(`[email-resend] ${input.kind} ${input.record_id} failed:`, e);
    return false;
  });
  // The record of it, in the server log. No address and no token: the kind,
  // the record and the manager are enough to answer "did anyone resend this?".
  console.info(
    `[email-resend] audit ${JSON.stringify({
      kind: input.kind,
      record_id: input.record_id,
      actor: actorId,
      resend_id: input.resendId,
      sent,
    })}`,
  );
  if (!sent) {
    await releaseResendSlot(admin, input.kind, input.record_id, input.resendId).catch(() => {});
    throw new ResendNotSentError();
  }
  return { sent: true, to: plan.to, toBelongsTo: plan.toBelongsTo };
}

export const getResendPreview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resendPreviewSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return previewResend(await adminClient(), data.kind, data.record_id);
  });

export const resendClubEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resendEmailSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return resendEmail(
      await adminClient(),
      { kind: data.kind, record_id: data.record_id, resendId: data.client_submission_id },
      context.userId,
    );
  });
