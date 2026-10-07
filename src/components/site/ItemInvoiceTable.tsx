// Item invoices as a manager sees them, with Mark as paid / Cancel / Delete on
// each row. Shared by the two screens that list them, the club-wide unpaid list
// on /manager/items and one person's page at /manager/users/<id>, because these
// buttons record money and destroy records: two copies would be two places for
// the "a paid invoice is finished" rule to drift. The rule itself is
// `whyItemInvoiceIsSettled` in `item-invoices.ts`, and the server enforces it
// again on every write.
//
// Every action here gets a confirm that says what it does before the click
// (CLAUDE.md, "The UX bar"): marking paid emails a receipt and makes the invoice
// permanent, and neither a cancel nor a delete has an undo. A failure stays in
// the dialog with the button still there, the same shape as
// `MembershipRowActions`, rather than a toast that fades on a phone.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pill } from "@/components/site/StatusPill";
import { UserLink } from "@/components/site/UserLink";
import {
  cancelItemInvoice,
  deleteItemInvoice,
  markItemInvoicePaid,
  type ManagerItemInvoiceView,
} from "@/lib/item-invoices.functions";
import { ITEM_INVOICE_STATE_LABEL, whyItemInvoiceIsSettled } from "@/lib/item-invoices";
import { itemInvoiceClass } from "@/lib/status-colours";
import { formatCents } from "@/lib/validation";
import { formatDate } from "@/lib/dates";

type Action = "pay" | "cancel" | "delete";
type Pending = { kind: Action; error: string | null; busy: boolean };

function ItemInvoiceRowActions({
  invoice,
  onChanged,
}: {
  invoice: ManagerItemInvoiceView;
  /** Reload the caller's data. Awaited, so the dialog stays up until it lands. */
  onChanged: () => Promise<unknown>;
}) {
  const markPaid = useServerFn(markItemInvoicePaid);
  const cancel = useServerFn(cancelItemInvoice);
  const remove = useServerFn(deleteItemInvoice);
  const [pending, setPending] = useState<Pending | null>(null);

  // Paid is finished: nothing to do on it from here.
  if (whyItemInvoiceIsSettled(invoice)) return null;

  async function run(kind: Action) {
    setPending({ kind, error: null, busy: true });
    try {
      if (kind === "pay") await markPaid({ data: { id: invoice.id, payment_method: "manual" } });
      else if (kind === "cancel") await cancel({ data: { id: invoice.id } });
      else await remove({ data: { id: invoice.id } });
    } catch (e) {
      setPending({
        kind,
        busy: false,
        error: e instanceof Error ? e.message : "That did not go through. Try again.",
      });
      return;
    }
    // Outside the try: the write has landed, so a failed refresh is a stale
    // table, not a failed action to offer again.
    await onChanged().catch(() => {});
    setPending(null);
  }

  const ref = invoice.payment_reference;
  const copy = {
    pay: {
      title: `Record payment for invoice ${ref}?`,
      body: `This records ${formatCents(invoice.total_cents)} as received and emails them a receipt. A paid invoice can never be cancelled or deleted, so only do this once the money has arrived.`,
      confirm: "Mark as paid",
      destructive: false,
    },
    cancel: {
      title: `Cancel invoice ${ref}?`,
      body: "It stops showing as owed on their membership page and the record is kept, marked cancelled. Nothing is emailed, and it cannot be reopened: raise a new one if it turns out to be owed after all.",
      confirm: "Cancel invoice",
      destructive: false,
    },
    delete: {
      title: `Delete invoice ${ref}?`,
      body: "This removes it completely, as though it had never been raised. It cannot be undone. They may already have the invoice email, and nothing tells them it is gone, so let them know.",
      confirm: "Delete",
      destructive: true,
    },
  }[pending?.kind ?? "cancel"];

  const open = (kind: Action) => setPending({ kind, error: null, busy: false });

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {invoice.state === "unpaid" && (
          <>
            <Button size="sm" onClick={() => open("pay")}>
              <Check className="mr-1 h-3 w-3" /> Mark as paid
            </Button>
            <Button size="sm" variant="outline" onClick={() => open("cancel")}>
              <Undo2 className="mr-1 h-3 w-3" /> Cancel
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={() => open("delete")}>
          <Trash2 className="mr-1 h-3 w-3" /> Delete
        </Button>
      </div>

      <AlertDialog
        open={Boolean(pending)}
        onOpenChange={(isOpen) => {
          if (!isOpen && !pending?.busy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {pending?.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {pending.error}
            </p>
          )}
          {pending?.busy && (
            <span className="sr-only" role="status">
              Working on it...
            </span>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending?.busy}>Go back</AlertDialogCancel>
            <AlertDialogAction
              className={
                copy.destructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              disabled={pending?.busy}
              // Not the default close: the dialog has to stay open to show a failure.
              onClick={(e) => {
                e.preventDefault();
                if (pending) void run(pending.kind);
              }}
            >
              {pending?.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending?.error ? "Try again" : copy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The table. `showPerson` adds a column naming who each invoice is for, which
 * the club-wide list needs and a person's own page does not.
 */
export function ItemInvoiceTable({
  invoices,
  showPerson,
  onChanged,
}: {
  invoices: ManagerItemInvoiceView[];
  showPerson: boolean;
  onChanged: () => Promise<unknown>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left">
          <tr>
            {showPerson && <th className="px-3 py-2">For</th>}
            <th className="px-3 py-2">Invoice</th>
            <th className="px-3 py-2">Items</th>
            <th className="px-3 py-2">Total</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Raised</th>
            <th className="px-3 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} className="border-t align-top">
              {showPerson && (
                <td className="px-3 py-2">
                  <UserLink userId={inv.user_id} name={inv.member_name} />
                  {/* A child's invoice is emailed to the guardian. Say so
                      rather than print an address that reads as the child's. */}
                  {inv.member_email && (
                    <span className="block text-xs text-muted-foreground">
                      {inv.member_email}
                      {inv.member_email_belongs_to && ` (${inv.member_email_belongs_to}'s)`}
                    </span>
                  )}
                </td>
              )}
              <td className="px-3 py-2 font-mono text-xs">{inv.payment_reference}</td>
              <td className="px-3 py-2">{inv.summary}</td>
              <td className="px-3 py-2 whitespace-nowrap">{formatCents(inv.total_cents)}</td>
              <td className="px-3 py-2">
                <Pill
                  label={ITEM_INVOICE_STATE_LABEL[inv.state]}
                  preserveCase
                  className={itemInvoiceClass(inv.state)}
                />
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{formatDate(inv.created_at)}</td>
              <td className="px-3 py-2">
                <ItemInvoiceRowActions invoice={inv} onChanged={onChanged} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
