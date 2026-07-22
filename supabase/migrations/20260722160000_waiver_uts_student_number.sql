-- Collect the UTS student number on the waiver.
--
-- Student status is trust-based and has no separate boolean flag: a non-empty
-- `uts_student_number` means the person is a UTS student, which unlocks the
-- discounted student rate when they join (mirrors the same rule already on
-- `memberships`). It is optional, so the column is plain nullable TEXT.

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS uts_student_number TEXT;
