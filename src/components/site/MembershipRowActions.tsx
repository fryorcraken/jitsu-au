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
// Start date is the odd one out and is deliberately not a confirm: it corrects a
// record rather than doing anything to anybody, nothing is sent, and setting the
// date back undoes it. It only appears where the start is a real choice
// (`planStartIsChoosable`, so the yearly insurance), and it shows the end date
// moving with it, because the one thing a manager could reasonably fear here is
// silently buying somebody a longer or shorter year.
//
// The confirms say what will happen in words before the click, because both
// outward-facing actions here are ones somebody feels: marking paid emails a
// receipt and makes the row permanent, deleting cannot be undone. A failure
// stays in the dialog with the button still there rather than becoming a toast
// that auto-dismisses on a phone.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CalendarDays, Check, Loader2, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  setMembershipStart,
  setMembershipStatus,
} from "@/lib/membership.functions";
import {
  clubToday,
  formatCents,
  isUnpaid,
  membershipDeleteMessage,
  planStartIsChoosable,
  rescheduleMembershipStart,
  whyMembershipCannotBeDeleted,
} from "@/lib/validation";
import type { PlanWindow } from "@/lib/validation";
import { formatDateOnly } from "@/lib/dates";

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
  /** When this membership runs from, and to. Both move together, or neither. */
  starts_at: string | null;
  ends_at: string | null;
  /**
   * The plan's own window, not a derived flag: whether the start date can be
   * moved is one rule (`planStartIsChoosable`), asked here of the same three
   * values the server asks it of.
   */
  plan_window: PlanWindow | null;
};

type Pending = {
  kind: "pay" | "reopen" | "cancel" | "delete";
  error: string | null;
  busy: boolean;
};

/** The start-date form while it is open: what has been typed, and how it went. */
type Dating = { startsOn: string; error: string | null; busy: boolean };

/** An instant as the day it falls on where the club is, or "no end date". */
function clubDayLabel(iso: string | null): string {
  return iso ? formatDateOnly(clubToday(new Date(iso))) : "no end date";
}

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
  const setStart = useServerFn(setMembershipStart);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dating, setDating] = useState<Dating | null>(null);

  // Computed here from the same pure rule the server enforces, so the button and
  // the refusal can never disagree about why. The server still re-checks: this
  // row was read at page load, and a class checked in since then must not be
  // deleted out from under.
  const blockers = whyMembershipCannotBeDeleted(membership);
  const canDelete = blockers.length === 0;
  // `isUnpaid` already knows a free membership owes nothing.
  const owesMoney = isUnpaid(membership);
  const isClosed = membership.status === "cancelled" || membership.status === "expired";

  // Only a plan whose length is fixed but whose position is not — the yearly
  // insurance. A membership whose plan could not be read shows no button rather
  // than a button that will be refused.
  const canDate = membership.plan_window ? planStartIsChoosable(membership.plan_window) : false;
  // What the row would end up holding, worked out with the rule the server uses,
  // so the preview and the write cannot disagree about the new end date.
  const preview =
    dating?.startsOn && /^\d{4}-\d{2}-\d{2}$/.test(dating.startsOn)
      ? rescheduleMembershipStart(membership, dating.startsOn)
      : null;

  async function saveStart() {
    if (!dating) return;
    setDating({ ...dating, error: null, busy: true });
    try {
      await setStart({ data: { id: membership.id, starts_on: dating.startsOn } });
    } catch (e) {
      setDating({
        ...dating,
        busy: false,
        error: e instanceof Error ? e.message : "That did not go through. Try again.",
      });
      return;
    }
    // Same reasoning as `run` below: the write has landed, so a failed refresh is
    // a stale table rather than a failed correction.
    await onChanged().catch(() => {});
    setDating(null);
  }

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
        {canDate && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDating({
                // Prefilled with the day it currently starts, so the field opens
                // on the answer it already holds rather than on today, which
                // would invite a manager to overwrite a date that was right.
                startsOn: membership.starts_at
                  ? clubToday(new Date(membership.starts_at))
                  : clubToday(),
                error: null,
                busy: false,
              })
            }
          >
            <CalendarDays className="mr-1 h-3 w-3" /> Start date
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

      <Dialog
        open={Boolean(dating)}
        onOpenChange={(open) => {
          if (!open && !dating?.busy) setDating(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>When does {membership.plan_name ?? "this membership"} start?</DialogTitle>
            <DialogDescription>
              Set this back to the day the cover really began. It runs for the same length either
              way, so the end date moves with it, and nothing is emailed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`start-date-${membership.id}`}>Start date</Label>
            <Input
              id={`start-date-${membership.id}`}
              type="date"
              value={dating?.startsOn ?? ""}
              onChange={(e) =>
                setDating((d) => (d ? { ...d, startsOn: e.target.value, error: null } : d))
              }
            />
            {/* Read in the CLUB's timezone, not the reader's. A window stored as
                13:00 UTC is 1 February in Sydney and 31 January in London, and
                the date somebody just typed changing under them as they read it
                back is the one thing this line must never do. */}
            <p className="text-sm text-muted-foreground">
              {preview
                ? `Runs ${clubDayLabel(preview.starts_at)} to ${clubDayLabel(preview.ends_at)}.`
                : `Currently ${clubDayLabel(membership.starts_at)} to ${clubDayLabel(
                    membership.ends_at,
                  )}.`}
            </p>
          </div>
          {dating?.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {dating.error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={dating?.busy} onClick={() => setDating(null)}>
              Go back
            </Button>
            <Button disabled={dating?.busy || !preview} onClick={() => void saveStart()}>
              {dating?.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {dating?.error ? "Try again" : "Save start date"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
