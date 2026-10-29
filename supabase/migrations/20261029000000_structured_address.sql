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
-- the manager agent API. The code that follows this migration writes the four
-- parts AND the line composed from them, so no reader has to change.
--
-- The guardian's address (`guardian_address`) is deliberately not split. It is
-- contact detail and evidence on a child's waiver; nothing reports on it, and
-- four more columns on two tables would buy nothing a person can use.
--
-- The CHECK keeps the four honest as a set: either all of them are filled in or
-- none are. None is the state of every address that predates this migration
-- and could not be split below, and of every row the currently deployed code
-- writes until the code that follows this goes live.
--
-- Additive (the EXPAND half), so per docs/database-changes.md this goes live
-- BEFORE the code that reads it. Nothing reads or writes these columns until
-- then, so applying it changes nothing anybody sees.
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

-- Asserted separately and only when missing, as in 20261023120000, so applying
-- this file again (or a Lovable re-emission of it) neither fails nor rescans
-- either table for nothing. The rules are the same on both tables, and are the
-- same rules the form's validation will apply.
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
            AND (address_street IS NULL OR length(btrim(address_street)) BETWEEN 1 AND 200)
            AND (address_suburb IS NULL OR length(btrim(address_suburb)) BETWEEN 1 AND 60)
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

COMMENT ON COLUMN public.profiles.address_street IS
  'Street line of the person''s address, unit included. NULL with the other three parts when the address predates structured addresses and could not be split. `address` holds the same address as one line.';
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
-- already gave, wherever it is unambiguously in the usual shape:
--
--   <street>, <suburb> <STATE> <postcode>      "1 Broadway, Ultimo NSW 2007"
--
-- with an optional comma before the state and a trailing ", Australia"
-- tolerated. The street is everything up to the LAST comma before the suburb,
-- so "Unit 3, 12 Smith St, Pyrmont NSW 2009" keeps "Unit 3, 12 Smith St".
-- Anything else (no comma between street and suburb, no state, an overseas
-- address) is left with all four parts NULL rather than guessed at: the person
-- is asked for the parts the next time they give their address, and the
-- one-line `address` is untouched either way.
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
             '^\s*(.*[^\s,])\s*,\s*([^,]*[^\s,])\s*,?\s+(act|nsw|nt|qld|sa|tas|vic|wa)\s*,?\s+([0-9]{4})(\s*,?\s*australia)?\s*$',
             'i'
           ) AS parts
      FROM public.profiles
     WHERE address IS NOT NULL
       AND address_street IS NULL
  ) AS m
 WHERE p.user_id = m.user_id
   AND m.parts IS NOT NULL
   AND length(m.parts[1]) <= 200
   AND length(m.parts[2]) <= 60;
