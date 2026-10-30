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
-- the manager agent API, so no reader has to change. When the app writes the
-- parts it writes, beside them, the line composed from them:
--
--   <street>, <suburb> <STATE> <postcode>      "1 Broadway, Ultimo NSW 2007"
--
-- The app's own composition must produce exactly this line; the code that
-- follows this migration pins it with a test, and on `waivers` the database
-- refuses anything else (below).
--
-- The guardian's address (`guardian_address`) is deliberately not split. It is
-- contact detail and evidence on a child's waiver; nothing reports on it, and
-- four more columns on two tables would buy nothing a person can use.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that writes the parts. Applying it changes nothing anybody
-- sees: the backfill at the bottom fills in parts and leaves every address
-- line exactly as it was typed.
--
-- Grants: none on the tables. `profiles` holds no privilege at all for anon or
-- authenticated (20260728150000), and `waivers` holds only the owner's SELECT
-- (a person reading their own submissions), which a new column joins
-- automatically and which is right for it: it is that person's own address.
-- The two functions below are callable by the server only, like every helper
-- in this schema.

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
-- A suburb carries no digit and no comma: no Australian suburb has either, and
-- either one would make the composed line read back as a different address.
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
                  AND address_suburb !~ '[[:cntrl:]0-9,]'))
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

  -- A waiver's line and parts come from one submission in one insert, and
  -- the line is what the signed PDF prints, so they must describe the same
  -- place exactly. A CHECK rather than a trigger: the submitted text is
  -- evidence, and nothing may rewrite it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.waivers'::regclass
       AND conname = 'waivers_address_matches_parts'
  ) THEN
    ALTER TABLE public.waivers
      ADD CONSTRAINT waivers_address_matches_parts CHECK (
        address_street IS NULL
        OR address = address_street || ', ' || address_suburb || ' '
                     || address_state || ' ' || address_postcode
      );
  END IF;
END
$$;

