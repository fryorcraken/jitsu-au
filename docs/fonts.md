# Fonts

The site's typeface is **Nunito Sans**, served from this origin. There is no
request to Google, or to any other third party, for a font.

## Why it is not on Google Fonts

Loading the stylesheet from `fonts.googleapis.com` made every visitor's browser
contact Google before they had interacted with anything, disclosing their IP
address and user agent. That happened on the public marketing pages, so it
applied to people who had never signed up to anything and had no relationship
with the club.

Nothing was lost by moving it. Two files totalling under 60KB, served from the
same origin as the page, beat a cross-origin CSS round-trip that then has to
discover which font files it needs.

`src/lib/fonts.test.ts` fails if any file under `src/` references a Google font
host again. That check exists because reintroducing it is one ordinary-looking
line and the page renders identically either way.

## What is in the repo

```
public/fonts/nunito-sans-latin.woff2       ~31KB
public/fonts/nunito-sans-latin-ext.woff2   ~28KB
public/fonts/OFL.txt                       the licence, which has to travel with them
```

Both are **variable** fonts with a `wght` axis running 200 to 1000, so one file
per subset covers every weight the site uses. Google's own CSS gives the game
away here: it returns the same URL for 400, 600, 700 and 900.

The `@font-face` rules are at the top of `src/styles.css`, with the
`unicode-range` for each subset. The ranges matter: the browser fetches
`latin-ext` only for a page that actually contains an accented character, which
on this site means a member's name, so the common case pays for `latin` alone.
That is also why only `latin` is preloaded in `src/routes/__root.tsx`.

## Licence

SIL Open Font License 1.1, which permits self-hosting. It requires the copyright
notice and licence to be distributed with the font files, which is what
`public/fonts/OFL.txt` is for. Do not delete it, and do not sell the fonts on
their own.

## Refreshing the files

Only needed to pick up a new version of the typeface. The files are stable
otherwise, so this is not routine maintenance.

1. Fetch the stylesheet with a browser user agent, so Google serves `woff2`
   rather than an older format:

   ```
   curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
     "https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700;900&display=swap"
   ```

2. Take the `latin` and `latin-ext` URLs. The other subsets Google returns
   (`cyrillic`, `cyrillic-ext`, `vietnamese`) are deliberately not shipped: with
   `unicode-range` in place the browser falls back per character for anything
   they would have covered, which is the standard trade and keeps the download
   small.

3. Download both, replacing the files above under the same names.

4. Copy the `unicode-range` values from that same stylesheet into the
   `@font-face` rules in `src/styles.css`. They change between font versions,
   and a stale range means a character silently renders in the fallback font.

5. Check the weight axis still covers what the site asks for:

   ```
   python3 -c "from fontTools.ttLib import TTFont; f=TTFont('public/fonts/nunito-sans-latin.woff2'); print([(a.axisTag, a.minValue, a.maxValue) for a in f['fvar'].axes])"
   ```

6. Look at the site. A broken `@font-face` is silent: the fallback stack takes
   over and every page renders in the system UI font, which is legible enough
   that a test suite will not notice and a person skimming might not either.
