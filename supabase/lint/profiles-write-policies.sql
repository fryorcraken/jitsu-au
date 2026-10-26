-- Every RLS policy that could let a client role write to public.profiles.
-- Expected result: no rows. supabase-lint.yml runs it against the migration
-- replay and fails on any row; supabase/lint/README.md has it run by hand
-- against the live database too, since a policy added in the Lovable UI never
-- reaches a pull request.
--
-- profiles holds every person's household link, date of birth, medical notes
-- and archive mark, and every write to it goes through a service-role server
-- function. A client write policy there does nothing until somebody grants a
-- client role a write privilege, and then lets a member rewrite their own row
-- past every check the server applies (docs/database.md, profiles).
--
-- Only PERMISSIVE policies open anything: a RESTRICTIVE one can only narrow.
-- Only policies that apply to a client role count: anon, authenticated, or
-- PUBLIC (which every role inherits). A policy for service_role is moot,
-- since that role bypasses RLS.
SELECT policyname, cmd, roles::text
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'profiles'
   AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
   AND permissive = 'PERMISSIVE'
   AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
 ORDER BY 1;
