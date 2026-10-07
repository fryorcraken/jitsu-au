// Charging for items: the price list, and invoices raised from it.
// Product spec: docs/item-invoices.md. The rules themselves (what is owed, what
// pays it, when it can be cancelled) are pure and live in `item-invoices.ts`;
// this module is the reading and writing.
//
// Everything runs on the service-role client, because both tables are closed to
// the client roles. That makes the gate in each handler the whole of the
// security boundary, so every manager path starts with `requireManager` and the
// one member path goes through `listHousehold`, which can only ever answer about
// the caller's own account.
//
// The plain `async function`s taking an `admin` client are shared with the
// manager agent API (`src/routes/api/manager/agent.ts`), so a manager on a
// screen and an agent over HTTP go through exactly the same write, the same
// refusals and the same emails.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  createItemInvoiceSchema,
  formatCents,
  listItemInvoicesSchema,
  markItemInvoicePaidSchema,
  matchTransactionToItemInvoiceSchema,
  nameWithPreferred,
  recordIdSchema,
  saveChargeItemSchema,
} from "@/lib/validation";
import type {
  CreateItemInvoiceInput,
  ListItemInvoicesInput,
  SaveChargeItemInput,
  UnpaidInvoice,
} from "@/lib/validation";
import {
  buildItemInvoiceLines,
  describeItemInvoiceLine,
  itemInvoiceAsUnpaid,
  itemInvoiceState,
  itemInvoiceSummary,
  lineTotalCents,
  parseItemInvoiceLines,
  statementLinePaysItemInvoice,
  whyItemInvoiceIsSettled,
  type ItemInvoiceLine,
  type ItemInvoiceState,
} from "@/lib/item-invoices";
import type {
  BankTransactionRow,
  ChargeItemRow,
  ItemInvoiceRow,
  MembershipClient,
} from "@/lib/membership-types";
import { deliveryRecipientFor, loadHouseholdContacts } from "@/lib/household-email";
import { householdTargetSchema, resolveSubject } from "@/lib/household";
import { requireManager } from "@/lib/require-manager";

async function adminClient(): Promise<MembershipClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Nothing with that id. The agent API answers it as a 404. */
export class ItemRecordNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemRecordNotFoundError";
  }
}

/** The invoice has been paid, so it is finished. The agent API answers it as a 409. */
export class ItemInvoiceSettledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemInvoiceSettledError";
  }
}

/**
 * The request clashes with something already recorded: a submission id reused
 * for a different person, or a transfer that is not free to link. The agent API
 * answers it as a 409, since retrying the same call can never succeed.
 */
export class ItemInvoiceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemInvoiceConflictError";
  }
}

// ---------------------------------------------------------------- price list

/** Every item on the price list, alphabetically: there is no other order to keep. */
export async function listChargeItemRows(admin: MembershipClient): Promise<ChargeItemRow[]> {
  const { data, error } = await admin
    .from("charge_items")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Add an item (no `id`) or rename / reprice one (`id`).
 *
 * Repricing touches nothing already invoiced: an invoice carries its own copy
 * of every name and price (`item-invoices.ts`). That is the behaviour a manager
 * expects of a price list, and the screen says so beside the price field.
 */
export async function saveChargeItemRow(
  admin: MembershipClient,
  input: SaveChargeItemInput,
): Promise<ChargeItemRow> {
  const values = { name: input.name, price_cents: input.price_cents };
  if (input.id) {
    // Read back rather than trusting the absence of an error: an UPDATE that
    // matched nothing is not an error in Postgres, and "saved" over an item
    // somebody else had just removed would be a lie.
    const { data, error } = await admin
      .from("charge_items")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", input.id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new ItemRecordNotFoundError(
        "That item is no longer on the list. Refresh the page and check it again.",
      );
    return data;
  }
  const { data, error } = await admin.from("charge_items").insert(values).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Take an item off the price list. A plain delete, safe at any time: invoices
 * copied what they needed when they were raised, so none of them points here.
 */
export async function deleteChargeItemRow(admin: MembershipClient, id: string): Promise<void> {
  const { data, error } = await admin.from("charge_items").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length)
    throw new ItemRecordNotFoundError("That item is no longer on the list. Refresh the page.");
}

