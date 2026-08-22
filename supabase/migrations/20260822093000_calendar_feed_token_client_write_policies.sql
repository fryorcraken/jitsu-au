-- Drop the two client write policies on calendar_feed_tokens.
--
-- They came from 20260726000000_calendar.sql and have been dead since
-- 20260728120000_calendar_revoke_client_grants.sql took INSERT and UPDATE away
-- from `anon` and `authenticated`: a policy without a grant is unreachable. That
-- migration kept them on purpose, reasoning they cost nothing and would "stay
-- correct if a grant is ever added back".
--
-- That reasoning no longer holds for the UPDATE one. `revoked_at` is now the
-- mechanism by which a member makes a leaked calendar link stop working: the
-- feed route (src/routes/api/calendar/$token.ts) serves a token unless its row
-- carries a revoked_at, and replaceMyCalendarFeedUrl is what writes it. An
-- owner-scoped UPDATE policy is therefore no longer defence in depth pointing
-- the same way as the app; it says "a person may write their own row", which,
-- the moment any future migration or dashboard change hands `authenticated` an
-- UPDATE grant, means a member can PATCH revoked_at back to NULL and resurrect
-- the exact link they had just reported as leaked. The original migration's own
-- comment names that attack, then leaves the policy that would allow it.
--
-- The INSERT policy goes with it for the same reason in a milder form: minting
-- runs through the service role only, and a client that could insert its own row
-- could hand itself a token the server never issued. Neither policy has a
-- caller, in this repo or anywhere else, so dropping them removes no code path.
--
-- SELECT is untouched. `authenticated` really does hold that grant (see
-- supabase/lint/client-grants-expected.txt), the owner-only policy narrows it to
-- their own row, and that row is what /calendar and /account show them. This
-- migration changes no grants, so client-grants-expected.txt is unchanged.

DROP POLICY IF EXISTS "Users can revoke their own feed token" ON public.calendar_feed_tokens;
DROP POLICY IF EXISTS "Users can create their own feed token" ON public.calendar_feed_tokens;

NOTIFY pgrst, 'reload schema';
