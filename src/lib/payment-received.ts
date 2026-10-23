// The state behind the "Paid on" and "Receipt or reference" fields in both
// "Mark as paid" dialogs (`components/site/PaymentReceived.tsx`), kept out of
// the component file so it can be tested directly and so Fast Refresh keeps
// working there. The rule for the day is the server's own (`paidOnProblem`),
// asked early so the button can say why it is held back.
import { clubToday, paidOnProblem } from "./validation";

export type PaymentReceived = {
  paidOn: string;
  reference: string;
  /**
   * Whether the manager has touched the date. Untouched, it is not sent at all,
   * so the server records the moment of the click: a dialog opened at 11:58pm
   * and confirmed after midnight would otherwise send yesterday. Any edit counts,
   * including picking today again, so a day somebody chose is always the day
   * stored.
   */
  dateChosen: boolean;
};

/** A fresh pair for a dialog that has just opened: today, and no reference. */
export function newPaymentReceived(): PaymentReceived {
  return { paidOn: clubToday(), reference: "", dateChosen: false };
}

/** Why the day picked will be refused, or null when the server will take it. */
export function paymentReceivedProblem(value: PaymentReceived): string | null {
  // The date picker shows dd/mm/yyyy and hands over "" until a whole day is
  // in it, so the server's "as YYYY-MM-DD" wording would ask for a format the
  // manager cannot type. Everything else is the server's own reason.
  if (!value.paidOn) return "Pick the day the money arrived.";
  return paidOnProblem(value.paidOn);
}

/** The fields as the server functions take them. */
export function paymentReceivedParams(value: PaymentReceived) {
  return {
    paid_on: value.dateChosen ? value.paidOn : undefined,
    paid_reference: value.reference.trim() || undefined,
  };
}