export const listChargeItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context);
    return listChargeItemRows(await adminClient());
  });

export const saveChargeItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveChargeItemSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return saveChargeItemRow(await adminClient(), data);
  });

export const deleteChargeItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    await deleteChargeItemRow(await adminClient(), data.id);
    return { ok: true as const, id: data.id };
  });

// ------------------------------------------------------------------ invoices

/** An invoice as every screen and the agent read it: lines parsed, state named. */
export type ItemInvoiceView = {
  id: string;
  payment_reference: string;
  user_id: string | null;
  lines: ItemInvoiceLine[];
  /** "Club gi, 2 × Club patch" */
  summary: string;
  total_cents: number;
  state: ItemInvoiceState;
  paid_at: string | null;
  payment_method: string | null;
  cancelled_at: string | null;
  created_at: string;
};

function projectItemInvoice(row: ItemInvoiceRow): ItemInvoiceView {
  const lines = parseItemInvoiceLines(row.lines);
  return {
    id: row.id,
    payment_reference: row.payment_reference,
    user_id: row.user_id,
    lines,
    summary: itemInvoiceSummary(lines),
    total_cents: row.total_cents,
    state: itemInvoiceState(row),
    paid_at: row.paid_at,
    payment_method: row.payment_method,
    cancelled_at: row.cancelled_at,
    created_at: row.created_at,
  };
}

/** The manager's view adds who it is for, and whose address is shown. */
export type ManagerItemInvoiceView = ItemInvoiceView & {
  member_name: string | null;
  member_email: string | null;
  /**
   * Set only when the address shown belongs to somebody else: a child's
   * invoice goes to their guardian, and a bare address under a child's name
   * would read as the child's own mailbox.
   */
  member_email_belongs_to: string | null;
};

/**
 * Item invoices, newest first, for everyone or one person, optionally in one
 * state. A cap well past club volumes, the same as the membership invoice list.
 */
export async function listItemInvoiceRows(
  admin: MembershipClient,
  filter: ListItemInvoicesInput = {},
): Promise<ManagerItemInvoiceView[]> {
  let query = admin.from("item_invoices").select("*");
  if (filter.user_id) query = query.eq("user_id", filter.user_id);
  if (filter.state === "paid") query = query.not("paid_at", "is", null);
  if (filter.state === "cancelled") query = query.not("cancelled_at", "is", null);
  if (filter.state === "unpaid") query = query.is("paid_at", null).is("cancelled_at", null);
  const { data: rows, error } = await query.order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);

  const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
  const nameByUser = new Map<string, string>();
  let contacts: Awaited<ReturnType<typeof loadHouseholdContacts>> | null = null;
  if (userIds.length) {
    const [{ data: profiles, error: prErr }, loaded] = await Promise.all([
      admin
        .from("profiles")
        .select("user_id, first_name, middle_name, last_name, preferred_name")
        .in("user_id", userIds),
      loadHouseholdContacts(admin, userIds),
    ]);
    // An unnamed invoice reads as an invoice for nobody. Fail instead.
    if (prErr) throw new Error(prErr.message);
    contacts = loaded;
    for (const p of profiles ?? []) nameByUser.set(p.user_id, nameWithPreferred(p));
  }

  return (rows ?? []).map((row) => {
    const contact = row.user_id && contacts ? contacts.displayEmail(row.user_id) : null;
    return {
      ...projectItemInvoice(row),
      member_name: (row.user_id ? nameByUser.get(row.user_id) : null) || null,
      member_email: contact?.email ?? null,
      member_email_belongs_to: contact?.onBehalfOf?.name ?? null,
    };
  });
}

