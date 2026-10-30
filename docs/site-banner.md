# The site banner

A one-line notice across the top of every public page, for news a visitor
should see before anything else: free trials paused while the club trains at a
temporary location, a closure, a grading day. A manager writes it and turns it
on or off; nobody has to change code to do either.

## Who sees what

- **Visitors** see it above the header on every page that uses the public
  layout, until they close it. When it is off, nothing renders at all: no empty
  bar, no gap.
- **It arrives with the page.** The root route's loader reads it, so the server
  draws it into the HTML and nothing jumps down when the page finishes loading.
  That matters on a phone: a bar that appears a second late moves the page
  under somebody's thumb, and their tap lands on the banner instead.
- **Closing it is per message, and kept in a cookie.** The cookie holds a
  fingerprint of the message and the link, and the server reads it before it
  draws the page, so a closed banner never flashes up again. A new message, or
  the same message with a new link, is shown again to everybody. Turning the
  same notice off and back on does not bring it back for someone who already
  closed it. (A cookie and not localStorage for exactly that reason: the server
  cannot read localStorage.)
- **The link is dropped where following it would hurt.** The message still
  shows in both cases:
  - on the forms (`/waiver`, `/register-interest`, `/contact`), because the whole
    line is a tap target and a stray tap would carry somebody away from a form
    they are partway through. The waiver holds health answers and a signature.
  - on the page the link points at, since a link to where you already are does
    nothing useful. A link to a section of that page (`/faq#trial` on `/faq`) is
    kept, because jumping to it is the point.
- **A link to this site stays in the app.** A page here, or a full address to
  this site (`https://utsjitsu.com.au/classes`), moves within the app when
  tapped rather than reloading it. Other sites open as an ordinary link.
- **A failed read shows no banner.** It is a notice, not something a visitor is
  waiting on, so the page renders without it rather than with an error where
  it would be. The failure is logged.
- **When a change reaches people.** Every fresh page load reads the current
  banner (nothing caches it, because the answer depends on the visitor's cookie
  and a manager must see their own save). Moving between pages in a tab that is
  already open reuses what that tab read for up to five minutes. The manager who
  saved sees it on their next page straight away.

## Managers

`/manager/site-banner` ("Site banner" in the manager sidebar), and the manager
agent API's `get_site_banner` / `save_site_banner` (`docs/manager-agent-api.md`).
Both read and write the same stored value the same way, with one difference:
**over the API the link can only be a page on this site.** An outside address
across the top of every page is what a leaked token would want (a club-branded
"pay here" link), so that is set on the screen, signed in. A stored outside link
is kept when an agent changes something else.

- **One switch, a message, and an optional link** (link text plus where it
  goes). One Save puts all of it live together, with a preview that updates as
  you type.
- **No confirm.** It is undone the same way it is done, and the preview already
  shows exactly what visitors will get.
- **The message survives being switched off**, so a recurring notice can be
  turned off and on again without retyping it.
- **If the current banner cannot be read, there is no form**, only the failure
  panel: an empty form would invite saving a blank banner over a live one.

## The rules (`siteBannerSchema` in `src/lib/validation.ts`)

- The message is one line of up to 200 characters; line breaks become spaces.
  It must not be empty while the banner is on.
- The link is optional, but its text (up to 60 characters) and its address come
  together or not at all.
- The address is a page on this site (`/register-interest`, with a `?query` or
  `#section` if needed) or a full `https://` address. Nothing else, so a
  `javascript:` or `http:` link can never reach the top of every page. `//host`
  and `/\host` are refused because a browser reads both as another site.
- Anything stored that would not pass these rules today reads as off.

A banner that has never been set is off. The free-trial offer that used to be
hard-coded here is gone; what the banner says is now entirely the club's
setting.

## Where it lives

Stored as JSON under the `site_banner` key of `club_settings`
(`docs/database.md`). That table is manager-only under RLS and holds things no
visitor may see, so visitors do **not** read it directly: `getSiteBanner`
(`src/lib/site-banner.functions.ts`) reads that one hardcoded key through the
service role and returns only the parsed banner (or null, when it is off or
this visitor closed it). It takes no input beyond the dismissal cookie, which
can only make it return less, so nothing a caller sends can widen what it
reads. The root route's loader (`src/routes/__root.tsx`) calls it. No migration
was needed.
