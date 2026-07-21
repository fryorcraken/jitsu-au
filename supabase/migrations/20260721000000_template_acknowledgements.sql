-- Manager-configurable waiver acknowledgements.
--
-- Acknowledgements were hardcoded in the app. Store them on the template so
-- managers can edit the checkboxes (label + required) like the rest of the
-- waiver, and drop the now-duplicated acknowledgement prose from the body.

ALTER TABLE public.waiver_templates
  ADD COLUMN acknowledgements JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.waiver_templates
SET
  acknowledgements = $json$[
    {
      "id": "risk",
      "label": "I understand that Japanese Jiu-Jitsu involves physical contact and risk of injury, and I participate voluntarily at my own risk.",
      "required": true
    },
    {
      "id": "release",
      "label": "I release {{club_name}}, its instructors and training partners from liability for injuries sustained during training, except where caused by gross negligence.",
      "required": true
    },
    {
      "id": "media",
      "label": "I consent to photos and video taken during class being used for club promotion on social media and the club website.",
      "required": false
    }
  ]$json$::jsonb,
  body_md = $md$# UTS Jitsu Training Waiver

**Participant:** {{full_name}}
**Date of birth:** {{date_of_birth}}
**Address:** {{address}}
**Phone:** {{phone}}
**Email:** {{email}}

**Emergency contact:** {{emergency_contact_name}} ({{emergency_contact_phone}})

**Medical notes:** {{medical_notes}}

---

Signed by **{{signature_name}}** on {{signed_date}}.
$md$
WHERE is_current = true;