/** One invoice by id, or `ItemRecordNotFoundError`. Shared with the agent API. */
export async function readItemInvoice(
  admin: MembershipClient,
  id: string,
): Promise<ItemInvoiceRow> {
  const { data, error } = await admin.from("item_invoices").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data)
    throw new ItemRecordNotFoundError("That invoice is no longer there. Refresh the page.");
  return data;
}

/**
 * Raise an invoice for somebody and email it to them.
 *
 * Shared by the person page and the agent's `create_item_invoice`. The prices
 * come off the price list at this moment, never from the caller
 * (`buildItemInvoiceLines`). A dependant has no mailbox, so the email goes to
 * their guardian and names them; the invoice itself is the child's.
 *
 * The email is best-effort and reported back as `emailed`, so a screen can say
 * plainly when the invoice exists but nobody was told, rather than either
 * failing an invoice that was saved or claiming an email that never went.
 */
export async function createItemInvoiceForUser(
  admin: MembershipClient,
  input: CreateItemInvoiceInput,
  createdBy: string | null,
): Promise<{
  ok: true;
  id: string;
  reference: string;
  total_cents: number;
  emailed: boolean;
  /** True when this was a retry of a raise that had already landed. */
  already_raised: boolean;
  /**
   * What the invoice is actually for. Matters on `already_raised`: a manager
   * who changed the items after a failed attempt is handed back the invoice
   * that landed, which is the FIRST version, and has to be told what is on it.
   */
  summary: string;
}> {
  // A retry of a raise that already landed (its reply was lost) gets the same
  // invoice back and sends nothing: the first attempt sent the email.
  const submissionId = input.client_submission_id ?? null;
  const alreadyRaised = async () => {
    if (!submissionId) return null;
    const { data, error } = await admin
      .from("item_invoices")
      .select("id, payment_reference, total_cents, user_id, lines")
      .eq("client_submission_id", submissionId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // The same id for somebody else (or for a person since erased, whose
    // `user_id` went to null) is not a retry of this request. Refuse it rather
    // than hand back a stranger's invoice.
    if (data && data.user_id !== input.user_id)
      throw new ItemInvoiceConflictError(
        "That submission id was already used for a different invoice. Send a new one.",
      );
    return data
      ? {
          ok: true as const,
          id: data.id,
          reference: data.payment_reference,
          total_cents: data.total_cents,
          emailed: false,
          already_raised: true,
          summary: itemInvoiceSummary(parseItemInvoiceLines(data.lines)),
        }
      : null;
  };
  const earlier = await alreadyRaised();
  if (earlier) return earlier;

  // A person the club has a record of, not just any auth id: an invoice for an
  // id with no profile would have no name on any screen and nobody to email.
  const { data: person, error: pErr } = await admin
    .from("profiles")
    .select("user_id")
    .eq("user_id", input.user_id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!person)
    throw new ItemRecordNotFoundError("There is nobody on the club's records with that id.");

  const { data: catalogue, error: cErr } = await admin
    .from("charge_items")
    .select("id, name, price_cents")
    .in(
      "id",
      input.lines.map((l) => l.item_id),
    );
  if (cErr) throw new Error(cErr.message);
  const { lines, total_cents } = buildItemInvoiceLines(catalogue ?? [], input.lines);

  const { data: row, error } = await admin
    .from("item_invoices")
    .insert({
      user_id: input.user_id,
      lines,
      total_cents,
      created_by: createdBy,
      client_submission_id: submissionId,
    })
    .select("*")
    .single();
  // 23505 on the submission id: a first attempt still committing when this
  // retry arrived. It won, so answer with its invoice.
  if (error?.code === "23505" && submissionId) {
    const raced = await alreadyRaised();
    if (raced) return raced;
  }
  if (error || !row) throw new Error(error?.message || "That invoice was not raised. Try again.");

  let emailed = false;
  try {
    const recipient = await deliveryRecipientFor(admin, input.user_id);
    if (recipient.email) {
      const { sendItemInvoiceEmail } = await import("./membership-email.server");
      const result = await sendItemInvoiceEmail({
        invoiceId: row.id,
        memberGreetingName: recipient.greetingName,
        memberEmail: recipient.email,
        forName: recipient.forName,
        lines: lines.map((line) => ({
          description: describeItemInvoiceLine(line),
          amount: formatCents(lineTotalCents(line)),
        })),
        total: formatCents(total_cents),
        reference: row.payment_reference,
        admin,
      });
      emailed = result.sent;
    }
  } catch (e) {
    console.error(`[item-invoices] invoice ${row.id} was raised but its email failed:`, e);
  }

  return {
    ok: true,
    id: row.id,
    reference: row.payment_reference,
    total_cents,
    emailed,
    already_raised: false,
    summary: itemInvoiceSummary(lines),
  };
}

/**
 * Record that an item invoice has been paid, and send the receipt.
 *
 * The only writer of `paid_at`, reached by a manager marking it paid and by the
 * bank statement match. Compare-and-swap on it still being unpaid, so two
 * managers pressing at once, or a manual mark racing a statement import, record
 * one payment and send one receipt. A second call is a quiet no-op
 * (`recorded: false`), never an error: it is the normal result of a re-imported
 * statement. Refused on a cancelled invoice, which a manager withdrew.
 */
export async function recordItemInvoicePayment(
  admin: MembershipClient,
  input: { invoice: ItemInvoiceRow; method: "bank_transfer" | "manual"; at?: string },
): Promise<{ recorded: boolean }> {
  const { invoice } = input;
  if (invoice.paid_at) return { recorded: false };
  if (invoice.cancelled_at)
    throw new ItemInvoiceSettledError(
      "That invoice was cancelled, so there is nothing to pay on it. Raise a new one if it is still owed.",
    );

  const { data: claimed, error } = await admin
    .from("item_invoices")
    .update({ paid_at: input.at ?? new Date().toISOString(), payment_method: input.method })
    .eq("id", invoice.id)
    .is("paid_at", null)
    .is("cancelled_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  if (!claimed?.length) return { recorded: false };

  // After the write has committed, and never thrown: a failed receipt must not
  // report a recorded payment as a failure and invite a second one.
  if (invoice.user_id) {
    try {
      const recipient = await deliveryRecipientFor(admin, invoice.user_id);
      if (recipient.email) {
        const { sendItemInvoicePaidEmail } = await import("./membership-email.server");
        await sendItemInvoicePaidEmail({
          invoiceId: invoice.id,
          memberGreetingName: recipient.greetingName,
          memberEmail: recipient.email,
          forName: recipient.forName,
          reference: invoice.payment_reference,
          summary: itemInvoiceSummary(parseItemInvoiceLines(invoice.lines)),
          amount: formatCents(invoice.total_cents),
        });
      }
    } catch (e) {
      console.error(`[item-invoices] receipt for ${invoice.id} failed:`, e);
    }
  }
  return { recorded: true };
}

/**
 * Withdraw an unpaid invoice and keep the record. Idempotent on one already
 * cancelled. Sends nothing: it simply stops showing as owed.
 */
export async function cancelItemInvoiceRow(admin: MembershipClient, id: string): Promise<void> {
  const invoice = await readItemInvoice(admin, id);
  const settled = whyItemInvoiceIsSettled(invoice);
  if (settled) throw new ItemInvoiceSettledError(settled);
  if (invoice.cancelled_at) return;
  // Guarded on still being unpaid, so a payment that lands between the read
  // above and this write wins rather than being cancelled over.
  const { data, error } = await admin
    .from("item_invoices")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", id)
    .is("paid_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length)
    throw new ItemInvoiceSettledError(
      "That invoice was paid a moment ago, so it stays. Refresh the page to see it.",
    );
}

/** Remove an unpaid invoice outright, for one raised by mistake. */
export async function deleteItemInvoiceRow(admin: MembershipClient, id: string): Promise<void> {
  const invoice = await readItemInvoice(admin, id);
  const settled = whyItemInvoiceIsSettled(invoice);
  if (settled) throw new ItemInvoiceSettledError(settled);
  const { data, error } = await admin
    .from("item_invoices")
    .delete()
    .eq("id", id)
    .is("paid_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length)
    throw new ItemInvoiceSettledError(
      "That invoice was paid a moment ago, so it stays. Refresh the page to see it.",
    );
}

export const listItemInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listItemInvoicesSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return listItemInvoiceRows(await adminClient(), data);
  });

export const createItemInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createItemInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    return createItemInvoiceForUser(await adminClient(), data, context.userId);
  });

