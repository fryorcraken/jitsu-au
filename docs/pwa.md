# Installable app (PWA)

The site is installable: on Android and desktop Chrome the browser offers "Install
app", and on iOS Safari's "Add to Home Screen" produces the same thing. Installed,
it runs without browser chrome, with the club logo as its icon.

Nothing about the website changes for people who never install it.

## What a launch does

Tapping the icon opens `start_url`, which is `/app` — a route that renders nothing
of its own. It works out who is holding the phone and forwards them, replacing the
history entry so the launch route never shows up when you press back:

| On launch                        | Lands on                 |
| -------------------------------- | ------------------------ |
| The app was open in the last day | The screen it was on     |
| Signed in                        | `/account` (member area) |
| Signed out                       | `/` (public home page)   |

Signed out means the home page even for a member whose session has lapsed. There
is no self-serve sign-up, so sending every signed-out launch to the sign-in screen
would strand a prospective member on a form they cannot use, and a member who is
signed out reaches "Member login" from the home page header in one tap.

The rule itself lives in `resolveLaunchScreen` (`src/lib/pwa.ts`) and is unit
tested in `src/lib/pwa.test.ts`; `src/routes/app.tsx` is only the wiring.

### Coming back to where you were

The installed app has no "resume". When a phone reclaims it in the background,
the next tap on the icon is a **cold launch at `start_url`**, so somebody
half-way through an article, or reading tonight's roster, used to come back to
the member home page with nothing to say anything had been lost. From the
outside that is indistinguishable from the app reloading itself, and it was
half of why it felt so eager to.

So the root component records where the app is on every navigation
(`src/lib/last-visit.ts`) and `/app` reads it back through
`resolveLaunchTarget`. It returns you there only when all of this holds:

- it was **within the last day** (`LAUNCH_RESUME_WINDOW_MS`);
- the **signed-in state matches** what it was. Somebody who has signed out
  since must not be dropped on a manager screen and bounced straight to the
  sign-in page, and somebody who has since signed **in** wants their member
  area, not the marketing page they were reading beforehand;
- the path is **resumable**. Not the launch route (which would loop), not the
  auth screens, and nothing carrying a token in its path —
  `/email-settings/<token>` consumes its token and redirects, so returning to
  it lands on a URL that no longer works;
- the path is **plain and site-relative**. This value is read back off the
  device, which makes it the one input here that anything with a script foothold
  on the origin could choose, so `isResumablePath` is strict rather than relying
  on what the router happens to do with a bad value: a protocol-relative
  `//host` (another origin to a browser), any backslash, any control character
  or whitespace, and any traversal (raw or percent-encoded) are all refused, and
  the blocklist matches case-insensitively.

`isResumablePath` gates the **write** as well as the read. Recording a path the
app would refuse to reopen still puts it on the device for a day, and an auth
link lands with its PKCE `code` or `token_hash` in the query string.

The record is owner-scoped like everything else in `local-cache`, so a shared
club laptop never sends the next person to the last manager's screen.

Android and desktop also get manifest **shortcuts** (long-press / right-click the
icon): Your account, Class calendar, Class times.

## Files

| File                                | What it is                                                      |
| ----------------------------------- | --------------------------------------------------------------- |
| `public/manifest.webmanifest`       | Name, icons, theme colour, `start_url`, scope, shortcuts        |
| `public/icons/*`                    | Generated icon set (192/512 plain, 192/512 maskable, iOS touch) |
| `public/sw.js`                      | The service worker                                              |
| `public/offline.html`               | The card shown when a page is opened with no connection         |
| `src/lib/pwa.ts`                    | The launch rule, and the resume rule                            |
| `src/lib/last-visit.ts`             | Where the app was, recorded on every navigation                 |
| `src/lib/local-cache.ts`            | The versioned, owner-scoped device storage all of this uses     |
| `src/hooks/use-persistent-query.ts` | A query whose answer survives the app being closed              |
| `src/lib/service-worker.ts`         | Registration (production only)                                  |
| `src/routes/app.tsx`                | The `start_url` route                                           |
| `scripts/generate-pwa-icons.mjs`    | Regenerates the icons from `public/logo.png`                    |

The manifest link, theme colour and iOS meta tags are in `src/routes/__root.tsx`
alongside the rest of the site's head.

## Why the app used to reload itself constantly

Worth knowing before adding anything that reacts to an auth event or a window
focus, because all three of these looked reasonable in isolation.

**supabase-js re-announces the session on every visibility change.** Its
`_onVisibilityChanged` runs `_recoverAndRefresh`, which emits a fresh
`SIGNED_IN` whenever it finds a usable stored session. That is not a sign-in.
It is the same person, the same token, said again, on every tab switch, every
phone unlock and every return to the installed app. `__root.tsx` took it at
face value and invalidated every route loader and every cached query.
`resolveAuthRefresh` (`src/lib/auth-events.ts`) makes the rule about **identity**
instead: refresh when the signed-in person actually changes. It also ignores the
first event of a page's life, since that is the session the page loaded with and
there is nothing on screen that predates it — which is what stopped every cold
start fetching its data twice.

