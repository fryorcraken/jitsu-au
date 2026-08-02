-- profiles.first_name becomes mandatory, so a person always has a name to show.
--
-- Two gaps stood between the app and that, and both are closed here:
--   * a profile row could carry no name at all, which is what the bare "Member"
--     fallback on a blog comment (commentDisplayName in src/lib/validation.ts)
--     is showing; and
--   * an auth user could have no profile row at all. ensure_profile
--     (20260723000000_profiles.sql) only fires on INSERT and nothing ever
--     backfilled the auth users that already existed, so every account created
--     before it — the dashboard-made manager accounts — has none. Those people
--     read as "Member" no matter what the column allows, since there is no row
--     for a constraint to hold.
--
-- Both in-product paths that create a person already require a first name
-- (waiverSubmitSchema, paperWaiverUploadSchema), so everything touched below is
-- an auth user created out of band: the Supabase dashboard, an invite, or
-- anything predating the trigger.
--
-- Statement order matters. The function is replaced FIRST: the moment
-- first_name is NOT NULL, the old ensure_profile body (INSERT ... (user_id)
-- alone) violates it, and because it fires AFTER INSERT ON auth.users that
-- violation aborts the insert — every auth.admin.createUser fails, public
-- waiver signing included. Applied statement-by-statement in the other order,
-- that is a live outage between the two statements.

-- ---------- 1. teach the trigger to supply a name ----------
-- The name an out-of-band auth user arrives with, else the same word the app
-- was already displaying for them. Deliberately NOT the local part of their
-- email: this value is shown publicly (blog comments) and is used to greet them
-- in email, and nobody chose it — "Hi jane.doe1987" is worse than "Hi Member",
-- and publishing part of someone's address on a public page is worse still.
--
-- The waiver path overwrites the seed with the real submitted name moments
-- later (resolvePersonId's upsert), so it only survives for an auth user
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
      'Member'
    )
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger-only function: not callable through the public PostgREST RPC surface.
REVOKE EXECUTE ON FUNCTION public.ensure_profile() FROM PUBLIC, anon, authenticated;

-- ---------- 2. backfill: the rows that never existed ----------
-- Every auth user gets the row the trigger would have made for them.
INSERT INTO public.profiles (user_id, first_name)
SELECT u.id,
       COALESCE(
         NULLIF(btrim(u.raw_user_meta_data ->> 'first_name'), ''),
         NULLIF(btrim(u.raw_user_meta_data ->> 'name'), ''),
         'Member'
       )
FROM auth.users u
LEFT JOIN public.profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- ---------- 3. backfill: the rows that exist without a name ----------
-- `profiles.user_id` references auth.users(id), so the join always finds its row.
UPDATE public.profiles p
SET first_name = COALESCE(
      NULLIF(btrim(u.raw_user_meta_data ->> 'first_name'), ''),
      NULLIF(btrim(u.raw_user_meta_data ->> 'name'), ''),
      'Member'
    ),
    updated_at = now()
FROM auth.users u
WHERE u.id = p.user_id
  AND (p.first_name IS NULL OR btrim(p.first_name) = '');

-- ---------- 4. the constraint ----------
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

NOTIFY pgrst, 'reload schema';
