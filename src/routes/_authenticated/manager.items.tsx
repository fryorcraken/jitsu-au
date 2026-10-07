import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { ItemInvoiceTable } from "@/components/site/ItemInvoiceTable";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { describeLoadError } from "@/lib/load-error";
import {
  CHARGE_ITEM_MAX_NAME,
  formatCents,
  parseMoneyToCents,
  saveChargeItemSchema,
} from "@/lib/validation";
import {
  deleteChargeItem,
  listChargeItems,
  listItemInvoices,
  saveChargeItem,
  type ManagerItemInvoiceView,
} from "@/lib/item-invoices.functions";

// The club's price list for things that are not a membership, and every item
// invoice still waiting to be paid. Product spec: docs/item-invoices.md.
//
// Invoices are RAISED from a person's own page, not here: picking the person
// first is how a manager avoids charging the wrong one, and that page already
// has their name, their family and their memberships in front of it. This
// screen is where the prices are kept and where a manager chases what is owed.
export const Route = createFileRoute("/_authenticated/manager/items")({
  head: () => ({
    meta: [{ title: "Items | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ItemsPage,
});

type Item = Awaited<ReturnType<typeof listChargeItems>>[number];

/** "$85" or "12.50" as typed, to cents. Null when it is not a price at all. */
function priceFromInput(value: string): number | null {
  return parseMoneyToCents(value);
}

/** Cents back to what goes in the price box: "85" or "12.50", no dollar sign. */
function priceForInput(cents: number): string {
  return Number.isInteger(cents / 100) ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The schema's own words for what is wrong, or null when it would save. */
function validationError(name: string, price: string): string | null {
  const price_cents = priceFromInput(price);
  if (price_cents === null) return "Type a price, like 85 or 12.50.";
  const parsed = saveChargeItemSchema.safeParse({ name, price_cents });
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the name and price.");
}

/**
 * One attempt, not three. Adding an item carries no submission id, so an
 * automatic retry after a timeout whose first attempt had in fact committed
 * would put the same item on the list twice. A manager pressing the button
 * again after the failure panel is a choice they make looking at the list.
 */
const ADD_ITEM_SUBMIT = { ...INTAKE_SUBMIT, attempts: 1 } as const;

function AddItemForm({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const save = useServerFn(saveChargeItem);
  const send = useResilientSubmit<Item>(ADD_ITEM_SUBMIT);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [touched, setTouched] = useState(false);
  const problem = validationError(name, price);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (problem) return;
    const price_cents = priceFromInput(price)!;
    const outcome = await send.submit({
      run: (signal) => save({ signal, data: { name: name.trim(), price_cents } }),
    });
    if (outcome.ok) {
      toast.success(`${outcome.value.name} added at ${formatCents(outcome.value.price_cents)}.`);
      setName("");
      setPrice("");
      setTouched(false);
      send.reset();
      await onAdded().catch(() => {});
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="new-item-name">Name</Label>
          <Input
            id="new-item-name"
            value={name}
            maxLength={CHARGE_ITEM_MAX_NAME}
            placeholder="e.g. Club gi"
            onChange={(e) => setName(e.target.value)}
            disabled={send.busy}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-item-price">Price ($)</Label>
          <Input
            id="new-item-price"
            inputMode="decimal"
            value={price}
            placeholder="85"
            onChange={(e) => setPrice(e.target.value)}
            disabled={send.busy}
          />
        </div>
        <Button type="submit" disabled={send.busy}>
          {send.busy ? "Adding..." : "Add item"}
        </Button>
      </div>
      {touched && problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <SubmitStatus
        status={send.status}
        attempt={send.attempt}
        attempts={send.attempts}
        error={send.error}
        failureKind={send.failureKind}
        onRetry={() => void submit()}
      />
    </form>
  );
}

/**
 * One item: its name and price, editable in place, and a remove button.
 *
 * Neither edit nor remove asks first. Both change only the price list: every
 * invoice already raised keeps its own copy of the name and price, and an item
 * removed by mistake is added back in a few seconds.
 */
function ItemRow({ item, onChanged }: { item: Item; onChanged: () => Promise<unknown> }) {
  const save = useServerFn(saveChargeItem);
  const remove = useServerFn(deleteChargeItem);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(priceForInput(item.price_cents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validationError(name, price);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await save({ data: { id: item.id, name: name.trim(), price_cents: priceFromInput(price)! } });
    } catch (err) {
      // Stays beside the form with the values still in it, not in a toast.
      setError(err instanceof Error ? err.message : "That did not save. Try again.");
      setBusy(false);
      return;
    }
    await onChanged().catch(() => {});
    setBusy(false);
    setEditing(false);
  }

  async function removeItem() {
    setBusy(true);
    setError(null);
    try {
      await remove({ data: { id: item.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That was not removed. Try again.");
      setBusy(false);
      return;
    }
    toast.success(`${item.name} removed. Invoices already sent are unchanged.`);
    await onChanged().catch(() => {});
  }

  if (editing) {
    return (
      <li className="px-3 py-3">
        <form
          onSubmit={(e) => void saveEdit(e)}
          className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor={`name-${item.id}`}>Name</Label>
            <Input
              id={`name-${item.id}`}
              value={name}
              maxLength={CHARGE_ITEM_MAX_NAME}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`price-${item.id}`}>Price ($)</Label>
            <Input
              id={`price-${item.id}`}
              inputMode="decimal"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setError(null);
              }}
              disabled={busy}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setName(item.name);
                setPrice(priceForInput(item.price_cents));
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          A new price applies to invoices raised from now on. Ones already sent keep theirs.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 font-medium">{item.name}</span>
        <span className="text-sm">{formatCents(item.price_cents)}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil className="mr-1 h-3 w-3" /> Edit
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void removeItem()}>
            {busy ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="mr-1 h-3 w-3" />
            )}
            Remove
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

function ItemsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchItems = useServerFn(listChargeItems);
  const fetchUnpaid = useServerFn(listItemInvoices);

  const [items, setItems] = useState<Item[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [unpaid, setUnpaid] = useState<ManagerItemInvoiceView[] | null>(null);
  const [unpaidError, setUnpaidError] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  // Two reads with two failure panels: a price list that will not load must not
  // hide what people owe, and the other way round.
  const loadItems = useCallback(
    () =>
      fetchItems()
        .then((rows) => {
          setItems(rows);
          setItemsError(null);
        })
        .catch((e) => setItemsError(describeLoadError(e, "Could not load the item list"))),
    [fetchItems],
  );
  const loadUnpaid = useCallback(
    () =>
      fetchUnpaid({ data: { state: "unpaid" } })
        .then((rows) => {
          setUnpaid(rows);
          setUnpaidError(null);
        })
        .catch((e) => setUnpaidError(describeLoadError(e, "Could not load the unpaid invoices"))),
    [fetchUnpaid],
  );

  useEffect(() => {
    if (!isManager) return;
    void loadItems();
    void loadUnpaid();
  }, [isManager, loadItems, loadUnpaid]);

  const owed = (unpaid ?? []).reduce((sum, inv) => sum + inv.total_cents, 0);

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-black">Items</h1>
        <p className="text-sm text-muted-foreground">
          Things the club charges for that are not a membership. To charge somebody, open their page
          from{" "}
          <Link to="/manager/users" className="underline">
            Users
          </Link>{" "}
          and use Charge items.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Item list</CardTitle>
          <CardDescription>
            A name and a price. Changing or removing an item never changes an invoice that has
            already been sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <AddItemForm onAdded={loadItems} />
          {itemsError ? (
            <LoadFailure
              what="The item list"
              message={itemsError}
              hint="This is not the same as having no items. Do not add them again until it loads."
              onRetry={() => void loadItems()}
            />
          ) : !items ? (
            <Loading />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items yet. Add the first one above.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((item) => (
                // Keyed on when it last changed too, so a row edited since
                // starts its edit form from the value now on the list.
                <ItemRow key={`${item.id}:${item.updated_at}`} item={item} onChanged={loadItems} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unpaid invoices</CardTitle>
          <CardDescription>
            A transfer quoting an invoice's reference is matched when you import a bank statement on
            Bank reconciliation. Mark anything paid another way here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unpaidError ? (
            <LoadFailure
              what="The unpaid invoices"
              message={unpaidError}
              hint="This is not the same as nothing being owed."
              onRetry={() => void loadUnpaid()}
            />
          ) : !unpaid ? (
            <Loading />
          ) : unpaid.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is owed: every item invoice so far has been paid or cancelled.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium" role="status">
                {unpaid.length} waiting, {formatCents(owed)} in all.
              </p>
              <ItemInvoiceTable invoices={unpaid} showPerson onChanged={loadUnpaid} />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
