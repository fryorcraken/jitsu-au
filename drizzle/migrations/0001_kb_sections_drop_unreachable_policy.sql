-- kb_sections is read and written only by server code on the service role,
-- which bypasses RLS. anon and authenticated hold no table grant, so the
-- signed-in SELECT policy could never be reached. Dropping it leaves the table
-- default-deny for every client role, which is what the grants already say.
DROP POLICY IF EXISTS "Signed-in people can read knowledge base sections" ON public.kb_sections;