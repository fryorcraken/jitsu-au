// Manager: one person's item invoices, and the card that raises a new one.
// Lives on /manager/users/<id>, under their memberships. Product spec:
// docs/item-invoices.md.
//
// Self-loading rather than riding on the page's own read, so a failure here
// shows a retry in this section and never takes the person's record down with
// it: a manager who came to approve a waiver should not lose the page because
// the invoice list would not load.
//
// Raising an invoice emails somebody and cannot be unsent, so it asks first and
// says who will get it (for a child, their guardian) and for how much. It goes
// through `useResilientSubmit` like every other form that writes, carrying the
// form fill's submission id so a retried raise finds the invoice it already
// made instead of sending a second one.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { ItemInvoiceTable } from "@/components/site/ItemInvoiceTable";
import { useConfirm } from "@/hooks/use-confirm";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { describeLoadError } from "@/lib/load-error";
import {
  createItemInvoice,
  listChargeItems,
  listItemInvoices,
  type ManagerItemInvoiceView,
} from "@/lib/item-invoices.functions";
import { describeItemInvoiceLine } from "@/lib/item-invoices";
import { formatCents, ITEM_INVOICE_MAX_LINES, ITEM_INVOICE_MAX_QUANTITY } from "@/lib/validation";

type Item = Awaited<ReturnType<typeof listChargeItems>>[number];
type Picked = { item: Item; quantity: number };
type Raised = Awaited<ReturnType<typeof createItemInvoice>>;