export const markItemInvoicePaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => markItemInvoicePaidSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const admin = await adminClient();
    const invoice = await readItemInvoice(admin, data.id);
    const { recorded } = await recordItemInvoicePayment(admin, {
      invoice,
      method: data.payment_method,
    });
    return { ok: true as const, id: data.id, recorded };
  });

export const cancelItemInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    await cancelItemInvoiceRow(await adminClient(), data.id);
    return { ok: true as const, id: data.id };
  });

export const deleteItemInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    await deleteItemInvoiceRow(await adminClient(), data.id);
    return { ok: true as const, id: data.id };
  });

// ---------------------------------------------------------------- the member

/**
 * One person's item invoices, for their own membership page: every state, so
 * a paid one stays visible as a record and a cancelled one as withdrawn.
 *
 * `userId` names the person, the same `?for=` the rest of `/membership` takes,
 * and `resolveSubject` is the gate: a caller can read their own and their
 * dependants', and nobody else's.
 */
export const getMyItemInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => householdTargetSchema.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<ItemInvoiceView[]> => {
    const admin = await adminClient();
    const subjectId = await resolveSubject(admin, context.userId, data.userId);
    const { data: rows, error } = await admin
      .from("item_invoices")
      .select("*")
      .eq("user_id", subjectId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (rows ?? []).map(projectItemInvoice);
  });

