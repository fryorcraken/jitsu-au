-- Make the UTS Jitsu Application Form the waiver people sign, and drop the
-- short waiver it replaces.
--
-- `20260729010000_waiver_application_form.sql` inserted the application form as
-- a DRAFT (`is_current = false`) so a human would read it before it went live.
-- This is that promotion, plus the cleanup that goes with it.
--
-- Dropping the old version is a PRE-LAUNCH tidy-up: the site is not taking real
-- signatures yet, so nothing signed against the old template matters. It is not
-- a precedent. Once the club is live, the reason to keep an old version is
-- narrow but real: a waiver whose PDF failed to generate (`pdf_path IS NULL`, a
-- handled failure path in `submitWaiverWithPdf`) has nothing but
-- `template_version` to say what its signer agreed to. Every waiver that DOES
-- have its PDF carries that version's full text inside it, so the row is not
-- the evidence.
--
-- The partial unique index `waiver_templates_only_one_current` allows exactly
-- one `is_current = true` row, so promotion is necessarily demote-then-promote.
-- Every statement here runs inside one DO block (one transaction), so the site
-- never sees the moment in between where no template is current and `/waiver`
-- would refuse to render.
--
-- Idempotent: re-running it is a no-op once the application form is the only
-- template left.

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

  -- Nothing points at these rows — `waivers.template_version` is a plain int,
  -- not a foreign key — so this leaves the application form as the one and only
  -- version.
  DELETE FROM public.waiver_templates
  WHERE id <> target;
END
$$;
