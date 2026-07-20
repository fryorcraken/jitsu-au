
-- waiver_templates table
CREATE TABLE public.waiver_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  version INT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Training Waiver',
  body_md TEXT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version)
);
CREATE UNIQUE INDEX waiver_templates_only_one_current ON public.waiver_templates (is_current) WHERE is_current = true;

GRANT SELECT ON public.waiver_templates TO anon, authenticated;
GRANT INSERT, UPDATE ON public.waiver_templates TO authenticated;
GRANT ALL ON public.waiver_templates TO service_role;

ALTER TABLE public.waiver_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read current template" ON public.waiver_templates
  FOR SELECT USING (is_current = true);
CREATE POLICY "Managers can read all templates" ON public.waiver_templates
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can insert templates" ON public.waiver_templates
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update templates" ON public.waiver_templates
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

-- Seed version 1
INSERT INTO public.waiver_templates (version, title, body_md, is_current) VALUES (
1,
'UTS Jitsu Training Waiver',
$md$# UTS Jitsu Training Waiver

**Participant:** {{full_name}}
**Date of birth:** {{date_of_birth}}
**Address:** {{address}}
**Phone:** {{phone}}
**Email:** {{email}}

**Emergency contact:** {{emergency_contact_name}} ({{emergency_contact_phone}})

**Medical notes:** {{medical_notes}}

## Acknowledgement of risk

I understand that Japanese Jiu-Jitsu involves physical contact and risk of injury, and I participate voluntarily at my own risk.

## Release of liability

I release {{club_name}}, its instructors and training partners from liability for injuries sustained during training, except where caused by gross negligence.

## Media consent (optional)

I may consent to photos and video taken during class being used for club promotion on social media and the club website.

---

Signed by **{{signature_name}}** on {{signed_date}}.
$md$,
true
);

-- Extend waivers table
ALTER TABLE public.waivers
  ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN template_version INT,
  ADD COLUMN pdf_path TEXT,
  ADD COLUMN ip_hash TEXT;

-- Owner + manager read policies
CREATE POLICY "Users can view their own waivers" ON public.waivers
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can view all waivers" ON public.waivers
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- Allow service_role writes for PDF path update
GRANT SELECT ON public.waivers TO authenticated;
GRANT ALL ON public.waivers TO service_role;
