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
   * The day the dialog opened on. Left untouched, the date is not sent at all,
   * so the server records the moment of the click: a dialog opened at 11:58pm
   * and confirmed after midnight would otherwise send yesterday and book the
   * cash to a day nobody chose.
   */
  openedOn: string;
};

/** A fresh pair for a dialog that has just opened: today, and no reference. */
export function newPaymentReceived(): PaymentReceived {
  const today = clubToday();
  return { paidOn: today, reference: "", openedOn: today };
}

/** Why the day picked will be refused, or null when the server will take it. */
export function paymentReceivedProblem(value: PaymentReceived): string | null {
  return paidOnProblem(value.paidOn);
}

/** The fields as the server functions take them. */
export function paymentReceivedParams(value: PaymentReceived) {
  return {
    paid_on: value.paidOn === value.openedOn ? undefined : value.paidOn,
    paid_reference: value.reference.trim() || undefined,
  };
}
