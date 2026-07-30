-- Code of conduct acceptances: who agreed to the club's house rules, and when.
--
-- The waiver is the legal release a person must sign BEFORE they train. The code
-- of conduct is the club's house rules, and it is deliberately NOT a blocker:
-- the club wants it signed around the time somebody becomes a paying member, and
-- an unsigned one never stops anyone stepping on the mat. So this table records
-- agreement and nothing more. There is no approval workflow, no pending state,
-- and nothing here gates any other flow.
--
-- Two more differences from `waivers`, both deliberate:
--
--   * There is no template table. The document lives in the repo
--     (`src/lib/code-of-conduct.ts`) and `version` is bumped by hand when the
--     wording materially changes. House rules change by committee decision, not
--     between classes, and a diff in git says more about what changed than a
--     row in a table does.
--   * There is no PDF. What is being evidenced is "this person agreed to
--     version N on this date, from this address"; the text of version N is in
--     git, permanently, so freezing a copy per acceptance would store the same
--     paragraph a few hundred times to say something git already says.
--
-- What IS kept is the same evidence the waiver keeps: the name and email as they
-- stood, the typed signature, the signer's real IP and browser context.

CREATE TABLE public.code_of_conduct_acceptances (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- A person, not an address: unlike the waiver (where the email may be the very
  -- first thing the club learns about somebody), the code of conduct is only
  -- ever signed by someone who already exists — they signed a waiver first, or
  -- they are signed in. So this is NOT NULL, and there is no path that creates a
  -- person here.
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  -- The document version agreed to (`CODE_OF_CONDUCT_VERSION` in the app). An
  -- acceptance older than the current version shows as out of date, which is a
  -- prompt to re-read, never a block.
  version INTEGER NOT NULL CHECK (version > 0),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The person AS THEY STOOD when they agreed, copied from their profile and
  -- login by the server rather than typed in. Evidence, like the waiver's frozen
  -- fields: a later name change or email correction must not rewrite what this
  -- row says was agreed.
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 255),
  -- The name they typed to sign. The waiver offers drawing as well; here a typed
  -- name is the whole signature, because there is no document to draw onto.
  signature_name TEXT NOT NULL CHECK (char_length(signature_name) BETWEEN 1 AND 120),
  -- Signing context, same forensic record the waiver keeps: real client IP plus
  -- request headers merged with the browser's self-reported context.
  signer_ip TEXT,
  signer_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query shape: this person's acceptances, newest first.
CREATE INDEX code_of_conduct_acceptances_user_idx
  ON public.code_of_conduct_acceptances (user_id, accepted_at DESC);

-- ---------- Grants ----------
-- Supabase's bootstrap grants ALL on every new table in `public` to anon and
-- authenticated, and GRANT cannot narrow that — only REVOKE can, so the REVOKE
-- comes first (docs/database-changes.md). Nothing here is reached from a browser
-- or from an anon-key server client: signing runs through a server function on
-- the service role, so the client roles get nothing and
-- `supabase/lint/client-grants-expected.txt` needs no entry.
REVOKE ALL ON public.code_of_conduct_acceptances FROM anon, authenticated;
GRANT ALL ON public.code_of_conduct_acceptances TO service_role;

ALTER TABLE public.code_of_conduct_acceptances ENABLE ROW LEVEL SECURITY;

-- Defence in depth, as on `session_checkins`: with no client grant these are
-- unreachable, and they are already right on the day somebody adds one. Reads
-- only — an acceptance is a record of something that happened, so there is no
-- client-side update or delete to allow, and the insert runs as service role.
CREATE POLICY "Users can view their own code of conduct acceptances"
  ON public.code_of_conduct_acceptances
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can read all code of conduct acceptances"
  ON public.code_of_conduct_acceptances
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- ---------- The "sign it later" link ----------
-- Signing the code of conduct is offered right after the waiver, and again by
-- email so it can be done later. The person is an applicant at that point: their
-- login is banned until a manager approves the waiver, so they cannot sign in to
-- prove who they are, and the link has to carry that proof itself.
--
-- Rather than mint a second kind of emailed token, this reuses
-- `email_verification_tokens`, which already does exactly this job: hashed, long
-- lived, bound to an ADDRESS, revoked in bulk when a manager corrects an email.
-- The only change needed is admitting the new purpose. Opening the link is also
-- proof the address is real, so it verifies the email as a side effect, exactly
-- like every other token in that table.
ALTER TABLE public.email_verification_tokens
  DROP CONSTRAINT IF EXISTS email_verification_tokens_purpose_check;

ALTER TABLE public.email_verification_tokens
  ADD CONSTRAINT email_verification_tokens_purpose_check CHECK (
    purpose IN (
      'interest',
      'waiver',
      'manager_resend',
      'self_resend',
      'email_change',
      'code_of_conduct'
    )
  );

NOTIFY pgrst, 'reload schema';
