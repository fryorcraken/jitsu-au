-- The personal calendar link is now shown every time the member opens /calendar,
-- rather than once at creation with "replace" and "turn off" buttons beside it.
-- Showing it again means the server has to be able to reproduce it, and a
-- SHA-256 hash cannot be reversed, so the raw token is stored alongside the hash.
--
-- The hash column stays and keeps its unique constraint: the feed route
-- (/api/calendar/<token>) still looks a subscriber up by hash, so nothing about
-- feed fetching changes. `token` is nullable because rows minted before this
-- migration have no recoverable raw token; the server re-mints those in place
-- the next time their owner opens the calendar page.
--
-- This is the same trade-off every calendar app makes for a private ICS address:
-- the URL is a capability secret that has to remain displayable to its owner.
ALTER TABLE public.calendar_feed_tokens ADD COLUMN IF NOT EXISTS token TEXT;

-- Same guarantee the hash index gives: no two people can hold the same token.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_feed_tokens_token_idx
  ON public.calendar_feed_tokens (token)
  WHERE token IS NOT NULL;

-- Grants are unchanged. `authenticated` keeps SELECT and the owner-only RLS
-- policy, so a person can read their own row and nobody else's; that row now
-- carries the raw token, which is precisely what the page shows them. Minting
-- still runs through the service role.

NOTIFY pgrst, 'reload schema';
