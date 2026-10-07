-- Charging for items: a price list, and invoices raised against a person.
--
-- The club sells odds and ends that are not a membership (a gi, a patch, a
-- grading fee). A manager keeps a short list of them, each a name and a price,
-- and raises an invoice for one or more of them against somebody. The invoice
-- is emailed, shows on the member's own membership page, and is settled the
-- same way a membership invoice is: a bank transfer quoting its reference
-- (matched on statement import), or a manager marking it paid. Product spec:
-- docs/item-invoices.md.
--
-- Deliberately NOT a membership row. A membership is permission to train with
-- dates and credits, and every reader of `memberships` (check-in coverage, the
-- member label, the lifecycle phase) would have to learn to skip an invoice for
-- a pair of shorts. So these are their own two tables, and the only shared
-- thing is the bank statement, which learns to point at either.
--
-- All three objects are CLOSED to the client roles, like almost every table
-- here: every read and write goes through a server function on the service-role
-- client, behind the manager gate or the household gate. The policies below are
-- defence in depth for the day a grant is added back (docs/database.md, "What
-- the schema scanners make of a closed table"), and they encode the narrowest
-- rule the app enforces: managers only.
--
-- Additive only. Nothing that is live today reads any of it.

-- ---------- the price list ----------

CREATE TABLE IF NOT EXISTS public.charge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT charge_items_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- A free item is not something to invoice, and $10,000 is well past anything
  -- a club sells. The same bounds as the form, so a write through the agent API
  -- cannot store what the screen would refuse.
  CONSTRAINT charge_items_price_range CHECK (price_cents BETWEEN 1 AND 1000000)
);

COMMENT ON TABLE public.charge_items IS
  'Things the club charges for that are not a membership: a name and a price. '
  'Removing one is a plain DELETE: an invoice copies the name and price it was '
  'raised with into its own lines, so nothing points back here.';

-- ---------- the invoices ----------

CREATE TABLE IF NOT EXISTS public.item_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The invoice number, and the only source of its reference below.
  invoice_number BIGINT GENERATED ALWAYS AS IDENTITY,
  -- What the member quotes on the transfer. Derived from the number so it is
  -- unique by construction and nobody has to mint one: two invoices for the
  -- same person can be outstanding at once, so a per-person reference (the
  -- shape membership invoices use) could not tell them apart on a statement.
  payment_reference TEXT GENERATED ALWAYS AS ('INV' || lpad(invoice_number::text, 4, '0')) STORED,
  -- Who it is for. ON DELETE SET NULL to match memberships.user_id: erasing a
  -- person keeps the club's record that money was owed or paid.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A frozen copy of what was charged, one entry per line:
  --   { "name": text, "unit_price_cents": int, "quantity": int }
  -- Copied, not referenced, so renaming, repricing or removing an item never
  -- changes an invoice somebody has already been sent.
  lines JSONB NOT NULL,
  -- Every line added up, stored so the bank match and every list read one
  -- number rather than re-summing a JSON array in each place.
  total_cents INTEGER NOT NULL,
  paid_at TIMESTAMPTZ,
  payment_method TEXT,
  cancelled_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT item_invoices_lines_shape CHECK (
    jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 20
  ),
  CONSTRAINT item_invoices_total_positive CHECK (total_cents > 0),
  CONSTRAINT item_invoices_payment_method CHECK (
    payment_method IS NULL OR payment_method IN ('bank_transfer', 'manual')
  ),
  -- Money arriving is what makes an invoice permanent, so a paid invoice is
  -- never also cancelled: the two states would disagree about what is owed.
  CONSTRAINT item_invoices_paid_or_cancelled CHECK (paid_at IS NULL OR cancelled_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS item_invoices_payment_reference_key
  ON public.item_invoices (payment_reference);
CREATE INDEX IF NOT EXISTS item_invoices_user_id_idx
  ON public.item_invoices (user_id);
-- The bank match and the "unpaid charges" list both ask for exactly this.
CREATE INDEX IF NOT EXISTS item_invoices_outstanding_idx
  ON public.item_invoices (created_at)
  WHERE paid_at IS NULL AND cancelled_at IS NULL;

COMMENT ON TABLE public.item_invoices IS
  'An invoice for one or more charge_items, raised by a manager against a '
  'person. Unpaid = paid_at IS NULL AND cancelled_at IS NULL. Lines are a '
  'frozen copy of what was charged, never a reference to the price list.';

-- ---------- the bank statement can settle one ----------

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS matched_item_invoice_id UUID;

-- Added separately, not inline, so a half-applied first attempt cannot leave
-- the column without its foreign key (same reasoning as
-- 20260827000000_household_guardian_link.sql). SET NULL because an invoice is
-- only ever deleted while unpaid, and a matched transaction means it was paid,
-- so in practice nothing is ever orphaned.
ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_matched_item_invoice_id_fkey;
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_matched_item_invoice_id_fkey
    FOREIGN KEY (matched_item_invoice_id) REFERENCES public.item_invoices(id)
    ON DELETE SET NULL;

-- ---------- closed to the client roles ----------
--
-- GRANT cannot narrow what Supabase's default privileges hand every new table;
-- only REVOKE can (docs/database-changes.md).

REVOKE ALL ON public.charge_items FROM anon, authenticated;
REVOKE ALL ON public.item_invoices FROM anon, authenticated;

ALTER TABLE public.charge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Managers manage charge items" ON public.charge_items;
CREATE POLICY "Managers manage charge items"
  ON public.charge_items
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers manage item invoices" ON public.item_invoices;
CREATE POLICY "Managers manage item invoices"
  ON public.item_invoices
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
