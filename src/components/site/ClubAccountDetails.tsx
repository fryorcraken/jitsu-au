import { Mail } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { CopyButton } from "@/components/site/CopyButton";
import { invoiceMarkdownComponents } from "@/lib/invoice-markdown";
import {
  CLUB_ACCOUNT_FIELDS,
  CLUB_INTERNATIONAL_FIELDS,
  clubPaymentFieldValue,
  hasInternationalDetails,
} from "@/lib/validation";
import type { ClubPaymentDetails, ClubPaymentFieldKey } from "@/lib/validation";
import { cn } from "@/lib/utils";

interface FieldSpec {
  readonly key: ClubPaymentFieldKey;
  readonly label: string;
  readonly copyLabel: string;
  readonly mono: boolean;
}

/**
 * One labelled value with its own copy button.
 *
 * The button is the point of the whole component: a member is in their banking
 * app, on a phone, and every character they retype by hand is a chance to send
 * money to the wrong account. So the copied string is the displayed string, and
 * the BSB's hyphen is added in one place (`clubPaymentFieldValue`) so what is on
 * screen and what is on the clipboard cannot disagree.
 */
function DetailRow({ field, details }: { field: FieldSpec; details: ClubPaymentDetails }) {
  const value = clubPaymentFieldValue(details, field.key);
  if (!value) return null;
  return (
    <div className="border-t py-2.5 first:border-t-0 first:pt-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {field.label}
      </dt>
      <dd className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "font-semibold text-foreground",
            field.mono ? "break-all font-mono tracking-wide" : "break-words",
          )}
        >
          {value}
        </span>
        <CopyButton text={value} label={field.copyLabel} />
      </dd>
    </div>
  );
}

export interface ClubAccountDetailsProps {
  /** Null when the club has not published a complete set of details. */
  details: ClubPaymentDetails | null;
  /** True when the settings could not be read at all, which is not the same thing. */
  unreadable?: boolean;
}

/**
 * The club's bank account, as a member reads it: the domestic fields always, the
 * overseas ones behind a disclosure, and the club's own note last.
 *
 * Shared by the member's "how to pay" panel and the manager's preview of it, so
 * a manager editing these fields is looking at what a member will actually get
 * rather than an approximation of it.
 */
export function ClubAccountDetails({ details, unreadable = false }: ClubAccountDetailsProps) {
  if (!details) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Mail className="mt-0.5 h-4 w-4 shrink-0" />
        {unreadable
          ? "We could not load the club's account details just now. Reload the page to try again, or reply to your invoice email and we'll send them over."
          : "The club has not published its account details yet. Reply to your invoice email or use the contact page and we'll send them over."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="rounded-lg border bg-background p-4">
        {CLUB_ACCOUNT_FIELDS.map((f) => (
          <DetailRow key={f.key} field={f} details={details} />
        ))}
      </dl>

      {/* Almost everyone here is paying domestically from a phone, so the
          overseas fields stay folded away rather than pushing the BSB and the
          account number down the screen. A native <details> keeps it keyboard
          and screen-reader operable with no state of our own. */}
      {hasInternationalDetails(details) && (
        <details className="rounded-lg border bg-background">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium marker:text-muted-foreground">
            Paying from overseas?
          </summary>
          <div className="border-t px-4 py-3">
            <dl>
              {CLUB_INTERNATIONAL_FIELDS.map((f) => (
                <DetailRow key={f.key} field={f} details={details} />
              ))}
            </dl>
            {/* Not a disclaimer for its own sake. An overseas transfer often
                arrives short because a bank in the middle took a cut, and
                reconciliation matches on the exact amount, so a short payment
                sits unmatched until a manager picks it up by hand. Saying so
                here is cheaper for everyone than saying it afterwards. */}
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              Banks along the way can take fees out of an international transfer, so ask yours to
              send the full amount. If it arrives short we will still sort it out, it just takes us
              a little longer.
            </p>
          </div>
        </details>
      )}

      {details.note && (
        <div className="text-sm text-muted-foreground">
          <ReactMarkdown components={invoiceMarkdownComponents}>{details.note}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
