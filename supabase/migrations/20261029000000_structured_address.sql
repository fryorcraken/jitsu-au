-- Structured addresses: street, suburb, state and postcode as their own fields.
--
-- Until now every address the club holds was one free-text box, so nothing
-- made anybody give a postcode, and the club could not sort, count or export
-- its members by suburb or postcode without guessing at what people typed.
-- This adds the four parts beside the existing `address` on the two tables
-- that hold a person's own address:
--
--   address_street    The street line, unit number included ("3/12 Smith St").
--   address_suburb    As typed. Not case-normalised: "McMahons Point" is
--                     correct and an initcap would break it.
--   address_state     One of the eight Australian states and territories, as
--                     its usual abbreviation.
--   address_postcode  Four digits, kept as text so 0800 keeps its leading zero.
--
-- `address` STAYS, and stays the one-line form everything already reads: the
-- signed PDF, the waiver template's {{address}} token, the manager screens and
-- the manager agent API. Wherever the parts are set, `address` is the line
-- composed from them:
--
--   <street>, <suburb> <STATE> <postcode>      "1 Broadway, Ultimo NSW 2007"
--
-- so no reader has to change. The app's own composition must produce exactly
-- this line; the code that follows this migration pins it with a test.
--
-- The guardian's address (`guardian_address`) is deliberately not split. It is
-- contact detail and evidence on a child's waiver; nothing reports on it, and
-- four more columns on two tables would buy nothing a person can use.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that writes the parts. The one thing anybody could notice is
-- the backfill at the bottom: a profile whose address it splits gets that
-- address rewritten as the composed line, which changes its punctuation and
-- spacing and nothing else ("1 Broadway, Ultimo, NSW 2007, Australia" becomes
-- "1 Broadway, Ultimo NSW 2007").
--
-- Grants: none needed and none given. `profiles` holds no privilege at all for
-- anon or authenticated (20260728150000), and `waivers` holds only the owner's
-- SELECT (a person reading their own submissions), which a new column joins
-- automatically and which is right for it: it is that person's own address.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS address_street TEXT,
  ADD COLUMN IF NOT EXISTS address_suburb TEXT,
  ADD COLUMN IF NOT EXISTS address_state TEXT,
  ADD COLUMN IF NOT EXISTS address_postcode TEXT;

ALTER TABLE public.waivers
  ADD COLUMN IF NOT EXISTS address_street TEXT,
  ADD COLUMN IF NOT EXISTS address_suburb TEXT,
  ADD COLUMN IF NOT EXISTS address_state TEXT,
  ADD COLUMN IF NOT EXISTS address_postcode TEXT;

-- The four are honest as a set: either all of them are filled in or none are.
-- None is the state of every address that predates this migration and could
-- not be split below, and of every row the currently deployed code writes
-- until the code that follows this goes live. Each part is stored trimmed and
-- on one line, so grouping by suburb never splits "Ultimo" from " Ultimo ".
--
-- Asserted separately and only when missing, as in 20261023120000, so applying
-- this file again (or a Lovable re-emission of it) neither fails nor rescans
-- either table for nothing. The rules are the same on both tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'waivers'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', t)::regclass
         AND conname = t || '_address_parts_valid'
    ) THEN
      EXECUTE format(
        $sql$
        ALTER TABLE public.%I
          ADD CONSTRAINT %I CHECK (
            num_nulls(address_street, address_suburb, address_state, address_postcode) IN (0, 4)
            AND (address_street IS NULL OR (
                  address_street = btrim(address_street)
                  AND length(address_street) BETWEEN 1 AND 200
                  AND address_street !~ '[[:cntrl:]]'))
            AND (address_suburb IS NULL OR (
                  address_suburb = btrim(address_suburb)
                  AND length(address_suburb) BETWEEN 1 AND 60
                  AND address_suburb !~ '[[:cntrl:]]'))
            AND (address_state IS NULL
                 OR address_state IN ('ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'))
            AND (address_postcode IS NULL OR address_postcode ~ '^[0-9]{4}$')
          )
        $sql$,
        t,
        t || '_address_parts_valid'
      );
    END IF;
  END LOOP;
END
$$;

-- Keep a profile's parts and its one-line `address` from ever disagreeing.
--
-- The code deployed today writes `address` alone: a member saving a new
-- address on their account page, a manager approving a waiver. Once a profile
-- has parts, such a write would leave them describing the OLD address, and
-- every suburb report would quietly carry it. Nor is that only a rollout gap:
-- a hand edit in the Lovable UI writes whatever it is given. So the database
-- holds the rule rather than trusting every writer to remember it:
--
--   * parts written (set, or changed)  -> `address` becomes the line composed
--                                         from them, whatever came with it;
--   * `address` changed, parts not     -> the parts are cleared, since they
--                                         now describe somewhere else. The
--                                         person is asked for them again the
--                                         next time they give an address.
--
-- `profiles` only. A waiver is written once, by the signing and paper-filing
-- handlers, and never updated; and for a waiver the submitted text is
-- evidence, which a trigger must not rewrite. Its parts and line come from the
-- same submission in the same insert.
CREATE OR REPLACE FUNCTION public.profiles_sync_address()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.address_street IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR (NEW.address_street, NEW.address_suburb, NEW.address_state, NEW.address_postcode)
             IS DISTINCT FROM
             (OLD.address_street, OLD.address_suburb, OLD.address_state, OLD.address_postcode))
  THEN
    NEW.address := NEW.address_street || ', ' || NEW.address_suburb || ' '
                   || NEW.address_state || ' ' || NEW.address_postcode;
  ELSIF TG_OP = 'UPDATE' AND NEW.address IS DISTINCT FROM OLD.address THEN
    NEW.address_street := NULL;
    NEW.address_suburb := NULL;
    NEW.address_state := NULL;
    NEW.address_postcode := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger function is never called directly, so nobody needs EXECUTE on it.
