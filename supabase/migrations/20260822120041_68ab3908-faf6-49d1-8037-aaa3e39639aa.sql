-- NOTE ON THIS FILE'S NAME. The timestamp and uuid are Lovable's, not a human's.
-- This SQL was applied to the live database by hand (through Lovable's SQL
-- access) on 2026-08-22, before the pull request that introduced it merged, per
-- the apply gate in docs/database-changes.md. Lovable then re-emitted the
-- applied SQL as a migration of its own under this filename and recorded THAT
-- version in the live ledger -- the duplicate-re-emission case docs/database-
-- changes.md describes. The branch's own copy, 20260822000000_notification_
-- digest_key_single_source.sql, was byte-identical in SQL and has been deleted
-- rather than kept alongside this one: only this filename has a ledger row, so
-- keeping both would leave the by-hand drift check reporting a file with no
-- ledger entry AND a ledger entry with no file. The commentary below is that
-- file's, preserved because it is the reasoning, not decoration.
--
-- Collapse the digest's two copies of one credential into one.
--
-- WHY. `private.run_notification_digest()` (20260807000000, then
-- 20260821000000) reads a bearer token out of Supabase Vault and the endpoint
-- (src/routes/api/notifications/digest.ts) compares it against the server env
-- var NOTIFICATION_DIGEST_KEY. Somebody has to type the SAME random string into
-- two different systems — Lovable's runtime secret store and Supabase Vault —
-- and keep them in sync forever. That setup is the actual defect: the club
-- owner could not find the Lovable secrets screen (it moved on the Pro plan),
-- so the env var was never set, both Vault secrets stayed absent, and every
-- night since 20260807000000 was applied recorded a job that did nothing. As of
-- 20260821000000 that at least fails loudly; this migration removes the second
-- place the key could go missing from, rather than adding a third watcher.
--
-- WHAT CHANGES. The endpoint stops reading `process.env.NOTIFICATION_DIGEST_KEY`
-- and instead calls a new service-role-only RPC that reads the SAME Vault row
-- the scheduler already sends. One secret, minted once, by this migration,
-- never seen or typed by anyone. `notification_digest_url` retires the same
-- way `docs/notifications.md` already flags as a standing trap (someone using
-- the published `*.lovable.app` host, which 302s and which pg_net will not
-- follow): the URL becomes a constant inside the function instead of a second
-- Vault row that can drift or be typed wrong.
--
-- SEQUENCING. Additive for the app: a new function, granted only to
-- service_role, changes nothing anyone else can reach. `private.run_notifica-
-- tion_digest()` is replaced in place (its third body in this migration's
-- history) but keeps the exact fail-closed-and-loud shape 20260821000000 built;
-- the job's name and schedule are untouched, so no re-schedule is needed.
-- Applying this CANNOT start emailing anybody: the fail-closed branch still
-- raises rather than calling out unless a key already exists, and this
-- migration is the only thing that can create one, which it does with a random
-- value nobody has yet paired with the endpoint's cache. See the PR body for
-- what a human still has to verify and do before this is armed.
--
-- ⚠️ THIS MIGRATION DOES NOT ARM THE DIGEST. It mints a random secret so there
-- is finally exactly one copy of the key to arm with, but the backlog decision
-- and the go-live moment stay a human call — see docs/notifications.md.

-- ---------- 1. Read the key: public.notification_digest_key() ----------
-- Same shape as `user_id_by_email` / `user_emails` (20260723000000): a
-- SECURITY DEFINER lookup, callable only by the service role, so the app's
-- lazy-imported admin client can read it over PostgREST without any policy or
-- grant that would let `anon`/`authenticated` read it too.
--
-- `SET search_path = ''` with the `vault` schema spelled out on every
-- reference, exactly like `private.run_notification_digest()` already does —
-- a SECURITY DEFINER function with a mutable search_path is the
-- `function_search_path_mutable` advisor finding, which fails supabase-lint at
-- WARN. See supabase/lint/README.md.
CREATE OR REPLACE FUNCTION public.notification_digest_key()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- vault.decrypted_secrets, NOT vault.secrets: the latter's `secret` column is
  -- ciphertext, and returning that would hand the endpoint base64 noise to
  -- compare against a real bearer token.
  SELECT decrypted_secret FROM vault.decrypted_secrets
   WHERE name = 'notification_digest_key'
   LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.notification_digest_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_digest_key() TO service_role;

