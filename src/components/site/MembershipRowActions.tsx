// Mark as paid / Reopen / Cancel / Delete for one membership, shared by the two
// manager screens that show them: the club-wide invoice list
// (/manager/memberships) and one person's page (/manager/users/<id>).
//
// Shared rather than duplicated because these buttons are not styling — they
// record money, close a membership, or destroy a record. Two copies of that
// would be two places for the delete guard to drift, and the guard is the whole
// point of the delete button.
//
// There is no Activate here any more, and its absence is the point: a membership
// is authorised from the moment it is raised, so the thing a manager is waiting
// to do is record the payment. Reopen is the narrow leftover — putting a
// cancelled or expired membership back into service — and it says nothing about
// money.
//
// The confirms say what will happen in words before the click, because both
// outward-facing actions here are ones somebody feels: marking paid emails a
// receipt and makes the row permanent, deleting cannot be undone. A failure
// stays in the dialog with the button still there rather than becoming a toast
// that auto-dismisses on a phone.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, RotateCcw, Trash2, Undo2 } from "lucide-react";
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
import {
  deleteMembership,
  markMembershipPaid,
  setMembershipStatus,
} from "@/lib/membership.functions";
import {
  formatCents,
  isUnpaid,
  membershipDeleteMessage,
  whyMembershipCannotBeDeleted,
} from "@/lib/validation";

/** The fields both screens' membership rows carry, and all the guard needs. */
export type MembershipActionRow = {
  id: string;
  status: string;
  /** When a payment was recorded. Null means the club is still owed for it. */
  paid_at: string | null;
  /** A free membership has nothing to pay, so it is never marked paid. */
  price_cents: number;
  checkin_count: number;
  plan_name: string | null;
};

type Pending = {
  kind: "pay" | "reopen" | "cancel" | "delete";
  error: string | null;
  busy: boolean;
};

export function MembershipRowActions({
  membership,
  onChanged,
}: {
  membership: MembershipActionRow;
  /** Reload the caller's data. Awaited, so the dialog stays up until it lands. */
  onChanged: () => Promise<unknown>;
}) {
  const setStatus = useServerFn(setMembershipStatus);
  const remove = useServerFn(deleteMembership);
  const markPaid = useServerFn(markMembershipPaid);
  const [pending, setPending] = useState<Pending | null>(null);

  // Computed here from the same pure rule the server enforces, so the button and
  // the refusal can never disagree about why. The server still re-checks: this
  // row was read at page load, and a class checked in since then must not be
  // deleted out from under.
  const blockers = whyMembershipCannotBeDeleted(membership);
  const canDelete = blockers.length === 0;
  // A free membership has no invoice, so there is nothing to record.
  const owesMoney = membership.price_cents > 0 && isUnpaid(membership);
  const isClosed = membership.status === "cancelled" || membership.status === "expired";

  async function run(kind: Pending["kind"]) {
    setPending({ kind, error: null, busy: true });
    try {
      if (kind === "delete") await remove({ data: { id: membership.id } });
      else if (kind === "pay")
        await markPaid({ data: { id: membership.id, payment_method: "manual" } });
      else
        await setStatus({
          data: { id: membership.id, status: kind === "reopen" ? "active" : "cancelled" },
        });
    } catch (e) {
      // Stays on screen, in the dialog, with the button still there to press
      // again. This is the half of the flow a toast would lose.
      setPending({
        kind,
        busy: false,
        error: e instanceof Error ? e.message : "That did not go through. Try again.",
      });
      return;
    }
    // Deliberately outside the try above. The write has committed by now, so a
    // failed list refresh is a stale screen, not a failed cancel — reporting it
    // as one would offer "Try again" on a write that already landed, and
    // activating twice emails the member twice.
    await onChanged().catch(() => {});
    setPending(null);
  }

  const copy = {
    pay: {
      title: `Record payment for ${membership.plan_name ?? "this membership"}?`,
      body: `This records ${formatCents(membership.price_cents)} as received and emails them a receipt. It is also what makes this membership permanent: a membership with a payment against it can be cancelled, but never deleted. Only do this once the money has actually arrived.`,
      confirm: "Mark as paid",
      destructive: false,
    },
    reopen: {
      title: `Reopen ${membership.plan_name ?? "this membership"}?`,
      body: "This gives back its dates and credits so they can be checked in again. It does not change whether it was paid for.",
      confirm: "Reopen",
      destructive: false,
    },
    cancel: {
      title: `Cancel ${membership.plan_name ?? "this membership"}?`,
      body: "This closes the membership and keeps the record. If it was their only paid one, they lose the members-only calendar and blog comments, and stop being listed as a member.",
      confirm: "Cancel membership",
      destructive: false,
    },
    delete: {
      title: `Delete ${membership.plan_name ?? "this membership"}?`,
      body: "This removes the invoice completely, as though it had never been raised. It cannot be undone. To close a membership and keep the record, cancel it instead.",
      confirm: "Delete",
      destructive: true,
    },
  }[pending?.kind ?? "cancel"];

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {owesMoney && (
          <Button size="sm" onClick={() => setPending({ kind: "pay", error: null, busy: false })}>
            <Check className="mr-1 h-3 w-3" /> Mark as paid
          </Button>
        )}
        {isClosed && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPending({ kind: "reopen", error: null, busy: false })}
          >
            <RotateCcw className="mr-1 h-3 w-3" /> Reopen
          </Button>
        )}
        {membership.status !== "cancelled" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPending({ kind: "cancel", error: null, busy: false })}
          >
            <Undo2 className="mr-1 h-3 w-3" /> Cancel
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!canDelete}
          // A disabled button that says nothing is a dead end. The reason rides
          // on the title so it is readable on a laptop, and is repeated as
          // screen-reader text below so it is not hover-only.
          title={canDelete ? undefined : membershipDeleteMessage(blockers)}
          onClick={() => setPending({ kind: "delete", error: null, busy: false })}
        >
          <Trash2 className="mr-1 h-3 w-3" /> Delete
        </Button>
        {!canDelete && <span className="sr-only">{membershipDeleteMessage(blockers)}</span>}
      </div>

      <AlertDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open && !pending?.busy) setPending(null);
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
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending?.busy}>Go back</AlertDialogCancel>
            <AlertDialogAction
              className={
                copy.destructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              disabled={pending?.busy}
              // Not the default form-submitting close: the dialog has to stay
              // open to show a failure.
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
