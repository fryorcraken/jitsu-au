
DROP POLICY IF EXISTS "Anyone can send contact message" ON public.contact_messages;
CREATE POLICY "Anyone can send contact message" ON public.contact_messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    length(btrim(name)) BETWEEN 1 AND 200
    AND length(btrim(email)) BETWEEN 3 AND 320
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND length(btrim(message)) BETWEEN 1 AND 5000
    AND (subject IS NULL OR length(subject) <= 300)
  );

DROP POLICY IF EXISTS "Anyone can submit interest" ON public.interest_registrations;
CREATE POLICY "Anyone can submit interest" ON public.interest_registrations
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    length(btrim(name)) BETWEEN 1 AND 200
    AND length(btrim(email)) BETWEEN 3 AND 320
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND (phone IS NULL OR length(phone) <= 50)
    AND (experience IS NULL OR length(experience) <= 100)
    AND (message IS NULL OR length(message) <= 2000)
  );

DROP POLICY IF EXISTS "Anyone can sign waiver" ON public.waivers;
CREATE POLICY "Anyone can sign waiver" ON public.waivers
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    (user_id IS NULL OR user_id = auth.uid())
    AND length(btrim(full_name)) BETWEEN 1 AND 200
    AND length(btrim(email)) BETWEEN 3 AND 320
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND length(btrim(address)) BETWEEN 1 AND 500
    AND length(btrim(phone)) BETWEEN 1 AND 50
    AND length(btrim(emergency_contact_name)) BETWEEN 1 AND 200
    AND length(btrim(emergency_contact_phone)) BETWEEN 1 AND 50
    AND length(btrim(signature_name)) BETWEEN 1 AND 200
    AND (medical_notes IS NULL OR length(medical_notes) <= 2000)
    AND (NOT is_minor OR (
      guardian_name IS NOT NULL AND length(btrim(guardian_name)) BETWEEN 1 AND 200
      AND guardian_relationship IS NOT NULL AND length(btrim(guardian_relationship)) BETWEEN 1 AND 100
      AND guardian_signature IS NOT NULL AND length(btrim(guardian_signature)) BETWEEN 1 AND 200
    ))
  );