-- ---------- 2. Mint the secret, once, guarded ----------
-- Nobody types this value anywhere: the migration generates it, Vault stores
-- it, and the endpoint reads it back through the RPC above. There is nothing
-- left to keep in sync.
--
-- pgcrypto supplies `gen_random_bytes`, the CSPRNG behind the secret's value
-- (not pg_catalog's gen_random_uuid, which is structured and carries far
-- fewer bits of real entropy). `CREATE EXTENSION IF NOT EXISTS ... WITH
-- SCHEMA extensions` only picks that schema on a FRESH install — Postgres
-- checks extension existence by NAME alone, so if pgcrypto is already
-- installed somewhere else (schema `public`, say, on an older project) this
-- line is a silent no-op and its functions stay where they already are. The
-- explicit check below is what makes this the same defensive stance
-- 20260807000000 takes with `net.http_post`: a wrong assumption about the
-- schema has to raise loudly here, naming what was actually found, rather
-- than surfacing three lines later as a bare "function does not exist" from
-- the `PERFORM vault.create_secret(...)` call.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
DECLARE
  found_in TEXT;
BEGIN
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    SELECT string_agg(DISTINCT n.nspname || '.' || p.proname
                      || '(' || pg_get_function_arguments(p.oid) || ')', '; ')
      INTO found_in
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'gen_random_bytes';
    RAISE EXCEPTION
      'extensions.gen_random_bytes(integer) not found (found: %). pgcrypto is installed in a different schema; update this migration to reference it there.',
      COALESCE(found_in, 'nothing named gen_random_bytes');
  END IF;
END;
$$;

-- ⚠️ CI'S LOCAL POSTGRES HAS VAULT. Do not assume otherwise: an earlier draft
-- of this block assumed the opposite (this repo's own CI "has no Vault"), and
-- that was simply wrong. The `ghcr.io/supabase/postgres` image
-- `.github/workflows/supabase-lint.yml` and `e2e.yml` both run has Vault
-- installed, so `to_regclass('vault.secrets')` below is NOT NULL in CI and
-- the mint branch genuinely executes there. The only Postgres this guards
-- against is a bare, non-Supabase one that never installed Vault at all — a
-- hypothetical this repo does not currently run anywhere, kept as a guard
-- because it costs nothing and a bare `supabase db start`-alike could exist
-- one day without it.
--
-- WHAT NOT TO DO: the first version of this call pre-checked one exact
-- signature with `to_regprocedure('vault.create_secret(text,text,text)')`,
-- guessing Vault's `create_secret` takes 3 arguments. It does not — the
-- version this project's Postgres image ships takes FOUR,
-- `(new_secret text, new_name text DEFAULT NULL, new_description text
-- DEFAULT '', new_key_id uuid DEFAULT NULL)` — and `to_regprocedure` matches
-- on the DECLARED signature, not on what is callable given defaults, so it
-- returned NULL against a perfectly healthy Vault. That first version would
-- have silently skipped minting on CI *and on the live database*, reporting
-- success while doing nothing — precisely the failure this whole migration
-- exists to eliminate, reintroduced by guessing an exact arity. An
-- exact-signature pre-check is exactly the kind of thing a future Vault
-- release breaks again the same way.
--
-- THE FIX: do not pre-check the signature at all. Just call the function
-- with the two arguments this secret actually needs (`new_description` and
-- `new_key_id` both default, and this secret needs neither). If Vault can
-- resolve a `(text, text)` call under any overload, it runs. If it genuinely
-- cannot, PostgreSQL raises on its own — loudly, by name, at apply time —
-- which is the fail-loud behaviour this needs without hardcoding a signature
-- that is not stable across Vault releases.
DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NULL THEN
    RAISE NOTICE
      'vault is not installed; skipping notification_digest_key creation (no vault.secrets relation found)';
  ELSIF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_digest_key') THEN
    RAISE NOTICE 'notification_digest_key already exists in Vault; leaving it as is';
  ELSE
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'notification_digest_key'
    );
  END IF;
