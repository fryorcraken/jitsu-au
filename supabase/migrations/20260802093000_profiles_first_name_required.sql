-- profiles.first_name becomes mandatory, so a person always has a name to show.
--
-- Until now the only guarantee was that a row EXISTS for every auth user (the
-- ensure_profile trigger below); the row could carry no name at all, which is
-- what the bare "Member" fallback on a blog comment
-- (commentDisplayName in src/lib/validation.ts) is showing.
--
-- Both in-product paths that create a person already require a first name
-- (waiverSubmitSchema, paperWaiverUploadSchema), so the only rows without one
-- come from auth users created out of band: the Supabase dashboard, an invite,
-- or anything predating the trigger.

-- ---------- 1. backfill, so the constraint can hold ----------
-- The best name available for a row that has none, in order: what the auth user
-- was created with, then the local part of their email, then the same word the
-- app was already displaying for them. `profiles.user_id` references
-- auth.users(id), so the join always finds its row.
UPDATE public.profiles p
SET first_name = COALESCE(
      NULLIF(btrim(u.raw_user_meta_data ->> 'first_name'), ''),
      NULLIF(btrim(u.raw_user_meta_data ->> 'name'), ''),
      NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
      'Member'
    ),
    updated_at = now()
FROM auth.users u
WHERE u.id = p.user_id
  AND (p.first_name IS NULL OR btrim(p.first_name) = '');

-- ---------- 2. the constraint ----------
-- NOT NULL alone would still admit '' (and '' derives the same "Member"), so
-- the blank check is what actually makes the column mean something.
ALTER TABLE public.profiles
  ALTER COLUMN first_name SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_first_name_not_blank'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_first_name_not_blank CHECK (btrim(first_name) <> '');
  END IF;
END
$$;

-- ---------- 3. teach the trigger to supply one ----------
-- ensure_profile inserted (user_id) alone, which a NOT NULL first_name would
-- now reject — and because it fires AFTER INSERT ON auth.users, that rejection
-- aborts the insert, i.e. every auth.admin.createUser (waiver submission
-- included) would start failing. It seeds the same fallback chain as the
-- backfill instead, so account creation can never be blocked by a missing name.
--
-- The waiver path overwrites this with the real submitted name moments later
-- (resolvePersonId's upsert), so the seed only ever survives for an auth user
-- created outside the product.
CREATE OR REPLACE FUNCTION public.ensure_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, first_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(btrim(NEW.raw_user_meta_data ->> 'first_name'), ''),
      NULLIF(btrim(NEW.raw_user_meta_data ->> 'name'), ''),
      NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
      'Member'
    )
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger-only function: not callable through the public PostgREST RPC surface.
REVOKE EXECUTE ON FUNCTION public.ensure_profile() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
