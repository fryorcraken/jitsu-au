-- Waiver approval workflow.
--
-- Managers manually review each signed waiver and either leave it pending or
-- approve it. Approval is the member-facing status that gates training, so it
-- lives on the waiver row (there is no separate members table — a "member" is
-- a person's signed waiver + optional auth user).
--
--   approval_status  'pending' (default) | 'approved'
--   approved_at      when it was approved (NULL while pending)
--   approved_by      which manager approved it (NULL while pending)

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Constrain the status to the known values. Guard the ADD so re-running the
-- migration (or a partially applied one) doesn't error on a duplicate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'waivers_approval_status_check'
  ) THEN
    ALTER TABLE public.waivers
      ADD CONSTRAINT waivers_approval_status_check
      CHECK (approval_status IN ('pending', 'approved'));
  END IF;
END $$;

-- Managers approve/unapprove via the service-role server function, but grant a
-- manager RLS UPDATE path too for defense in depth (the server function still
-- checks has_role before writing).
GRANT UPDATE ON public.waivers TO authenticated;

DROP POLICY IF EXISTS "Managers can update waivers" ON public.waivers;
CREATE POLICY "Managers can update waivers" ON public.waivers
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
