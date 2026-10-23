// The state behind the "Paid on" and "Receipt or reference" fields in both
// "Mark as paid" dialogs (`components/site/PaymentReceived.tsx`), kept out of
// the component file so it can be tested directly and so Fast Refresh keeps
// working there. The server holds the same rules in `paymentReceivedFields`
// (validation.ts); this is the screen's early, friendlier copy of them.
import { clubToday } from "./validation";

/** What the two fields hold while the dialog is open. */
export type PaymentReceived = { paidOn: string; reference: string };

/** A fresh pair for a dialog that has just opened: today, and no reference. */
export function newPaymentReceived(): PaymentReceived {
  return { paidOn: clubToday(), reference: "" };
}

/**
 * Whether the day picked is one the server will take. The confirm button is
 * held back otherwise, with the reason on screen, rather than sent and refused.
 */
export function paymentReceivedProblem(value: PaymentReceived): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.paidOn)) return "Pick the day the money arrived.";
  if (value.paidOn > clubToday()) return "That day has not happened yet. Pick today or earlier.";
  return null;
}

/** The fields as the server functions take them. */
export function paymentReceivedParams(value: PaymentReceived) {
  return { paid_on: value.paidOn, paid_reference: value.reference.trim() || undefined };
}
