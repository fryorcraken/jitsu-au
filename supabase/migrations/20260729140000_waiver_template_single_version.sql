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
-- Idempotent, and safe to re-run at any later date: the promotion is a no-op
-- once the application form is live, and the deletion names the one row it is
-- meant to remove, so versions saved after this ran are never touched.

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

  -- Enforce the premise this migration is written on, rather than trusting the
  -- comment above to still be true whenever a human gets round to applying it.
  --
  -- A signed waiver normally carries its own PDF with the full template text, so
  -- deleting the row it was signed against loses nothing. The exception is a
  -- waiver whose PDF never generated (`pdf_path IS NULL`, a handled failure path
  -- in `submitWaiverWithPdf`): `template_version` is then the only pointer to
  -- what its signer agreed to, and deleting that row destroys the last record of
  -- it. Refuse instead, and let a person decide.
  IF EXISTS (
    SELECT 1
    FROM public.waivers w
    WHERE w.pdf_path IS NULL
      AND w.template_version IN (
        SELECT version FROM public.waiver_templates WHERE id <> target
      )
  ) THEN
    RAISE EXCEPTION
      'A signed waiver with no PDF still points at a template version this would delete. Resolve that waiver before running this.';
  END IF;

  -- Delete the short waiver this replaces, BY NAME.
  --
  -- Not `id <> target`: this migration ships alongside the screen that makes
  -- saving new versions routine, so a re-run months later would take "everything
  -- that is not the application form" to mean the club's current legal document
  -- and silently delete it. Naming the row it is meant to remove keeps a re-run
  -- a genuine no-op no matter what has been added since.
  --
  -- Safe to delete: `waivers.template_version` is a plain int, not a foreign key.
  DELETE FROM public.waiver_templates
  WHERE id <> target
    AND title = 'UTS Jitsu Training Waiver';
END
$$;