**`useAuth` re-set its state from those announcements.** supabase builds a new
`Session` object each time, so comparing by reference made every return to the
app look like a change and re-rendered most of the signed-in app. It now holds
the objects steady while the person and their access token are unchanged, and
still moves on a real `USER_UPDATED`.

**React Query ran on its own defaults.** `staleTime: 0` plus
`refetchOnWindowFocus: true` means every mounted query re-asks the server on
every focus. `src/router.tsx` now sets 30s fresh, focus refetch **off**,
reconnect refetch **on** (a phone that has just found signal is the one moment
worth interrupting for), and one retry rather than three.
`defaultPreloadStaleTime` moved off 0 as well, so a hover preload survives long
enough for the tap to use it instead of being thrown away and re-fetched.

## The service worker

It is deliberately minimal, because almost everything worth looking at on this site
is live data (your membership, the calendar, a waiver) that must never come from a
stale cache.

- **Pages always come from the network.** If the network is gone you get
  `offline.html` instead of the browser's error page. No HTML is ever cached, so
  a signed-in page can never be served to someone else on the same device.
- **Static assets** (scripts, styles, fonts, images) are served from cache and
  refreshed in the background, so a launch on a bad connection still paints. The
  asset cache is capped at `MAX_ASSET_ENTRIES` and drops its oldest entries past
  that: build assets are content-hashed, so every deploy adds a fresh set of URLs
  that nothing will ever ask for again, and an install that hoards them can get
  its whole origin storage reclaimed by the browser, auth session included.
- **Nothing else is intercepted.** Supabase calls and server functions are `fetch`
  requests with an empty `destination`, so they fall straight through.

### What is kept on the device, and what is not

The service worker deliberately caches no HTML at all (above). Everything else
this app keeps on a device goes through **`src/lib/local-cache.ts`**, which is
the only place that writes to `localStorage` for these purposes, and which
enforces the three rules that make it safe to rely on:

- **Versioned.** A value written by an older build is discarded rather than
  half-read.
- **Owned.** Every entry records the user id it was written for. A different
  person reads nothing, and signing out wipes everything belonging to whoever
  was signed in (`clearCacheFor`, called from `__root.tsx` on the
  decision `resolveAuthRefresh` returns). This is what keeps one member's data
  off the next member's screen on a shared club laptop. The rule lives in that
  pure function rather than as a condition in the component, because a privacy
  guarantee that exists only as untested wiring is not one -- and this one was
  broken exactly that way before it moved: identity was adopted only from
  `SIGNED_IN`, but the first event any subscriber gets is `INITIAL_SESSION`, so a
  returning member's tab never learned who they were and signing out wiped
  nothing at all.
- **Dated.** Every entry carries a write time, so a caller can refuse one that
  is too old and a screen can say how old what it is showing is.

| What                                | How long | Why that long                                                                                                                           |
| ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge base sidebar and articles | 7 days   | The club's own handbooks and policies. They change a few times a year, and a member on the mat reading last week's copy is served well. |
| Check-in class list and roster      | 24 hours | Carries members' names and emails, and memberships are raised between classes. Older than a day is a wrong answer, not a convenience.   |
| Unsaved editor drafts               | 14 days  | Long enough to survive being forgotten about, short enough that an offer to restore is a rescue rather than a puzzle.                   |
| Where the app was                   | 24 hours | See "Coming back to where you were".                                                                                                    |
| The needs-attention check-in list   | never    | A worklist. A stale one sends a manager chasing check-ins somebody already fixed.                                                       |

`usePersistentQuery` is the seam: it seeds a React Query from the device during
render (not in an effect, which would flash the spinner it exists to remove) and
refreshes behind it. A refresh that **fails** leaves the stored copy on screen
under a `StaleNotice` saying when it was fetched, rather than blanking the page.
A screen using it must therefore key its "not available" branch on _having no
data_, not on `isError` — otherwise a failed refresh hides a perfectly good
cached copy. That mistake has been made twice already in this
codebase, once on `/kb/<slug>` and once in `useKbNav` (where it blanked the whole
sidebar behind an error panel), so a hook wrapping one of these should do the
gating itself and hand its callers a plain `error` that is only set when there is
genuinely nothing to show.

Opting a new query in is a judgement, not a default: the data has to be worth an
offline read **and** being a few minutes out of date has to be honest rather
than misleading. Its stored shape is declared with Zod (`kb-cache.ts`,
`checkin-cache.ts`) so reading back what an older build wrote can never throw
during a render.

It only registers in production builds. In dev it actively unregisters itself:
a worker picked up from a production visit would otherwise sit in front of the Vite
dev server and serve yesterday's assets.

Bump `CACHE_VERSION` in `public/sw.js` to throw away every cached asset on the next
deploy. You should not normally need to: build assets are content-hashed, so a
deploy changes their filenames anyway.

## Regenerating the icons

`node scripts/generate-pwa-icons.mjs` rebuilds `public/icons/` from
`public/logo.png`. It has no dependencies (Node's own zlib does the work), so run
it after replacing the logo and commit the result.

Maskable icons keep the logo inside the middle 60% of the square, because Android
crops them to whatever shape the launcher uses.
