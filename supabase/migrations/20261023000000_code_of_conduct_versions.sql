-- The code of conduct becomes a document managers edit, in numbered versions.
--
-- Until now the text lived in the app (`src/lib/code-of-conduct.ts`) and a
-- version number was bumped by hand in a pull request. This moves it into the
-- database, the way the waiver already works: every save writes a new numbered
-- version, exactly one version is live, and a manager can roll back to an
-- earlier one. Product spec: docs/code-of-conduct.md.
--
-- One thing differs from the waiver, and it is the reason for the extra column.
-- On the waiver every save is simply the new text people sign. Here an
-- acceptance records a version NUMBER, and whether somebody is "out of date"
-- is computed from it, so if every save re-prompted everybody a typo fix would
-- ask the whole club to agree again. So each version records whether publishing
-- it asked everyone to agree again (`asks_reagreement`, chosen by the manager,
-- off by default), and, fixed at the moment it is written, which version people
-- must have agreed to while it is live (`required_version`): itself when it
-- asked, otherwise whatever the live version required when it was saved. A
-- person is out of date only when the highest version they agreed to is below
-- the live version's `required_version`.
--
-- Stored rather than derived from the history on purpose. Rolling back from a
-- rewrite that asked, then saving a typo fix, must not bring the rolled-back
-- ask back; a rule computed from "the newest version that asked" would, the
-- moment the typo fix's number passed the rewrite's. Every save still gets its
-- own number, so an acceptance's number keeps naming the exact text that
-- person read.
--
-- CLOSED to the client roles, unlike `waiver_templates`. The public
-- /code-of-conduct page reads the live version through a server function on the
-- service-role client (the same way the page already reads who is signing), so
-- nothing here needs a grant, and nothing about this table is reachable with
-- the published anon key. The policy below is defence in depth for the day a
-- grant is added back, and encodes the narrowest rule the app enforces:
-- managers only.
--
-- Additive only. Nothing that is live today reads it. Version 1 is seeded with
-- the text in the app today, byte for byte, because every acceptance already
-- on file says `version = 1` and that number must keep meaning the text those
-- people read (`src/lib/code-of-conduct-seed.test.ts` pins it).

CREATE TABLE IF NOT EXISTS public.code_of_conduct_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The number an acceptance records, and the one a manager reads off the
  -- editor. Unique, never reused.
  version INTEGER NOT NULL UNIQUE CHECK (version > 0),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  -- Whether publishing this version asked everybody to agree again. Fixed when
  -- the version is written: a rollback publishes a version as it was.
  asks_reagreement BOOLEAN NOT NULL DEFAULT false,
  -- The version anybody must have agreed to while this one is live. Itself
  -- when it asked; otherwise inherited from the version live when it was saved.
  required_version INTEGER NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false,
  -- One per editor save, resent unchanged on every retry, so a save whose reply
  -- was lost finds the version it already wrote instead of writing a second.
  -- Nullable: an agent may omit it.
  client_submission_id UUID,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same bounds as the editor and the agent API, so a write through either
  -- cannot store what the other would refuse.
  CONSTRAINT code_of_conduct_versions_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT code_of_conduct_versions_body_length CHECK (char_length(btrim(body_md)) BETWEEN 1 AND 50000),
  -- Nobody can be asked to have agreed to a version newer than the one shown,
  -- and a version that asked requires exactly itself.
  CONSTRAINT code_of_conduct_versions_required_version CHECK (
    required_version BETWEEN 1 AND version
    AND (NOT asks_reagreement OR required_version = version)
  )
);