REVOKE ALL ON FUNCTION public.profiles_sync_address() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_sync_address ON public.profiles;
CREATE TRIGGER profiles_sync_address
  BEFORE INSERT OR UPDATE OF address, address_street, address_suburb, address_state, address_postcode
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_sync_address();

COMMENT ON COLUMN public.profiles.address_street IS
  'Street line of the person''s address, unit included. NULL with the other three parts when the address predates structured addresses and could not be split. When set, `address` is the line composed from the four (profiles_sync_address).';
COMMENT ON COLUMN public.profiles.address_suburb IS
  'Suburb, as typed. All four address parts are set together or not at all.';
COMMENT ON COLUMN public.profiles.address_state IS
  'Australian state or territory abbreviation: ACT, NSW, NT, QLD, SA, TAS, VIC or WA.';
COMMENT ON COLUMN public.profiles.address_postcode IS
  'Four-digit postcode, as text so a leading zero survives.';
COMMENT ON COLUMN public.waivers.address_street IS
  'Street line of the participant''s address, as submitted. NULL with the other three parts on a waiver signed before structured addresses existed: those keep only `address`, exactly as signed.';
COMMENT ON COLUMN public.waivers.address_suburb IS
  'Suburb, as submitted. All four address parts are set together or not at all.';
COMMENT ON COLUMN public.waivers.address_state IS
  'Australian state or territory abbreviation, as submitted.';
COMMENT ON COLUMN public.waivers.address_postcode IS
  'Four-digit postcode, as submitted.';

-- Backfill the club's CURRENT record of each person from the address they
-- already gave, wherever it is unambiguously in the composed shape above, with
-- an optional comma before the state and a trailing ", Australia" tolerated.
-- The street is everything up to the LAST comma before the suburb, so
-- "Unit 3, 12 Smith St, Pyrmont NSW 2009" keeps "Unit 3, 12 Smith St".
--
-- What is NOT split, and keeps all four parts NULL rather than a guess:
--
--   * a suburb with a digit in it. No suburb has one, so a digit means the
--     comma found was not the one before the suburb: "Unit 3, 12 Smith St
--     Pyrmont NSW 2009" would otherwise file "12 Smith St Pyrmont" as the
--     suburb;
--   * a postcode that cannot belong to the state named (Australia Post's
--     leading digits), so "Ultimo VIC 2007" files nobody in Victoria;
--   * an address over more than one line, no comma between street and suburb,
--     no state, or anything overseas.
--
-- Those people are asked for the parts the next time they give an address,
-- and their one-line `address` is untouched. A split one has its `address`
-- rewritten as the composed line by the trigger above.
--
-- `profiles` only. A waiver is a frozen record of what somebody submitted, and
-- nobody submitted these parts on the waivers that already exist, so those
-- rows keep exactly what was signed.
--
-- `updated_at` is left alone: nothing about the person changed, only how the
-- same address is stored.
UPDATE public.profiles AS p
   SET address_street   = m.parts[1],
       address_suburb   = m.parts[2],
       address_state    = upper(m.parts[3]),
       address_postcode = m.parts[4]
  FROM (
    SELECT user_id,
           regexp_match(
             address,
             '^\s*(.*[^\s,])\s*,\s*([^,0-9]*[^\s,0-9])\s*,?\s+(act|nsw|nt|qld|sa|tas|vic|wa)\s*,?\s+([0-9]{4})(\s*,?\s*australia)?\s*$',
             'i'
           ) AS parts
      FROM public.profiles
     WHERE address IS NOT NULL
       AND address !~ '[[:cntrl:]]'
       AND address_street IS NULL
  ) AS m
 WHERE p.user_id = m.user_id
   AND m.parts IS NOT NULL
   AND length(m.parts[1]) <= 200
   AND length(m.parts[2]) <= 60
   AND m.parts[4] ~ CASE upper(m.parts[3])
         WHEN 'ACT' THEN '^(02|26|29)'
         WHEN 'NSW' THEN '^[12]'
         WHEN 'NT'  THEN '^0[89]'
         WHEN 'QLD' THEN '^[49]'
         WHEN 'SA'  THEN '^5'
         WHEN 'TAS' THEN '^7'
         WHEN 'VIC' THEN '^[38]'
         WHEN 'WA'  THEN '^6'
       END;
