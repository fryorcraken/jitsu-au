-- Club settings: a small manager-editable key/value store.
--
-- First use: the markdown "payment instructions" shown on membership invoices
-- (the payment email). The club sets whatever they want here — bank transfer
-- details, PayID, a note — and the app renders it verbatim; it is not parsed,
-- so there are no structured bank columns. Generic on purpose so future
-- settings can reuse the same table.
CREATE TABLE public.club_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

GRANT SELECT, INSERT, UPDATE ON public.club_settings TO authenticated;
GRANT ALL ON public.club_settings TO service_role;

ALTER TABLE public.club_settings ENABLE ROW LEVEL SECURITY;

-- Manager-only. Values render in server-generated emails via the service role,
-- so there is no need for an anon/public read policy.
CREATE POLICY "Managers can read settings" ON public.club_settings
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can insert settings" ON public.club_settings
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update settings" ON public.club_settings
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Seed the invoice payment instructions with a stub prompting the club to edit.
INSERT INTO public.club_settings (key, value) VALUES (
  'invoice_payment_instructions',
  $md$Pay by bank transfer to:

**Account name:** _add your account name_
**BSB:** _add BSB_
**Account number:** _add account number_

Please include your payment reference (above) in the transfer description so we can match your payment automatically.$md$
);