-- Exactly one live version, the same partial unique index waiver_templates has.
CREATE UNIQUE INDEX IF NOT EXISTS code_of_conduct_versions_only_one_current
  ON public.code_of_conduct_versions (is_current)
  WHERE is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS code_of_conduct_versions_client_submission_id_key
  ON public.code_of_conduct_versions (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

COMMENT ON TABLE public.code_of_conduct_versions IS
  'The club code of conduct, one row per saved version, exactly one live. '
  'code_of_conduct_acceptances.version names a row here. asks_reagreement marks '
  'the versions that put everybody who agreed to an older one out of date; '
  'required_version is the version anybody must have agreed to while this one is live.';

-- ---------- version 1: the text members have already agreed to ----------
--
-- Dollar-quoted so the text goes in exactly as written, apostrophes and line
-- breaks included. ON CONFLICT so a replay is a no-op rather than an error.
-- It asks for agreement, and so requires itself, because it is the first:
-- there is nothing older.

INSERT INTO public.code_of_conduct_versions (version, title, body_md, asks_reagreement, required_version, is_current)
VALUES (
  1,
  $coc$UTS Jitsu Code of Conduct$coc$,
  $coc$# UTS Jitsu Code of Conduct

Welcome to UTS Jitsu.

We strive to create an environment where we both learn, and help others learn. Cooperation is essential to martial art training. This code of conduct is written with that in mind.

By training with us you agree to this Code and to the ActivateUTS Clubs Code of Conduct: https://www.activateuts.com.au/terms-conditions/club-code-of-conduct/

## Health and hygiene

- **Sick? Stay home.** Do not train with a fever, an infection, or a contagious condition. If you need to cough during training, cough into your gi lapel.
- **Injuries.** Tell the Coach in Charge about any existing injury before training, and report any new injury immediately.
- **Bleeding.** Stop training immediately. Resume only once the wound is covered with a bandage or tape and the mat has been cleaned with alcohol wipes.
- **Skin conditions.** Do not train with an open, weeping or contagious skin condition until it is medically cleared.
- **Nails.** Keep fingernails and toenails short and cut flat, not to a point. Check before every session.
- **Gi (uniform).** Wash your gi before every session. Replace or repair it if it has holes, tears or loose thread. Soak your belt in soapy water regularly.

## Jewellery and piercings

- Remove all jewellery before training: rings, necklaces, earrings, wristbands, watches.
- Piercings that cannot be removed must be fully covered with medical tape or a band-aid.

## Mat etiquette

- **Rei (bow).** Bow when stepping onto and off the mat. Wait for the Coach in Charge to acknowledge you before you step on.
- **Footwear.** Never walk barefoot outside the mat area. Wear flip-flops or sandals off the mat, and never walk on the mat in shoes.
- **Bring to every session:** flip-flops, towel, water bottle and mouthguard.
- **Leaving early.** Always tell the Coach in Charge if you need to leave a session early.

## Protective equipment

- **Mouthguard.** Mandatory for all sparring and resistance training. The club can help you source one.
- Some sessions may need boxing or MMA gloves, shin guards and/or a helmet. You will be told in advance. The club will try to lend equipment but cannot promise enough for everyone, and can help you source your own.

## Grading and uniform

Regular sessions:

- Get a gi through the club. Speak to the club committee.
- Until you have one, sports clothes are fine. Long pants are preferred and a top is required.
- Other standard martial arts uniforms are permitted at the coach's discretion.
- A short-sleeve rash guard under the gi is recommended. The club can help you source one.

Gradings:

- A blue or white judo gi with the Jitsu badge is required.
- Your belt must be your current Sydney Jitsu rank colour, correctly tied.

## Respect, inclusion and training safety

- Treat everyone with dignity and respect: training partners, coaches and guests.
- Bullying, harassment, discrimination, objectification and vilification of any kind will not be tolerated.
- All physical contact must be appropriate for the technique being practised. Stop immediately on a tap or at any sign of discomfort.
- No member is ever required to train, spar or partner with someone against their will, whatever that person's rank or seniority. You can talk to your coach, sit out, or change partner.
- Changing facilities must be used appropriately and respectfully.
- Headbutts, knee strikes and elbow strikes to the head are allowed only when the coach has explicitly permitted them and the person receiving them is wearing extra protective gear (mouthguard and helmet).
- "Staking" an opponent on their neck during ground work is allowed only when both people are Jitsu light blue grades or above, and the coach has explicitly said this is a sparring or resistance exercise.
- Biting, scratching and spitting are always prohibited.

## Reporting incidents

- Report any and all incidents to the Coach in Charge.
- The Coach in Charge will report to ActivateFit as required by ActivateUTS policy.
- You may report directly to ActivateUTS if you are not comfortable approaching the coach.
- No retaliation against anyone who raises a concern in good faith will be tolerated.

## Coaching standards

- All coaches hold a current First Aid certification. This is mandatory and renewed regularly.
- All coaches hold a valid NSW Working with Children Check (WWCC).
- Certificates and registration numbers can be provided on request.

## Breaches of this Code

- Breaches are handled under the ActivateUTS Clubs Code of Conduct disciplinary process.
- Outcomes range from a formal warning to suspension or expulsion, depending on how serious the breach is.
- Matters involving criminal conduct or child safety are referred to the relevant authorities.
$coc$,
  true,
  1,
  true
)
ON CONFLICT (version) DO NOTHING;

-- ---------- closed to the client roles ----------
--
-- GRANT cannot narrow what Supabase's default privileges hand every new table;
-- only REVOKE can (docs/database-changes.md).

REVOKE ALL ON public.code_of_conduct_versions FROM anon, authenticated;
GRANT ALL ON public.code_of_conduct_versions TO service_role;

ALTER TABLE public.code_of_conduct_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Managers manage code of conduct versions" ON public.code_of_conduct_versions;
CREATE POLICY "Managers manage code of conduct versions"
  ON public.code_of_conduct_versions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));