function ChargeItemsCard({
  userId,
  personName,
  emailGoesTo,
  onRaised,
}: {
  userId: string;
  personName: string;
  /** The guardian's name when the person is a child, whose email goes to them. */
  emailGoesTo: string | null;
  onRaised: () => Promise<unknown>;
}) {
  const fetchItems = useServerFn(listChargeItems);
  const raise = useServerFn(createItemInvoice);
  const send = useResilientSubmit<Raised>(INTAKE_SUBMIT);
  const { confirm, confirmDialog } = useConfirm();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [lastRaised, setLastRaised] = useState<Raised | null>(null);
  // Set when the price list moved under an open card. Cleared on any edit.
  const [listChanged, setListChanged] = useState<string | null>(null);

  useEffect(() => {
    if (!open || items || itemsError) return;
    fetchItems()
      .then(setItems)
      .catch((e) => setItemsError(describeLoadError(e, "We could not load the item list")));
  }, [open, items, itemsError, fetchItems]);

  const total = picked.reduce((sum, p) => sum + p.item.price_cents * p.quantity, 0);
  const notPicked = (items ?? []).filter((i) => !picked.some((p) => p.item.id === i.id));

  function add(id: string) {
    setListChanged(null);
    const item = items?.find((i) => i.id === id);
    if (item) setPicked((prev) => [...prev, { item, quantity: 1 }]);
  }

  function setQuantity(id: string, quantity: number) {
    setListChanged(null);
    const q = Math.max(1, Math.min(ITEM_INVOICE_MAX_QUANTITY, Math.round(quantity) || 1));
    setPicked((prev) => prev.map((p) => (p.item.id === id ? { ...p, quantity: q } : p)));
  }

  /**
   * Re-read the price list and bring what is picked into line with it.
   *
   * The server charges the price on the list at the moment of raising, never
   * the one this card loaded. So the confirm has to quote the CURRENT price, or
   * a manager agrees to $85 and the member is emailed $95. Returns false when
   * anything moved, so the manager looks at the new total before sending.
   */
  async function checkPricesStillCurrent(): Promise<boolean> {
    const fresh = await fetchItems();
    setItems(fresh);
    const byId = new Map(fresh.map((i) => [i.id, i]));
    const removed = picked.filter((p) => !byId.has(p.item.id)).map((p) => p.item.name);
    const changed = picked.filter((p) => {
      const now = byId.get(p.item.id);
      return now && (now.price_cents !== p.item.price_cents || now.name !== p.item.name);
    });
    if (!removed.length && !changed.length) return true;
    setPicked((prev) =>
      prev.filter((p) => byId.has(p.item.id)).map((p) => ({ ...p, item: byId.get(p.item.id)! })),
    );
    setListChanged(
      [
        removed.length
          ? `${removed.join(", ")} ${removed.length === 1 ? "has" : "have"} come off the item list, so ${removed.length === 1 ? "it is" : "they are"} no longer here.`
          : "",
        changed.length ? "Some prices changed since you opened this, so the total is updated." : "",
        "Check it, then send again.",
      ]
        .filter(Boolean)
        .join(" "),
    );
    return false;
  }

  async function submit() {
    if (!picked.length) return;
    setListChanged(null);
    try {
      if (!(await checkPricesStillCurrent())) return;
    } catch (e) {
      setListChanged(
        `${describeLoadError(e, "We could not check the current prices")}. Nothing was sent; try again.`,
      );
      return;
    }
    const recipient = emailGoesTo ? `${emailGoesTo} (${personName}'s guardian)` : personName;
    const ok = await confirm({
      title: `Send ${personName} an invoice for ${formatCents(total)}?`,
      description: `We email ${recipient} straight away, with the club's bank details and a reference to pay with. It also shows on their membership page.`,
      details: picked.map(
        (p) =>
          `${describeItemInvoiceLine({ name: p.item.name, unit_price_cents: p.item.price_cents, quantity: p.quantity })}: ${formatCents(p.item.price_cents * p.quantity)}`,
      ),
      footnote: "An email cannot be unsent. If it is wrong, cancel the invoice and send a new one.",
      confirmLabel: "Send invoice",
    });
    if (!ok) return;

    const outcome = await send.submit({
      run: async (signal, submissionId) =>
        raise({
          signal,
          data: {
            user_id: userId,
            client_submission_id: submissionId,
            lines: picked.map((p) => ({ item_id: p.item.id, quantity: p.quantity })),
          },
        }),
    });
    if (outcome.ok) {
      setLastRaised(outcome.value);
      setPicked([]);
      // A fresh id: the next invoice is a new submission, not a retry of this one.
      send.reset();
      await onRaised().catch(() => {});
    }
  }

  if (!open) {
    return (
      <div className="space-y-2">
        {lastRaised && <RaisedNotice raised={lastRaised} />}
        <Button
          variant="outline"
          onClick={() => {
            setOpen(true);
            setLastRaised(null);
          }}
        >
          Charge items
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">Charge items</h3>
          <p className="text-sm text-muted-foreground">
            Pick what they are paying for. Prices come from the{" "}
            <Link to="/manager/items" className="underline">
              item list
            </Link>
            .
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={send.busy} onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {lastRaised && <RaisedNotice raised={lastRaised} />}

      {itemsError ? (
        <LoadFailure
          what="The item list"
          message={itemsError}
          onRetry={() => {
            setItemsError(null);
            setItems(null);
          }}
        />
      ) : !items ? (
        <Loading label="Loading the item list..." />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There is nothing on the item list yet.{" "}
          <Link to="/manager/items" className="underline">
            Add an item
          </Link>{" "}
          first, then come back here.
        </p>
      ) : (
        <div className="space-y-4">
          {picked.length > 0 && (
            <ul className="divide-y rounded-md border">
              {picked.map((p) => (
                <li key={p.item.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 text-sm font-medium">{p.item.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatCents(p.item.price_cents)} each
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-9 w-9"
                      aria-label={`One fewer ${p.item.name}`}
                      disabled={p.quantity <= 1 || send.busy}
                      onClick={() => setQuantity(p.item.id, p.quantity - 1)}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Label htmlFor={`qty-${p.item.id}`} className="sr-only">
                      How many {p.item.name}
                    </Label>
                    <Input
                      id={`qty-${p.item.id}`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={ITEM_INVOICE_MAX_QUANTITY}
                      value={p.quantity}
                      disabled={send.busy}
                      onChange={(e) => setQuantity(p.item.id, Number(e.target.value))}
                      className="h-9 w-16 text-center"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-9 w-9"
                      aria-label={`One more ${p.item.name}`}
                      disabled={p.quantity >= ITEM_INVOICE_MAX_QUANTITY || send.busy}
                      onClick={() => setQuantity(p.item.id, p.quantity + 1)}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <span className="w-16 text-right text-sm font-medium">
                    {formatCents(p.item.price_cents * p.quantity)}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9"
                    aria-label={`Take ${p.item.name} off this invoice`}
                    disabled={send.busy}
                    onClick={() => setPicked((prev) => prev.filter((x) => x.item.id !== p.item.id))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
              <li className="flex justify-between px-3 py-2 text-sm font-bold">
                <span>Total</span>
                <span>{formatCents(total)}</span>
              </li>
            </ul>
          )}

          {notPicked.length > 0 && picked.length < ITEM_INVOICE_MAX_LINES && (
            <div className="space-y-2">
              <Label htmlFor={`add-item-${userId}`}>Add an item</Label>
              <select
                id={`add-item-${userId}`}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                value=""
                disabled={send.busy}
                onChange={(e) => add(e.target.value)}
              >
                <option value="">Choose an item...</option>
                {notPicked.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({formatCents(item.price_cents)})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-3">
            {listChanged && (
              <p
                role="alert"
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                {listChanged}
              </p>
            )}
            <Button onClick={() => void submit()} disabled={!picked.length || send.busy}>
              {send.busy
                ? "Sending..."
                : picked.length
                  ? `Send invoice for ${formatCents(total)}`
                  : "Send invoice"}
            </Button>
            <SubmitStatus
              status={send.status}
              attempt={send.attempt}
              attempts={send.attempts}
              error={send.error}
              failureKind={send.failureKind}
              onRetry={() => void submit()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** What just happened, kept on screen rather than in a toast that fades. */
function RaisedNotice({ raised }: { raised: Raised }) {
  return (
    <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      {raised.already_raised
        ? `Invoice ${raised.reference} (${raised.summary}, ${formatCents(raised.total_cents)}) had already gone through before the connection dropped, so nothing new was sent. Anything you changed after that is not on it: raise another invoice for it.`
        : raised.emailed
          ? `Invoice ${raised.reference} for ${formatCents(raised.total_cents)} is raised and emailed.`
          : `Invoice ${raised.reference} for ${formatCents(raised.total_cents)} is raised, but the email did not go out. It is on their membership page; let them know it is there.`}
    </p>
  );
}

/** The section on a person's page: their item invoices, and the card to raise one. */
export function PersonCharges({
  userId,
  personName,
  emailGoesTo,
}: {
  userId: string;
  personName: string;
  emailGoesTo: string | null;
}) {
  const fetchInvoices = useServerFn(listItemInvoices);
  const [invoices, setInvoices] = useState<ManagerItemInvoiceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetchInvoices({ data: { user_id: userId } })
        .then((rows) => {
          setInvoices(rows);
          setError(null);
        })
        .catch((e) => setError(describeLoadError(e, "Could not load their item invoices"))),
    [fetchInvoices, userId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold">Item invoices</h2>
      {error ? (
        <LoadFailure
          what="Their item invoices"
          message={error}
          hint="This is not the same as having none."
          onRetry={() => void load()}
        />
      ) : !invoices ? (
        <Loading />
      ) : invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No item invoices yet.</p>
      ) : (
        <ItemInvoiceTable invoices={invoices} showPerson={false} onChanged={load} />
      )}
      <ChargeItemsCard
        userId={userId}
        personName={personName}
        emailGoesTo={emailGoesTo}
        onRaised={load}
      />
    </div>
  );
}
