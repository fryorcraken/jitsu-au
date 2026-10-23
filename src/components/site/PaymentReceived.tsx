// When a payment recorded by hand arrived and what it was known by: the two
// fields both "Mark as paid" dialogs ask for (membership invoices in
// `MembershipRowActions`, item invoices in `ItemInvoiceTable`), and the line the
// invoice tables print once it is recorded.
//
// Shared because the fields are one rule asked in two places. The server checks
// the same rule (`paymentReceivedFields` in validation.ts), and two copies of
// the inputs would be two places for "a future day is refused" or the length
// limit to drift from it.
//
// The date opens on today, which is what marking paid always recorded, so a
// manager taking cash at the door changes nothing and one entering last week's
// cash picks the real day. It cannot go past today: the browser's picker stops
// there, and the server refuses it anyway.
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/dates";
import { PAID_REFERENCE_MAX, clubToday, earliestPaidOn } from "@/lib/validation";
import { paymentReceivedProblem, type PaymentReceived } from "@/lib/payment-received";

export function PaymentReceivedFields({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  /** Makes the label/input ids unique when several rows render a dialog. */
  idPrefix: string;
  value: PaymentReceived;
  onChange: (next: PaymentReceived) => void;
  disabled?: boolean;
}) {
  const problem = paymentReceivedProblem(value);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-paid-on`}>Paid on</Label>
        <Input
          id={`${idPrefix}-paid-on`}
          type="date"
          min={earliestPaidOn()}
          max={clubToday()}
          value={value.paidOn}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${idPrefix}-paid-on-problem`}
          onChange={(e) => onChange({ ...value, paidOn: e.target.value, dateChosen: true })}
        />
        {/* Always in the DOM, so a screen reader announces the reason the
            confirm button just went disabled, not only when focus returns here. */}
        <p
          id={`${idPrefix}-paid-on-problem`}
          role="status"
          aria-live="polite"
          className="text-sm text-destructive empty:hidden"
        >
          {problem}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-paid-reference`}>Receipt or reference (optional)</Label>
        <Input
          id={`${idPrefix}-paid-reference`}
          value={value.reference}
          maxLength={PAID_REFERENCE_MAX}
          disabled={disabled}
          placeholder="Receipt 42"
          aria-describedby={`${idPrefix}-paid-reference-hint`}
          onChange={(e) => onChange({ ...value, reference: e.target.value })}
        />
        <p id={`${idPrefix}-paid-reference-hint`} className="text-xs text-muted-foreground">
          Anything that will help find this payment later. The invoice keeps its own reference.
        </p>
      </div>
    </div>
  );
}

/**
 * "Paid 20/10/2026" with the reference under it, for a row that has a payment
 * recorded. Nothing at all for one that does not, so an unpaid row stays quiet.
 */
export function PaidNote({
  paidAt,
  reference,
}: {
  paidAt: string | null;
  reference?: string | null;
}) {
  if (!paidAt) return null;
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      Paid {formatDate(paidAt)}
      {reference && <span className="block break-words">Ref: {reference}</span>}
    </span>
  );
}