-- Read the four parts out of a one-line address, or NULL when that cannot be
-- done without guessing.
--
-- It accepts the composed shape above, with an optional comma before the
-- state and a trailing ", Australia" tolerated. The street is everything up to
-- the LAST comma before the suburb, so "Unit 3, 12 Smith St, Pyrmont NSW 2009"
-- keeps "Unit 3, 12 Smith St". It refuses, rather than guesses, when:
--
--   * the street has no number in it, or does not end in a word. Both mean the
--     comma found was not the one before the suburb: "Unit 3, 12 Smith St
--     Pyrmont NSW 2009" and "Unit 3, Rose Avenue Glebe NSW 2037" would
--     otherwise file "12 Smith St Pyrmont" and "Rose Avenue Glebe" as suburbs;
--   * the suburb has a digit in it, for the same reason;
--   * the postcode cannot belong to the state named (Australia Post's leading
--     digits), so "Ultimo VIC 2007" files nobody in Victoria. A handful of
--     real border postcodes (Barooga NSW 3644) fail this and stay unsplit,
--     which is the safe way to be wrong;
--   * the address runs over more than one line, has no comma between street
--     and suburb, has no state, or is overseas.
--
-- Unsplit is always safe: the person keeps their one-line address and is asked
-- for the parts the next time they give one.
CREATE OR REPLACE FUNCTION public.split_au_address(line TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  m TEXT[];
  postcode_lead TEXT;
BEGIN
  IF line IS NULL OR line ~ '[[:cntrl:]]' THEN
    RETURN NULL;
  END IF;
  m := regexp_match(
    line,
    '^\s*(.*[0-9].*[a-z.])\s*,\s*([^,0-9]*[^\s,0-9])\s*,?\s+(act|nsw|nt|qld|sa|tas|vic|wa)\s*,?\s+([0-9]{4})(\s*,?\s*australia)?\s*$',
    'i'
  );
  IF m IS NULL OR length(m[1]) > 200 OR length(m[2]) > 60 THEN
    RETURN NULL;
  END IF;
  m[3] := upper(m[3]);
  -- Assigned first: inside an IF condition, plpgsql would read the CASE's
  -- first THEN as the IF's own.
  postcode_lead := CASE m[3]
    WHEN 'ACT' THEN '^(02|26|29)'
    WHEN 'NSW' THEN '^[12]'
    WHEN 'NT'  THEN '^0[89]'
    WHEN 'QLD' THEN '^[49]'
    WHEN 'SA'  THEN '^5'
    WHEN 'TAS' THEN '^7'
    WHEN 'VIC' THEN '^[38]'
    WHEN 'WA'  THEN '^6'
  END;
  IF m[4] !~ postcode_lead THEN
    RETURN NULL;
  END IF;
  RETURN m[1:4];
END;
$$;

REVOKE ALL ON FUNCTION public.split_au_address(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.split_au_address(TEXT) TO service_role;

-- Keep a profile's parts and its one-line `address` from ever describing two
-- different places.
--
-- The code deployed today writes `address` alone: a member saving a new
-- address on their account page, a manager approving a waiver (which copies
-- the address exactly as that waiver was typed). Once a profile has parts,
-- such a write must not leave them describing the OLD address, or every suburb
-- report would quietly carry it. Nor is that only a rollout gap: a hand edit in
-- the Lovable UI writes whatever it is given. So the database holds the rule
-- rather than trusting every writer to remember it.
--
-- The line and the parts AGREE when the line is the one composed from the
-- parts, or when the parts are what `split_au_address` reads out of the line.
-- The second case is what lets an address keep the punctuation it was typed
-- with. When they agree, nothing is touched. When they do not:
--
--   * the parts were written   -> the parts win, and `address` becomes the
--                                 line composed from them;
--   * only `address` was       -> `address` wins, and the parts become what
--     written                     can be read out of it: the same parts for
--                                 an old waiver's spelling of the same
--                                 address, new ones for a new address, or
--                                 none at all for one that cannot be split.
--
-- `profiles` only. A waiver is written once and its text is evidence, so it is
-- held by the CHECK above instead.
CREATE OR REPLACE FUNCTION public.profiles_sync_address()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  parts TEXT[] := ARRAY[NEW.address_street, NEW.address_suburb,
                        NEW.address_state, NEW.address_postcode];
  read_back TEXT[];
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.address IS NOT DISTINCT FROM OLD.address
     AND parts IS NOT DISTINCT FROM ARRAY[OLD.address_street, OLD.address_suburb,
                                          OLD.address_state, OLD.address_postcode]
  THEN
    RETURN NEW;
  END IF;

  read_back := public.split_au_address(NEW.address);

  IF NEW.address_street IS NOT NULL THEN
    IF NEW.address IS NOT DISTINCT FROM
         (NEW.address_street || ', ' || NEW.address_suburb || ' '
          || NEW.address_state || ' ' || NEW.address_postcode)
       OR read_back IS NOT DISTINCT FROM parts
    THEN
      RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT'
       OR parts IS DISTINCT FROM ARRAY[OLD.address_street, OLD.address_suburb,
                                       OLD.address_state, OLD.address_postcode]
    THEN
      NEW.address := NEW.address_street || ', ' || NEW.address_suburb || ' '
                     || NEW.address_state || ' ' || NEW.address_postcode;
      RETURN NEW;
    END IF;
  END IF;

  -- No parts, or only `address` was written: read them out of the line.
  NEW.address_street := read_back[1];
  NEW.address_suburb := read_back[2];
  NEW.address_state := read_back[3];
  NEW.address_postcode := read_back[4];
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
  'Street line of the person''s address, unit included. NULL with the other three parts when `address` cannot be split without guessing (split_au_address). The parts and `address` always describe the same place (profiles_sync_address).';
COMMENT ON COLUMN public.profiles.address_suburb IS
  'Suburb, as typed. All four address parts are set together or not at all.';
COMMENT ON COLUMN public.profiles.address_state IS
  'Australian state or territory abbreviation: ACT, NSW, NT, QLD, SA, TAS, VIC or WA.';
COMMENT ON COLUMN public.profiles.address_postcode IS
  'Four-digit postcode, as text so a leading zero survives.';
COMMENT ON COLUMN public.waivers.address_street IS
  'Street line of the participant''s address, as submitted. NULL with the other three parts on a waiver signed before structured addresses existed: those keep only `address`, exactly as signed. When set, `address` is the line composed from the four (waivers_address_matches_parts).';
COMMENT ON COLUMN public.waivers.address_suburb IS
  'Suburb, as submitted. All four address parts are set together or not at all.';
COMMENT ON COLUMN public.waivers.address_state IS
  'Australian state or territory abbreviation, as submitted.';
COMMENT ON COLUMN public.waivers.address_postcode IS
  'Four-digit postcode, as submitted.';

-- Backfill the club's CURRENT record of each person from the address they
-- already gave, wherever `split_au_address` can read the parts out of it.
-- Every `address` line is left exactly as typed: the parts it splits into
-- agree with it by definition, so the trigger touches nothing.
--
-- `profiles` only. A waiver is a frozen record of what somebody submitted, and
-- nobody submitted these parts on the waivers that already exist, so those
-- rows keep exactly what was signed.
--
-- `updated_at` is left alone: nothing about the person changed, only how the
-- same address is stored.
UPDATE public.profiles AS p
   SET address_street   = s.parts[1],
       address_suburb   = s.parts[2],
       address_state    = s.parts[3],
       address_postcode = s.parts[4]
  FROM (
    SELECT user_id, public.split_au_address(address) AS parts
      FROM public.profiles
     WHERE address IS NOT NULL
       AND address_street IS NULL
  ) AS s
 WHERE p.user_id = s.user_id
   AND s.parts IS NOT NULL;

NOTIFY pgrst, 'reload schema';
