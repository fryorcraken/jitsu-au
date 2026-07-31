-- Public Storage bucket for blog post images (cover photos, inline photos).
-- Videos are embedded by link (YouTube/Vimeo), never uploaded, so this bucket
-- only ever holds images.
--
-- Unlike `waivers`, this bucket is PUBLIC: blog photos are marketing content,
-- meant to be seen by anyone who loads the post, so there is no signed-URL
-- indirection on read. Object names are `<post id>/<filename>` so an image can
-- be traced back to the post that owns it; an image uploaded while composing a
-- brand-new (not-yet-saved) post goes under `drafts/<filename>` instead.

INSERT INTO storage.buckets (id, name, public)
VALUES ('blog-media', 'blog-media', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Clear any dashboard-created legacy policy scoped to this bucket, so the
-- policies below are the whole story (same idiom as the waivers bucket).
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (COALESCE(qual, '') || ' ' || COALESCE(with_check, '')) LIKE '%''blog-media''%'
  LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', pol.policyname);
    RAISE NOTICE 'Dropped pre-existing blog-media storage policy: %', pol.policyname;
  END LOOP;
END $$;

-- Reads: no SELECT policy at all, on purpose. The bucket is public, so
-- Storage already serves any object's bytes by URL with no RLS involved.
-- A broad "anyone can SELECT" policy would additionally let a client LIST the
-- bucket's contents via the REST/API path — enumerating every filed image —
-- which is exactly the `public_bucket_allows_listing` advisor finding warns
-- about, and nothing in the app needs directory listing.
--
-- Writes: managers only. The app always uploads through the service role
-- (uploadBlogImage), so these are defence in depth, same reasoning as the
-- waiver PDF write policies.
DROP POLICY IF EXISTS "Managers can upload blog media" ON storage.objects;
CREATE POLICY "Managers can upload blog media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'blog-media' AND public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers can update blog media" ON storage.objects;
CREATE POLICY "Managers can update blog media" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'blog-media' AND public.has_role(auth.uid(), 'manager'))
  WITH CHECK (bucket_id = 'blog-media' AND public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers can delete blog media" ON storage.objects;
CREATE POLICY "Managers can delete blog media" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'blog-media' AND public.has_role(auth.uid(), 'manager'));