/**
 * What everybody on an account still owes in item invoices, per person, as
 * transfers in the shape the "How to pay" panel draws. Read by
 * `listHouseholdInvoices`, which folds these in beside the membership invoices
 * so the panel stays one list.
 *
 * Throws on a failed read, for the reason that function does: an empty answer
 * here tells a parent they owe nothing.
 */
export async function unpaidItemInvoicesByPerson(
  admin: MembershipClient,
  userIds: string[],
): Promise<Map<string, UnpaidInvoice[]>> {
  const byPerson = new Map<string, UnpaidInvoice[]>();
  if (!userIds.length) return byPerson;
  const { data, error } = await admin
    .from("item_invoices")
    .select("*")
    .in("user_id", userIds)
    .is("paid_at", null)
    .is("cancelled_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    if (!row.user_id) continue;
    const list = byPerson.get(row.user_id) ?? [];
    list.push(itemInvoiceAsUnpaid({ ...row, lines: parseItemInvoiceLines(row.lines) }));
    byPerson.set(row.user_id, list);
  }
  return byPerson;
}

// ------------------------------------------------------ the bank statement

/**
 * Settle unpaid item invoices from unmatched statement lines. Called by
 * `reconcileUnmatched` with the lines the membership pass did not take, so a
 * membership keeps first claim on a transfer and one line never pays two
 * things.
 *
 * A line pays an invoice when it carries the reference as a whole word and
 * exactly the total (`statementLinePaysItemInvoice`). A line that fits more
 * than one invoice is left for a manager rather than guessed at. One invoice
 * failing must not stop the rest of the statement, the same rule as the
 * membership pass.
 *
 * Returns the ids of the transactions it matched.
 */
