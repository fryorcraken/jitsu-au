-- Explicit RLS for the private `waivers` Storage bucket.
--
-- The bucket holds the signed waiver PDFs: full name, date of birth, address,
-- phone, emergency contact and **medical notes**, plus the signature images
-- rendered into the document. Until now the bucket was provisioned outside SQL
-- (Lovable/dashboard) and this directory carried no `storage.objects` policies
-- at all, so who can read those PDFs was unversioned and unreviewable — it
-- depended entirely on whatever was clicked into the dashboard, including
-- whether the bucket is public (a public bucket serves objects over an
-- unguessable-but-permanent URL and bypasses SELECT RLS entirely).
--
-- This migration makes the bucket's access model part of the schema:
--   1. the bucket exists and is PRIVATE,
--   2. any legacy, dashboard-created policy for it is cleared,
--   3. reads are scoped to the waiver's owner or a manager,
--   4. writes are manager-only.
--
-- Nothing in the app changes behaviour: every upload and download runs through
-- the service-role client (`supabaseAdmin`), which bypasses RLS — uploads at
-- submission time and short-lived signed URLs on read (`getWaiverPdfUrl`).
-- These policies exist so the direct-from-client path is closed by construction
-- rather than by the absence of a policy, and so a future client-side read has
-- a correct, ownership-checked route.

-- ---------- 1. the bucket exists and is private ----------
-- Idempotent: creates it on a from-scratch replay (CI applies these migrations
-- to a throwaway database) and force-privates an existing one.
INSERT INTO storage.buckets (id, name, public)
VALUES ('waivers', 'waivers', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- ---------- 2. clear legacy policies for this bucket ----------
-- The bucket predates this migration, so the live database may carry policies
-- created in the dashboard that this directory has never seen. Drop anything
-- scoped to the `waivers` bucket so the policies below are the whole story;
-- policies for other buckets are matched on the quoted literal and left alone.
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (COALESCE(qual, '') || ' ' || COALESCE(with_check, '')) LIKE '%''waivers''%'
  LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', pol.policyname);
    RAISE NOTICE 'Dropped pre-existing waivers storage policy: %', pol.policyname;
  END LOOP;
END $$;

-- ---------- 3. reads: the waiver's owner, or a manager ----------
-- Object names are exactly `<waiver id>.pdf` (see `submitWaiverWithPdf`), and
-- `waivers.pdf_path` stores that same name, so ownership is a lookup on the
-- waiver row rather than anything encoded in the path. The subquery is itself
-- RLS-checked as the caller, and `waivers` already grants SELECT on
-- `user_id = auth.uid()` ("Owners can view their own waivers"), so this can
-- only ever match a waiver the caller is allowed to see.
DROP POLICY IF EXISTS "Owners can read their own waiver PDF" ON storage.objects;
CREATE POLICY "Owners can read their own waiver PDF" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'waivers'
    AND EXISTS (
      SELECT 1 FROM public.waivers w
      WHERE w.pdf_path = objects.name
        AND w.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Managers can read all waiver PDFs" ON storage.objects;
CREATE POLICY "Managers can read all waiver PDFs" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'waivers' AND public.has_role(auth.uid(), 'manager'));

-- ---------- 4. writes: managers only ----------
-- Deliberately NOT extended to the owner. A signed PDF is frozen evidence: the
-- signature images and acknowledgement ticks live only inside it, and
-- `signer_ip`/`signer_meta` on the row exist to make it defensible. Letting a
-- signer overwrite or delete their own document would let them rewrite what
-- they signed. The app never writes as a user anyway (submission runs through
-- the service role), so this leaves managers as the only non-service-role
-- write path, for corrections and erasure requests.
DROP POLICY IF EXISTS "Managers can upload waiver PDFs" ON storage.objects;
CREATE POLICY "Managers can upload waiver PDFs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'waivers' AND public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers can update waiver PDFs" ON storage.objects;
CREATE POLICY "Managers can update waiver PDFs" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'waivers' AND public.has_role(auth.uid(), 'manager'))
  WITH CHECK (bucket_id = 'waivers' AND public.has_role(auth.uid(), 'manager'));

DROP POLICY IF EXISTS "Managers can delete waiver PDFs" ON storage.objects;
CREATE POLICY "Managers can delete waiver PDFs" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'waivers' AND public.has_role(auth.uid(), 'manager'));

-- `anon` gets nothing: waiver signing is public, but the signer receives a
-- service-role signed URL rather than a direct object read.
