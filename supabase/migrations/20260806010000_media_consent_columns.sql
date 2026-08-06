-- Promote media/promotional-photo consent from a PDF-only acknowledgement tick
-- to a queryable column, on both the frozen submission and the live record.
--
-- 20260805020000 added an optional "media" acknowledgement to the waiver
-- template. Acknowledgement ticks are stored nowhere but inside the generated
-- PDF (docs/waivers.md rule 3), which is right for evidence of assent -- "I had
-- the chance to read this" is only ever read back off the signed document. It
-- is wrong for media consent, because that answer is an operational fact the
-- club acts on every week: can we photograph this person tonight, can this shot
-- go on Instagram. Nobody can open forty PDFs before posting.
--
-- This is the same call docs/database.md already records for paper waivers:
-- keep it in the jsonb/PDF until it needs to be queried in bulk, then promote
-- it to a real column. The acknowledgement stays exactly where it is -- the
-- signed PDF remains the evidence of what was agreed and when. These columns
-- are the club's working answer, derived from that tick at submission time.
--
-- NULLABLE on purpose, unlike sms_whatsapp_consent. Three states, not two:
--   NULL   the template they signed never asked (every waiver before the media
--          version) -- go and ask them
--   false  asked, declined -- do not photograph
--   true   asked, consented
-- Collapsing "never asked" into false would read as a refusal the club never
-- received, and hide the people who still need asking.

-- The answer as submitted. Frozen with the rest of the submission; never
-- updated after the fact, so a withdrawal does not rewrite the signed record.
ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS media_consent BOOLEAN;

COMMENT ON COLUMN public.waivers.media_consent IS
  'Media/promotional-photo consent as ticked on this submission. NULL = the template signed had no media acknowledgement. Frozen; the signed PDF is the evidence.';

-- The club's current answer. Seeded from the approved submission, and
-- changeable afterwards BY THE MEMBER on /account as well as by a manager: a
-- photo consent that cannot be withdrawn without signing a whole new waiver is
-- not a consent, and one only somebody else can withdraw is the wrong way round.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS media_consent BOOLEAN;

-- Who last set it and when, so "No" is never ambiguous between three different
-- facts: one ticked on a signed waiver, one the member set later on /account,
-- and one a manager recorded on their behalf. Both NULL means the value came
-- straight from an approved waiver and nobody has touched it since; otherwise
-- media_consent_updated_by = user_id says the member did it themselves.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS media_consent_updated_at TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS media_consent_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.media_consent IS
  'The club''s current media/promotional-photo consent for this person. NULL = never asked. Set by waiver approval, or by a manager recording a change.';

COMMENT ON COLUMN public.profiles.media_consent_updated_by IS
  'Who last changed media_consent by hand: equal to user_id when the member did it themselves on /account, otherwise the manager who recorded it. NULL when the value came from an approved waiver and has not been overridden.';

-- No grant or RLS change: these are columns on existing tables, which inherit
-- the table's policies and privileges. profiles is already owner-read /
-- manager-read-write, waivers already owner-read / manager-read.

NOTIFY pgrst, 'reload schema';
