-- Record SMS / WhatsApp contact consent on the waiver.
--
-- On the waiver form the consent is an explicit checkbox (on the earlier
-- interest form it is just informational text). We store the member's choice so
-- the club knows who agreed to be contacted by SMS or WhatsApp and added to club
-- WhatsApp groups. Defaults to false for existing rows (consent was never asked
-- there); the app always sends an explicit value going forward.

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS sms_whatsapp_consent BOOLEAN NOT NULL DEFAULT false;
