ALTER TABLE public.waivers ADD COLUMN IF NOT EXISTS sms_whatsapp_consent BOOLEAN NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';