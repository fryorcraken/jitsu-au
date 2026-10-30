# The site banner

A one-line notice across the top of every public page, for news a visitor
should see before anything else: free trials paused while the club trains at a
temporary location, a closure, a grading day. A manager writes it and turns it
on or off; nobody has to change code to do either.

## Who sees what

- **Visitors** see it above the header on every page that uses the public
  layout, until they close it. When it is off, nothing renders at all: no empty
  bar, no gap.
- **Closing it is per message.** The browser remembers which banner it closed
  (a fingerprint of the message and the link), so a new message, or the same
  message with a new link, is shown again to everybody. Turning the same notice
  off and back on does not bring it back for someone who already closed it.
- **The link is dropped on the page it points at.** On `/register-interest`, a
  banner linking there still shows its message (it is the most useful place for
  "free trials are paused") but not a link to the page you are already on.
- **A failed read shows no banner.** It is a notice, not something a visitor is
  waiting on, so the page renders without it rather than with an error where it
  would be. The failure is logged.
- **Changes reach visitors within a few minutes.** The banner is fetched once
  and cached for five minutes in a visitor's open tab; a fresh page load gets
  the current one. The manager who saved sees it at once.

## Managers

`/manager/site-banner` ("Site banner" in the manager sidebar), and the manager
agent API's `get_site_banner` / `save_site_banner` (`docs/manager-agent-api.md`).
Both read and write the same stored value the same way.

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
- The address is a page on this site (`/register-interest`) or a full
  `https://` address. Nothing else, so a `javascript:` or `http:` link can never
  reach the top of every page. `//host` is refused because a browser reads it
  as another site.
- Anything stored that would not pass these rules today reads as off.

A banner that has never been set is off. The free-trial offer that used to be
hard-coded here is gone; what the banner says is now entirely the club's
setting.

## Where it lives

Stored as JSON under the `site_banner` key of `club_settings`
(`docs/database.md`). That table is manager-only under RLS and holds things no
visitor may see, so visitors do **not** read it directly: `getSiteBanner`
(`src/lib/site-banner.functions.ts`) reads that one hardcoded key through the
service role and returns only the parsed banner. It takes no input, so nothing
a caller sends can widen what it reads. No migration was needed.
