// The rules for a manager resending an email, kept pure so they can be tested
// without a server. The server side is `email-resend.functions.ts`; the
// inventory of which emails can be resent, and why the rest cannot, is
// `docs/emails.md`.
//
// Two things here are easy to get wrong, and both fail silently:
//
// 1. **Idempotency keys swallow a naive resend.** Every original send is keyed
//    (`membership-payment-<id>`, `waiver-member-<id>`, ...) so that a retry of
//    the original cannot double-send, and the provider discards a second send
//    under the same key without saying so. A resend under the original key
//    would therefore report "sent" and deliver nothing. So a resend uses the
//    original key plus `:resend:` plus the id of the CLICK: a new key for every
//    press of the button, and the same key for every automatic retry of one
//    press (`useResilientSubmit`'s `client_submission_id`), so a retry after a
//    lost answer cannot deliver two copies either.
//
// 2. **A double click, or an impatient manager, must not send five copies.**
//    Each email for each record can be resent once a minute. The marker that
//    enforces it remembers which click claimed the slot, so a retry of that
//    same click is let through (it is the same send, and the provider dedupes
//    it on the key above) while a second, separate press is refused and told
//    how long to wait.

/** The emails a manager can resend. `docs/emails.md` says why these and no others. */
export const resendKinds = [
  "membership_invoice",
  "membership_receipt",
  "item_invoice",
  "item_invoice_receipt",
  "waiver_confirmation",
  "account_activated",
  "email_verification",
] as const;
export type ResendKind = (typeof resendKinds)[number];

/** How long one email for one record has to wait before it can be resent again. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** The idempotency key a resend goes out under. See the header, point 1. */
export function resendIdempotencyKey(originalKey: string, resendId: string): string {
  return `${originalKey}:resend:${resendId}`;
}

/**
 * The key a send goes out under: the original's, or a resend's when this is
 * one. Every resendable sender keys through this, so none can forget the
 * resend half and be silently dropped by the provider as a duplicate.
 */
export function idempotencyKeyFor(originalKey: string, resendId?: string | null): string {
  return resendId ? resendIdempotencyKey(originalKey, resendId) : originalKey;
}

/**
 * The key a resend marker is stored under, in `club_settings`.
 *
 * Key/value rather than a table of its own so this ships without a migration.
 * The cost is that `club_settings` holds a row per record ever resent, which
 * nothing else reads: the screens fetch their settings by exact key. A table
 * with a "last sent" a manager can see is the proper home, and is proposed in
 * `docs/emails.md` rather than added unasked.
 */
export function resendMarkerKey(kind: ResendKind, recordId: string): string {
  return `email_resend:${kind}:${recordId}`;
}

/**
 * A stored marker: when the slot was claimed, by which click, and whether that
 * click's email has gone out. `sent` is what tells a retry of a failed press
 * (send it) from a click id reused after its email already went (refuse: the
 * provider would drop it as a duplicate of the same key, and "sent" would be
 * a lie). See `sameClickVerdict`.
 */
export type ResendMarker = { at: string; resendId: string; sent?: boolean };

/**
 * `<ISO instant>|<click id>`, plus `|sent` once that click's email has gone.
 * The instant comes first, always in the same UTC `toISOString` shape, so the
 * stored strings sort by time and the claim can be a single compare-and-swap
 * ("only if older than a minute ago") in the database.
 */
export function formatResendMarker(marker: ResendMarker): string {
  return `${marker.at}|${marker.resendId}${marker.sent ? "|sent" : ""}`;
}

export function parseResendMarker(value: string | null | undefined): ResendMarker | null {
  if (!value) return null;
  const [at, resendId, flag] = value.split("|");
  if (!at || !resendId || Number.isNaN(Date.parse(at))) return null;
  return flag === "sent" ? { at, resendId, sent: true } : { at, resendId };
}

/**
 * What to do with a press whose click id already holds the slot.
 *
 * - Its email has not gone out: a retry of a failed or unfinished send. Let it
 *   through, however long ago, so "Try again" never meets a refusal.
 * - It has gone out, within the minute: a retry racing its own success (the
 *   first attempt timed out on the client but landed). Let it through: the
 *   provider drops the duplicate, and "sent" is true.
 * - It has gone out, longer ago: the same id reused for what is meant as a new
 *   send. It would go out under the same key and be dropped without a word, so
 *   refuse, and say to send it again as a new press.
 */
export function sameClickVerdict(marker: ResendMarker, now: Date): "retry" | "already_sent" {
  if (!marker.sent) return "retry";
  return now.getTime() - Date.parse(marker.at) < RESEND_COOLDOWN_SECONDS * 1000
    ? "retry"
    : "already_sent";
}

/** The instant before which a marker no longer blocks a resend. */
export function resendCutoff(now: Date): string {
  return new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000).toISOString();
}

/**
 * Seconds until a NEW click may resend, or 0 when it may go now.
 *
 * A retry of the click that holds the slot is never made to wait: it is the
 * same send, under the same key.
 */
export function resendWaitSeconds(
  marker: ResendMarker | null,
  resendId: string,
  now: Date,
): number {
  if (!marker || marker.resendId === resendId) return 0;
  const elapsedMs = now.getTime() - Date.parse(marker.at);
  const leftMs = RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs;
  return leftMs > 0 ? Math.ceil(leftMs / 1000) : 0;
}

/** Why a resend cannot happen. Each has its own sentence for the screen. */
export type ResendRefusal =
  | "not_found"
  | "paper"
  | "no_address"
  | "dependant"
  | "paid"
  | "unpaid"
  | "cancelled"
  | "free"
  | "not_approved"
  | "locked"
  | "already_verified"
  | "rate_limited"
  | "already_sent";

/** What the screen shows a manager under the button, before anything is sent. */
export type ResendPreview =
  | {
      available: true;
      /** The address it goes to. */
      to: string;
      /** Whose address that is, when it is not the person the email is about. */
      toBelongsTo: string | null;
      /** One line: what is about to be sent. */
      what: string;
    }
  | { available: false; reason: ResendRefusal; message: string };

/** The button's own words for each email. */
export const RESEND_LABELS: Record<ResendKind, string> = {
  membership_invoice: "Resend invoice",
  membership_receipt: "Resend receipt",
  item_invoice: "Resend invoice",
  item_invoice_receipt: "Resend receipt",
  waiver_confirmation: "Resend confirmation",
  account_activated: "Resend account email",
  email_verification: "Resend verification",
};
