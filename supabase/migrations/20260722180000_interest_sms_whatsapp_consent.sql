-- Record SMS / WhatsApp contact consent on interest registrations.
--
-- The interest form's phone field carries an informational consent note, so
-- giving a number there is implicit consent to be contacted by SMS or WhatsApp
-- and added to club WhatsApp groups. We store that so later forms (e.g. the
-- waiver) can prefill their consent checkbox. Existing rows default to false;
-- no backfill.

ALTER TABLE public.interest_registrations
  ADD COLUMN IF NOT EXISTS sms_whatsapp_consent BOOLEAN NOT NULL DEFAULT false;
