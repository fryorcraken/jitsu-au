# Answer only: how the live site's Referrer-Policy behaves

You asked a question, so no code will change.

## What the live site sends (checked 2026-10-30)
Every address tested returns `referrer-policy: strict-origin-when-cross-origin`, plus HSTS and `x-content-type-options: nosniff`:
- `/` (a server-rendered page)
- `/email-settings/x`, `/api/calendar/x` and `/api/verify-email/x` (these three also return `cache-control: no-store`, which only the app sets)
- `/favicon.png` (a static file)

## Answers
1. **Does the hosting set or override it?** I can see it happening, but I can't find it documented. The value is always `strict-origin-when-cross-origin`, the same as the platform's HSTS and nosniff headers. It replaces the app's `no-referrer` even when the app's response clearly got through (that's what the `no-store` proves). Lovable's hosting docs don't mention response headers.
2. **Does the hosting read `_headers`?** Not documented. These results show it isn't honoured for these paths, or something applied later overrides it. Which rule wins when `/*` and a more specific rule both match is unknown here.
3. **Supported way to set a per-route value?** None is documented. Two options that don't depend on the header:
   - Set `<meta name="referrer" content="no-referrer">` on `/email-settings`.
   - Set `referrerpolicy="no-referrer"` or `rel="noreferrer"` on its outgoing links.
   - The two API paths are JSON or calendar responses with no links, so they leak nothing through Referer anyway.

   If the header itself must reach the browser, Lovable staff would need to say whether the hosting can stop replacing an app-set `Referrer-Policy`.
