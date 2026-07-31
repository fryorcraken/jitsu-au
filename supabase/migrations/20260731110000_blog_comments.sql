-- Blog comments: any signed-in person may comment or reply — membership status
-- irrelevant, the exact same rule as event RSVPs — and upvote a comment once
-- (no downvote). Managers moderate by hiding a comment, and in the extreme
-- case block a person from commenting anywhere on the blog.
--
-- Reply nesting is ONE level: a reply's parent must itself be top-level. That
-- is not something a CHECK constraint can express (it needs to read another
-- row), so it is enforced by the server function that inserts a reply, the
-- same way RSVP's "not to a cancelled event" rule is app-enforced rather than
-- a constraint.

CREATE TABLE public.blog_comments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id UUID NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_comment_id UUID REFERENCES public.blog_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  hidden_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  hidden_at TIMESTAMPTZ,
  hidden_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX blog_comments_post_idx ON public.blog_comments (post_id, created_at);
CREATE INDEX blog_comments_parent_idx ON public.blog_comments (parent_comment_id);

-- ---------- blocked commenters ----------
-- Existence of a row = blocked from commenting anywhere on the blog. This is
-- the extreme moderation action, separate from hiding an individual comment.
CREATE TABLE public.blog_blocked_commenters (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT
);

-- SECURITY DEFINER so the comment-insert RLS policy (defence in depth, below)
-- can check block status without a client grant on blog_blocked_commenters —
-- an ordinary commenter has no business reading who else is blocked. Same
-- shape as public.has_role / public.has_active_paid_membership.
CREATE OR REPLACE FUNCTION public.is_commenter_blocked(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.blog_blocked_commenters WHERE user_id = _user_id)
$$;

REVOKE EXECUTE ON FUNCTION public.is_commenter_blocked(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_commenter_blocked(UUID) TO authenticated, service_role;

-- ---------- upvotes (one per person per comment, no downvote) ----------
CREATE TABLE public.blog_comment_upvotes (
  comment_id UUID NOT NULL REFERENCES public.blog_comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- ---------- Grants ----------
REVOKE ALL ON public.blog_comments FROM anon, authenticated;
-- Comments on a published post are public content, same reasoning (and same
-- "public funnel" server-function shape) as blog_posts.
GRANT SELECT ON public.blog_comments TO anon, authenticated;
GRANT ALL ON public.blog_comments TO service_role;

REVOKE ALL ON public.blog_blocked_commenters FROM anon, authenticated;
GRANT ALL ON public.blog_blocked_commenters TO service_role;

REVOKE ALL ON public.blog_comment_upvotes FROM anon, authenticated;
-- A signed-in reader needs to know THEIR OWN upvotes (to show the button as
-- pressed); totals are returned by the comment-listing server function via an
-- aggregate query on the service role, not by reading other people's rows, so
-- there is no anon grant.
GRANT SELECT ON public.blog_comment_upvotes TO authenticated;
GRANT ALL ON public.blog_comment_upvotes TO service_role;

ALTER TABLE public.blog_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_blocked_commenters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_comment_upvotes ENABLE ROW LEVEL SECURITY;

-- Anyone (including a logged-out visitor) can read visible comments on a
-- published post. A comment's author can always read their own, even hidden —
-- so they can see it was moderated rather than have it silently vanish.
-- Managers read everything, on any post, for the moderation queue.
CREATE POLICY "Anyone can read visible comments on published posts" ON public.blog_comments
  FOR SELECT USING (
    status = 'visible'
    AND EXISTS (SELECT 1 FROM public.blog_posts p WHERE p.id = post_id AND p.status = 'published')
  );
CREATE POLICY "Authors can read their own comments" ON public.blog_comments
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Managers can read all comments" ON public.blog_comments
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));

-- Writes run through server functions (blocked-user check, parent-must-be-
-- top-level check, honeypot) — no client write grant. Defence in depth below,
-- same idiom as event_rsvps.
CREATE POLICY "Signed-in non-blocked users can comment" ON public.blog_comments
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND NOT public.is_commenter_blocked(auth.uid()));
CREATE POLICY "Managers can moderate comments" ON public.blog_comments
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can read blocked commenters" ON public.blog_blocked_commenters
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can block a commenter" ON public.blog_blocked_commenters
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can unblock a commenter" ON public.blog_blocked_commenters
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Users can read their own upvotes" ON public.blog_comment_upvotes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can upvote as themselves" ON public.blog_comment_upvotes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can remove their own upvote" ON public.blog_comment_upvotes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
