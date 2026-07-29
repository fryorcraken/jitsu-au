-- Make the UTS Jitsu Application Form the waiver people actually sign.
--
-- `20260729010000_waiver_application_form.sql` inserted that template as a
-- DRAFT (`is_current = false`) so a human would read it before it went live.
-- This is that promotion. Nothing else changes: no columns, no policies, no
-- grants — one row loses the flag and one row gains it.
--
-- Waivers already signed are untouched. `waivers.template_version` records the
-- version each one was signed against, and the signed PDF carries the full text
-- of that version, so promoting a new template never rewrites what anyone
-- agreed to.
--
-- The partial unique index `waiver_templates_only_one_current` allows exactly
-- one `is_current = true` row, so this is necessarily demote-then-promote. Both
-- statements run inside this DO block (one transaction), so the site never sees
-- the moment in between where no template is current and `/waiver` would refuse
-- to render.
--
-- Idempotent: re-running it is a no-op once the application form is current.

DO $$
DECLARE
  target uuid;
BEGIN
  SELECT id INTO target
  FROM public.waiver_templates
  WHERE title = 'UTS Jitsu Application Form'
  ORDER BY version DESC
  LIMIT 1;

  -- Fail loudly rather than demoting the live waiver and leaving the club with
  -- none: no target means 20260729010000 never reached this database.
  IF target IS NULL THEN
    RAISE EXCEPTION
      'No "UTS Jitsu Application Form" template row found. Apply 20260729010000_waiver_application_form.sql first.';
  END IF;

  UPDATE public.waiver_templates
  SET is_current = false
  WHERE is_current = true
    AND id <> target;

  UPDATE public.waiver_templates
  SET is_current = true
  WHERE id = target
    AND is_current = false;
END
$$;
