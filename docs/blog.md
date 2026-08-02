# Blog

The public blog: posts written by managers, read by anyone, with a comment
section any signed-in person can take part in. Schema reference:
`docs/database.md`'s "Blog" section — keep that in sync with this document and
the migrations, in the same change.

## The model in one paragraph

A **post** (`blog_posts`) is written and published by a manager; only
`published` posts are ever shown to the public, `draft` ones are visible only
in the manager area. A **comment** (`blog_comments`) belongs to a post and to
the person who wrote it, and may be a reply to one other comment — nesting
goes one level deep, no replies-to-replies. Anyone signed in may **upvote** a
comment once (`blog_comment_upvotes`); there is no downvote. A manager may
**hide** an individual comment (it stays in the database, just not shown
publicly) or, in the extreme case, **block** a person from commenting
anywhere on the blog (`blog_blocked_commenters`) — those are two different
severities of moderation, not the same action.

## Rules

1. **Only a manager can write or publish a post.** Finer-grained authoring
   permissions (e.g. a "contributor" role that can draft but not publish) are
   a later step, not built yet.
2. **A draft is invisible to the public**, full stop — not listed, not
   reachable by URL, not in the sitemap. Only `getBlogPostForEdit` (manager-only)
   and `listAllBlogPosts` (manager-only) can see one.
3. **Any signed-in person may comment, reply, or upvote — membership status is
   irrelevant.** A lead who only registered interest can't (they have no
   login); a lapsed member, a trial visitor, an active paying member, and a
   manager all can, on equal footing. Nobody who isn't signed in can post —
   they see a "log in to comment" prompt instead of a compose box, but can
   still **read** every visible comment.
4. **Reply nesting is one level.** A reply's own parent must itself be a
   top-level comment; the server rejects a reply-to-a-reply rather than
   silently flattening it, so the UI's "one level of indentation" assumption
   always holds.
5. **An upvote is once per person per comment, and there is no downvote.**
   Upvoting again removes it (a toggle), it doesn't add a second one.
6. **Hiding a comment and blocking a person are different actions.** Hiding
   removes one comment from public view — today it simply disappears from the
   post for everyone, including its own author; the `blog_comments` RLS policy
   already permits an author to read their own row directly regardless of
   status (`user_id = auth.uid()`, no status filter), but `listComments` (what
   the blog page actually calls) doesn't yet use that to show a "hidden by a
   moderator" state to the author — see Future features. Blocking stops a
   person from posting _any future_ comment anywhere on the blog — it does
   nothing to comments they already posted, which stay exactly as they were
   (hide those separately if needed).
7. **A post's body is Markdown**, rendered the same way the waiver template
   is (`react-markdown`). A line of the form `[[video:<url>]]` embeds a video
   instead of being treated as text — a YouTube link renders as a real
   embedded player; any other link renders as a plain "Watch the video ↗"
   link. Photos are inserted as ordinary Markdown images pointing at the
   `blog-media` Storage bucket.
8. **A comment's body is plain text**, not Markdown — no formatting, no
   embedded photos or videos in comments. This is a deliberate scope line for
   now (see Future features).