export async function settleItemInvoicesFromStatement(
  admin: MembershipClient,
  txns: readonly BankTransactionRow[],
): Promise<Set<string>> {
  const matched = new Set<string>();
  if (!txns.length) return matched;
  const { data: open, error } = await admin
    .from("item_invoices")
    .select("*")
    .is("paid_at", null)
    .is("cancelled_at", null);
  if (error) throw new Error(error.message);
  const remaining = new Map((open ?? []).map((inv) => [inv.id, inv]));

  for (const txn of txns) {
    const haystack = `${txn.description} ${txn.reference ?? ""}`;
    const hits = [...remaining.values()].filter((inv) =>
      statementLinePaysItemInvoice(haystack, txn.amount_cents, inv),
    );
    if (hits.length !== 1) {
      if (hits.length > 1)
        console.warn(
          `[reconcile] transaction ${txn.id} fits ${hits.length} item invoices; leaving for manual match`,
        );
      continue;
    }
    const invoice = hits[0];
    try {
      const { recorded } = await recordItemInvoicePayment(admin, {
        invoice,
        method: "bank_transfer",
      });
      // Paid by somebody else between the read above and this write (a manager
      // marking it paid for cash, most likely). This line is then a SECOND
      // payment for the same invoice, and marking it matched would hide the
      // member's double payment as reconciled. Leave it for a manager.
      if (!recorded) {
        remaining.delete(invoice.id);
        console.warn(
          `[reconcile] item invoice ${invoice.id} was already paid; transaction ${txn.id} left for a manager`,
        );
        continue;
      }
    } catch (e) {
      console.error(
        `[reconcile] recording the payment failed for item invoice ${invoice.id} (transaction ${txn.id}):`,
        e,
      );
      continue;
    }
    const { error: tErr } = await admin
      .from("bank_transactions")
      .update({
        matched_item_invoice_id: invoice.id,
        matched_at: new Date().toISOString(),
        status: "matched",
      })
      .eq("id", txn.id);
    if (tErr) {
      console.error(`[reconcile] could not mark transaction ${txn.id} matched:`, tErr.message);
      continue;
    }
    remaining.delete(invoice.id);
    matched.add(txn.id);
  }
  return matched;
}

/**
 * Link one statement line to one item invoice by hand, recording the payment.
 * The manual counterpart to the match above, from `/manager/reconciliation`.
 */
export async function matchTransactionToItemInvoice(
  admin: MembershipClient,
  input: { transactionId: string; invoiceId: string; matchedBy: string },
): Promise<void> {
  // The transfer first: it has to exist and still be free, or the payment
  // below would be recorded against nothing.
  const { data: txn, error: tErr } = await admin
    .from("bank_transactions")
    .select("id, status")
    .eq("id", input.transactionId)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!txn)
    throw new ItemRecordNotFoundError("That transfer is no longer there. Refresh the page.");
  if (txn.status !== "unmatched")
    throw new ItemInvoiceConflictError(
      "That transfer has already been matched. Refresh the page to see what it paid.",
    );

  const invoice = await readItemInvoice(admin, input.invoiceId);
  const { recorded } = await recordItemInvoicePayment(admin, { invoice, method: "bank_transfer" });
  // Already paid: this transfer would be a second payment for it, which is a
  // refund to sort out, not a match. Linking it would hide the money.
  if (!recorded)
    throw new ItemInvoiceConflictError(
      `Invoice ${invoice.payment_reference} is already paid, so this transfer was not linked to it. If they paid twice, it needs refunding.`,
    );

  const { error } = await admin
    .from("bank_transactions")
    .update({
      matched_item_invoice_id: invoice.id,
      matched_at: new Date().toISOString(),
      matched_by: input.matchedBy,
      status: "matched",
    })
    .eq("id", input.transactionId)
    .eq("status", "unmatched");
  if (error) throw new Error(error.message);
}

export const matchTransactionToItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => matchTransactionToItemInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    await matchTransactionToItemInvoice(await adminClient(), {
      transactionId: data.transaction_id,
      invoiceId: data.item_invoice_id,
      matchedBy: context.userId,
    });
    return { ok: true as const };
  });
