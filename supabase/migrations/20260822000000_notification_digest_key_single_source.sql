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

-- Two DIFFERENT reasons `vault.create_secret` might be uncallable, and only
-- one of them is safe to shrug off:
--
--   * Vault is not installed at all — `vault.secrets` does not exist. That is
--     this repo's own CI (`supabase db start` / `supabase start` against a
--     throwaway local Postgres — see .github/workflows/supabase-lint.yml and
--     e2e.yml), which has no Vault and is expected never to. Skip and say so.
--   * Vault IS installed, but not with the `create_secret(text,text,text)`
--     3-arg (secret, name, description) overload this call assumes — a
--     version skew this project has not seen but a future Vault release
--     could introduce. This is NOT safe to skip: reporting success while
--     minting nothing is exactly the "a green migration means the code ran,
--     not that the work happened" failure this whole PR exists to fix. Raise
--     instead, naming every overload actually found, so applying this fails
--     loudly while a human is watching rather than leaving the digest looking
--     armed when `vault.secrets` never got a row.
--
-- `to_regclass`, not `to_regprocedure`, for the presence check: `vault.secrets`
-- is a TABLE, and to_regclass is the catalog lookup for relations (tables,
-- views, etc.), the counterpart to to_regprocedure for routines.
--
-- The `IF`/`ELSIF` branches are also why a Vault-less Postgres does not fail
-- this migration at all: PL/pgSQL only parses and plans the SQL inside a DO
-- block's branch the first time that branch actually executes, so
-- `vault.secrets` and `vault.create_secret` are never resolved when the guard
-- steers around them — the same lazy-compilation property the `net.http_post`
-- assertion block in 20260807000000 relies on.
DO $$
DECLARE
  found_in TEXT;
BEGIN
  IF to_regclass('vault.secrets') IS NULL THEN
    RAISE NOTICE
      'vault is not installed; skipping notification_digest_key creation (expected on a Postgres with no Vault, e.g. this repo''s own CI)';
  ELSIF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notification_digest_key') THEN
    RAISE NOTICE 'notification_digest_key already exists in Vault; leaving it as is';
  ELSIF to_regprocedure('vault.create_secret(text,text,text)') IS NULL THEN
    SELECT string_agg(DISTINCT n.nspname || '.' || p.proname
                      || '(' || pg_get_function_arguments(p.oid) || ')', '; ')
      INTO found_in
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'create_secret';
    RAISE EXCEPTION
      'vault is installed but vault.create_secret(text,text,text) was not found (found: %). notification_digest_key was NOT created; update this migration before relying on it.',
      COALESCE(found_in, 'nothing named create_secret');
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