END;
$$;

-- Belt and braces on top of the branching above: whichever path was taken,
-- if Vault is installed the secret has to actually be there afterwards. This
-- is what catches a bug in the branching itself (or a future edit to it) —
-- the migration still applies "successfully" by Postgres's own measure
-- without this, exactly the silent-green failure item 1 of the review this
-- migration answers to was about.
DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_digest_key') THEN
    RAISE EXCEPTION
      'notification_digest_key is still missing from vault.secrets after this migration ran. The digest cannot be armed until it exists.';
  END IF;
END;
$$;

-- ---------- 3. private.run_notification_digest(): one secret, inlined URL ----------
-- Third body for this function (20260807000000 created it, 20260821000000
-- made the unarmed branch raise instead of warn-and-return). This keeps every
-- bit of that fail-closed-and-loud shape and removes only the second Vault
-- read: `notification_digest_url` is retired in favour of a literal, which
-- kills the "somebody used the *.lovable.app host and pg_net does not follow
-- the 302" trap by construction rather than by a runbook step someone has to
-- remember. End state after this migration: reads exactly one Vault secret,
-- raises if it is missing (naming it), otherwise POSTs to the real jitsu.au
-- origin with it as the bearer token. Fire-and-forget over pg_net is
-- unchanged — an ARMED run still reports success whatever the site answers;
-- that is still only caught by the stalled-digest attention item.
CREATE OR REPLACE FUNCTION private.run_notification_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  digest_key TEXT;
BEGIN
  SELECT decrypted_secret INTO digest_key
    FROM vault.decrypted_secrets WHERE name = 'notification_digest_key';

  -- Fail closed AND fail loudly, exactly as 20260821000000 made this branch
  -- behave. Closed because a digest endpoint anybody can POST to is a way to
  -- make the club email its own members on demand; loud because a job that
  -- quietly returns is how a digest silently stops going out for a month.
  IF digest_key IS NULL THEN
    RAISE EXCEPTION
      'notification digest not armed: missing vault secret notification_digest_key. No email has been sent. See docs/notifications.md.';
  END IF;

  -- Fire and forget: pg_net queues the request and the response lands in
  -- `net._http_response`. The endpoint is idempotent per person per day (the
  -- digest-<user>-<date> key), so a retry after a timeout cannot double-send.
  --
  -- ⚠️ Reaching this line is NOT evidence that anybody was emailed. The
  -- request id is discarded and the function returns successfully whatever the
  -- site answers. The backlog check on the notifications page is what
  -- actually watches this.
  PERFORM net.http_post(
    url := 'https://jitsu.au/api/notifications/digest',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || digest_key
    ),
    timeout_milliseconds := 300000
  );
END;
$$;

-- CREATE OR REPLACE keeps the existing ACL, so this re-asserts rather than
-- restores. It stays because the grant matters more than the duplication:
-- nobody but the scheduler needs to be able to make the site email everybody.
REVOKE ALL ON FUNCTION private.run_notification_digest() FROM PUBLIC;

-- public.notification_digest_key() is reachable over PostgREST (service role
-- only); private.run_notification_digest() is not (private is outside
-- PostgREST's db-schemas, same as every earlier version of this function).
NOTIFY pgrst, 'reload schema';
