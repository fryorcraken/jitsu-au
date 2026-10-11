DROP POLICY IF EXISTS "Signed-in people can read knowledge base sections" ON public.kb_sections;
CREATE POLICY "Signed-in people can read knowledge base sections"
  ON public.kb_sections FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);