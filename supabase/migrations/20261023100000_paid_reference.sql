-- What a recorded payment was known by: a receipt number for cash at the door,
-- the transfer's own reference when it was settled outside the statement match.
--
-- A manager marking an invoice paid by hand is writing down money the bank
-- reconciler never saw, and until now the only thing that survived of it was a
-- timestamp and `payment_method = 'manual'`. When the club's books are checked
-- later, "which receipt was this?" had no answer anywhere. This column is that
-- answer, on both kinds of invoice, written once by the same writer that
-- records the payment (`recordMembershipPayment` / `recordItemInvoicePayment`).
--
-- Deliberately NOT `payment_reference`. That column, on both tables, is what the
-- member is asked to quote on a transfer and what the statement match looks
-- for; overwriting it with a receipt number would stop an invoice ever being
-- matched to its own transfer. The two answer different questions and stay
-- separate.
--
-- Free text, optional, and only meaningful once paid: a reference with no
-- payment would be a note about money that has not arrived. 200 characters is
-- the same bound the form and the agent API enforce, so a write cannot store
-- what the screen would refuse.
--
-- Additive only. Both tables are already closed to the client roles (every read
-- and write is a service-role server function), and a new column inherits that,
-- so client-grants-expected.txt needs no new line.

ALTER TABLE public.memberships
  ADD COLUMN IF NOT EXISTS paid_reference TEXT;

ALTER TABLE public.item_invoices
  ADD COLUMN IF NOT EXISTS paid_reference TEXT;

-- Dropped and re-added rather than `ADD CONSTRAINT IF NOT EXISTS`, which
-- Postgres does not have, so the file is safe to re-run.
ALTER TABLE public.memberships
  DROP CONSTRAINT IF EXISTS memberships_paid_reference_shape;
ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_paid_reference_shape CHECK (
    paid_reference IS NULL
    OR (paid_at IS NOT NULL AND char_length(btrim(paid_reference)) BETWEEN 1 AND 200)
  );

ALTER TABLE public.item_invoices
  DROP CONSTRAINT IF EXISTS item_invoices_paid_reference_shape;
ALTER TABLE public.item_invoices
  ADD CONSTRAINT item_invoices_paid_reference_shape CHECK (
    paid_reference IS NULL
    OR (paid_at IS NOT NULL AND char_length(btrim(paid_reference)) BETWEEN 1 AND 200)
  );

COMMENT ON COLUMN public.memberships.paid_reference IS
  'What the recorded payment was known by (a receipt number, a transfer '
  'reference), as entered by the manager who recorded it. Not the reference '
  'the member quotes: that is payment_reference.';
COMMENT ON COLUMN public.item_invoices.paid_reference IS
  'What the recorded payment was known by (a receipt number, a transfer '
  'reference), as entered by the manager who recorded it. Not the reference '
  'the member quotes: that is payment_reference.';
