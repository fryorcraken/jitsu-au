-- Household: a person can be a DEPENDANT of another person.
--
-- The club takes children, and a parent has one email address. Until now the
-- site made that impossible to record: a person IS an email (docs/waivers.md
-- rule 1, enforced by auth's unique email), so a second child signed on the
-- same parent address resolved to the FIRST child's person record. The second
-- waiver filed against the wrong child, approving it overwrote that child's
-- name, date of birth and medical notes, and the second child never got a free
-- trial. Silently, with no error on any screen. See issue #102.
--
-- The fix keeps a dependant an ORDINARY person: an ordinary auth.users row and
-- an ordinary profiles row. That is the whole point of this shape — every table
-- that keys on a person (waivers, memberships, session_checkins, notifications,
-- code_of_conduct_acceptances, user_roles, and the storage.objects waiver-PDF
-- policies) keeps working untouched, because a child is a person like any other.
-- Only two things mark them:
--
--   1. guardian_user_id below, the ONLY discriminator. It lives in `public` so
--      RLS and every server function ask the question directly, rather than
--      sniffing an email string to decide.
--   2. Their auth.users row carries a reserved, non-deliverable address and a
--      permanent ban. auth.users.email is unique and Supabase will not create a
--      user without one, so a dependant gets a generated address in a subdomain
--      the club never routes mail for. Never printed, never sent to, and the
--      ban means it can never sign in even if guessed (/auth already passes
--      shouldCreateUser: false). That is application behaviour, not schema —
--      nothing here depends on the address's shape.
--
-- NOTHING READS THIS COLUMN YET. This migration is deliberately alone in its
-- pull request (docs/database-changes.md): additive schema goes live before the
-- code that needs it, so the currently-deployed app keeps working in the gap.

-- ---------- the guardian link ----------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS guardian_user_id UUID
    REFERENCES public.profiles(user_id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.profiles.guardian_user_id IS
  'The account holder responsible for this person. NOT NULL means they are a '
  'dependant: no login of their own, and every email about them goes to the '
  'guardian instead. NULL means an ordinary account holder, which is everyone '
  'who existed before this column. Compare guardian_name/guardian_email, which '
  'are contact details promoted from a waiver and name nobody in particular; '
  'this is a real person record in this table.';

-- RESTRICT, deliberately, and NOT the CASCADE that profiles.user_id itself uses
-- against auth.users. A parent deleted while their children are still on the
-- books must fail LOUDLY rather than take those children's waivers, memberships
-- and attendance with it. The knock-on is intended: deleting a parent's auth
-- user is now refused until a manager has dealt with the children first.
-- docs/erasing-personal-data.md picks this up (issue #107).

-- Nobody is their own guardian. One level only — that a dependant may not
-- itself BE a guardian is enforced in the server function that creates one, not
-- here: a depth check would need a trigger, and the rule is cheap to hold at the
-- single call site that writes this column.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_guardian_not_self;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_guardian_not_self
    CHECK (guardian_user_id IS NULL OR guardian_user_id <> user_id);

-- Partial: the overwhelming majority of rows are account holders and will never
-- match, so the index only carries the dependants. Supports "who are this
-- person's children", which the account page, the manager household card and
-- the helper below all ask.
CREATE INDEX IF NOT EXISTS profiles_guardian_user_id_idx
  ON public.profiles (guardian_user_id)
  WHERE guardian_user_id IS NOT NULL;

-- ---------- members-only access reaches a parent through their child ----------
--
-- A parent who does not train holds no membership, so before this they were
-- locked out of the members-only calendar and blog while paying for a child who
-- was not. They need the class times more than the child does.
--
-- This is the ONLY change needed for that, because four surfaces already call
-- this one function: the members-only calendar policy (20260802000000), the
-- blog comment gate, src/lib/calendar.functions.ts and the subscribable ICS feed
-- at src/routes/api/calendar/$token.ts.
--
-- The caller-scoping guard from 20260820000000_scope_role_helpers_to_caller.sql
-- is UNCHANGED and still load-bearing. The question this answers is still "about
-- MYSELF" — a signed-in person may not ask it about anyone else — it is only the
-- ANSWER that now consults rows belonging to people they are responsible for.
-- Service-role callers still have a NULL auth.uid() and may still ask about
-- anybody, which the digest, the agent API and the calendar feed all rely on.
--
-- Still SELECT EXISTS(...), so still never NULL: that is a documented contract
-- (CLAUDE.md's RPC-nullability note and src/lib/supabase-rpc.ts) and the reason
-- this function needs no wrapper. Still SET search_path = '' for advisor
-- function_search_path_mutable.
CREATE OR REPLACE FUNCTION public.has_active_paid_membership(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (
      (SELECT auth.uid()) IS NULL
      OR _user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1
      FROM public.memberships m
      JOIN public.membership_plans p ON p.id = m.plan_id
      WHERE m.status = 'active'
        AND p.kind <> 'trial'
        AND m.price_cents > 0
        AND (
          m.user_id = _user_id
          -- ...or the membership belongs to one of their dependants.
          OR m.user_id IN (
            SELECT d.user_id
            FROM public.profiles d
            WHERE d.guardian_user_id = _user_id
          )
        )
    )
$$;

-- CREATE OR REPLACE keeps the existing ACL, so these restate intent next to the
-- code they protect and make a from-scratch replay land where the live database
-- already is. Same belt-and-braces as 20260820000000.
REVOKE EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_paid_membership(UUID) TO authenticated, service_role;

-- No grant changes anywhere else, so supabase/lint/client-grants-expected.txt
-- needs no edit: profiles holds nothing for anon or authenticated (everything
-- goes through service-role server functions), and the two RLS policies that
-- call the function above call it unchanged.

NOTIFY pgrst, 'reload schema';