9. **A commenter's display name is their own choice, not their legal name.**
   `profiles.display_name` is an optional override a person sets in their
   account settings; when unset, the name shown is derived — first (or
   preferred) name plus last initial (`commentDisplayName` in
   `src/lib/validation.ts`), e.g. "Jane L." — never their full name pulled
   from waiver data onto a public comment. Every person has a first name
   (`profiles.first_name` is NOT NULL and non-blank), so the derived name is
   always something; the bare word "Member" now only shows for an auth user
   created outside the product with no name and no usable email, which is what
   `ensure_profile` seeds as its last resort. The name is resolved live at read
   time, so changing it later re-labels their past comments too (it isn't
   frozen at post time, unlike a waiver's evidence fields).

## Flows

### A visitor reads the blog

`/blog` lists published posts, newest first, paginated. `/blog/:slug` renders
one post; a slug with no published post behind it is a real 404 (the router's
own not-found page), not a soft "not found" page — see the SEO note below.
Comments render underneath: top-level comments each with their replies
indented once, an upvote count and button on every comment, and either a
compose box (signed in) or a "log in to comment" prompt (signed out). This
works exactly the same whether the reader has ever trained at the club or
not — the blog carries no membership gate.

### Someone comments, replies, or upvotes

All three go through server functions (`postComment`, and the same function
handles a reply by passing `parent_comment_id`; `toggleCommentUpvote`), the
same `createServerFn` pattern used everywhere else in the app — not something
only reachable through the web UI. `postComment` checks, in order: the post is
published, the commenter isn't in `blog_blocked_commenters`, and — for a
reply — the parent comment belongs to the same post and is itself top-level.
A honeypot field (`hp`) silently no-ops a submission a bot filled in, the same
convention as every other public form.

### A manager writes and publishes a post

`/manager/blog` lists every post regardless of status; "New post" opens the
composer (`/manager/blog/new`), an existing one opens for editing
(`/manager/blog/:id`). The composer is a Markdown textarea with a small
formatting toolbar (bold/italic/heading/list/link), an "Insert image" button
(uploads to `blog-media`, inserts a Markdown image), an "Insert video" dialog
(YouTube links embed inline; anything else shows as a plain link), a separate
cover-image uploader, a status picker (draft/published) that warns before
saving a currently-published post back to draft, and a live preview rendered
the same styled way the public page renders it. Saving with no slug set
derives one from the title (`slugify` in `src/lib/slug.ts`, normalized
on blur too) and resolves a collision by appending `-2`, `-3`, and so on.
`published_at` is stamped the first time a post goes live and **never changes
again** — not on a later edit, and not on an unpublish/republish round trip —
so a post's publish date and its position in the public list (sorted by
`published_at`) both stay stable regardless of how many times it's drafted
and republished. The editor warns before an unpublish and guards against
losing unsaved work (a confirm on leaving, and a browser close/refresh
warning) the same way the waiver template editor does.

### A manager moderates

`/manager/blog-comments` lists every comment across every post (visible and
hidden), with the commenter's display name **and** their real name/email for
accountability, and two actions: **Hide** (optionally with a reason, shown
back to the manager on the row) and **Block author** — a confirm-guarded
action since it's the extreme option, since it stops the person from
commenting anywhere, not just on this post. The same page has a "Blocked
commenters" panel listing everyone currently blocked, each with an **Unblock**
button.

## SEO

`/blog` is a normal entry in `PUBLIC_PAGES` (`src/lib/seo.ts`), like any other
marketing page. `/blog/:slug` is different: it's the site's first _dynamic_
public page, so there's no way to list every real post URL in a static array.
Its `head()` sets a per-post canonical, title, description and `BlogPosting`
JSON-LD from loader data, so each post is fully indexable — it's just not
enumerated in `PUBLIC_PAGES` (`src/lib/seo.test.ts` has a dedicated check that
this dynamic route still declares a canonical and is never accidentally
`noindex`, in place of the literal-path check every static page gets). A slug
with no published post behind it throws `notFound()` from the route's loader,
which is a real 404, not a "soft 404" page a crawler could index.

## Future features (out of scope today)

- **Showing an author their own hidden comment.** `listComments` filters
  strictly to `status = 'visible'` for everyone, including the comment's own
  author — a hidden comment just disappears, with no "hidden by a moderator"
  state shown to them. The RLS policy needed for this already exists
  (`blog_comments`'s "Authors can read their own comments"); wiring it up
  needs `listComments` (currently a plain public read, no session) to
  optionally resolve the caller's identity.
- **Finer-grained authoring permissions** (e.g. a contributor who can draft
  but not publish) — today it's manager-or-nothing.
- **Formatting or media in comments** — comments are plain text on purpose for
  now; Markdown or image attachments in a comment are a deliberate non-goal
  until there's a real request for them.
- **Deeper reply nesting** — one level today (Disqus-style), not unlimited
  threads.
- **Per-post entries in the XML sitemap** — `/blog` is listed; individual post
  URLs aren't yet enumerated there (they're still fully indexable via their
  own canonical + on-site links from `/blog`, just not pre-declared in the
  static sitemap file).
- **Extending the manager-agent HTTP API** (`/api/manager/agent`) with
  `create_blog_post` / `publish_blog_post` actions, so a manager's scripted
  tooling or AI agent could author posts the same way it already edits
  invoices and files waivers. Not built — every write today is reachable only
  through the ordinary web-session server functions.
- **A "top" comment sort** — comments are shown oldest-first only.
- **Video file uploads** — videos are embed-by-link only (YouTube renders
  inline; other providers show as a plain link), to avoid storage/bandwidth
  cost for a small club site.
