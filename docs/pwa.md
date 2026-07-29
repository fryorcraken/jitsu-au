# Installable app (PWA)

The site is installable: on Android and desktop Chrome the browser offers "Install
app", and on iOS Safari's "Add to Home Screen" produces the same thing. Installed,
it runs without browser chrome, with the club logo as its icon.

Nothing about the website changes for people who never install it.

## What a launch does

Tapping the icon opens `start_url`, which is `/app` — a route that renders nothing
of its own. It works out who is holding the phone and forwards them, replacing the
history entry so the launch route never shows up when you press back:

| On launch                                            | Lands on                  |
| ---------------------------------------------------- | ------------------------- |
| Signed in                                            | `/account` (member area)  |
| Signed out, but someone has signed in on this device | `/auth?redirect=/account` |
| Signed out, nobody has ever signed in on this device | `/` (public home page)    |

The middle row is the reason the rule is not simply "signed out goes home". Tapping
an installed icon is a stronger signal than opening a website, so a member whose
session has lapsed should get the sign-in screen, not the marketing page. The last
row is why it is not simply "signed out goes to sign-in": there is no self-serve
sign-up, so a prospective member who installed the app off the website would be
staring at a form they cannot use.

"Has signed in on this device" is a flag in `localStorage`
(`uts-jitsu.pwa.known-member`), written whenever Supabase reports a sign-in and
whenever the launch route finds a live session. It survives sign-out on purpose:
the next launch should still offer to sign back in.

The rule itself lives in `resolveLaunchScreen` (`src/lib/pwa.ts`) and is unit
tested in `src/lib/pwa.test.ts`; `src/routes/app.tsx` is only the wiring.

Android and desktop also get manifest **shortcuts** (long-press / right-click the
icon): Your account, Class calendar, Class times.

## Files

| File                             | What it is                                                      |
| -------------------------------- | --------------------------------------------------------------- |
| `public/manifest.webmanifest`    | Name, icons, theme colour, `start_url`, scope, shortcuts        |
| `public/icons/*`                 | Generated icon set (192/512 plain, 192/512 maskable, iOS touch) |
| `public/sw.js`                   | The service worker                                              |
| `public/offline.html`            | The card shown when a page is opened with no connection         |
| `src/lib/pwa.ts`                 | The launch rule and the "known member" flag                     |
| `src/lib/service-worker.ts`      | Registration (production only)                                  |
| `src/routes/app.tsx`             | The `start_url` route                                           |
| `scripts/generate-pwa-icons.mjs` | Regenerates the icons from `public/logo.png`                    |

The manifest link, theme colour and iOS meta tags are in `src/routes/__root.tsx`
alongside the rest of the site's head.

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
