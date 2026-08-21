import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contrastRatio,
  isSrgbGamut,
  oklchContrast,
  oklchToRgb,
  parseOklch,
  relativeLuminance,
  rgbToHex,
  type Oklch,
} from "./color-contrast";

describe("parseOklch", () => {
  it("reads the three-component form the theme uses", () => {
    expect(parseOklch("oklch(0.58 0.24 27)")).toEqual({ l: 0.58, c: 0.24, h: 27 });
    expect(parseOklch("  oklch( 1 0 0 )  ")).toEqual({ l: 1, c: 0, h: 0 });
    expect(parseOklch("oklch(70% 0.19 22deg)")).toEqual({ l: 0.7, c: 0.19, h: 22 });
  });

  // A translucent token has no fixed contrast, so it must not be mistaken for
  // one. `--border` and `--input` are written this way in the dark theme.
  it("refuses the alpha form and anything that is not oklch", () => {
    expect(parseOklch("oklch(1 0 0 / 10%)")).toBeNull();
    expect(parseOklch("#008eaa")).toBeNull();
    expect(parseOklch("var(--primary)")).toBeNull();
  });
});

describe("contrast maths", () => {
  it("matches the WCAG anchor points", () => {
    expect(contrastRatio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrastRatio([1, 1, 1], [1, 1, 1])).toBeCloseTo(1, 5);
    expect(relativeLuminance([1, 1, 1])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  });

  it("converts oklch to the sRGB a browser would paint", () => {
    // Pinned values, so a change to the matrices has to be deliberate. Note
    // `--primary` lands on #0089a7 and the brand teal in `@theme inline` is
    // #008eaa: the token approximates the brand colour by hand, it is not
    // derived from it, so this is the conversion being pinned, not the two
    // being reconciled.
    expect(rgbToHex(oklchToRgb({ l: 0.58, c: 0.11, h: 220 }))).toBe("#0089a7");
    expect(rgbToHex(oklchToRgb({ l: 1, c: 0, h: 0 }))).toBe("#ffffff");
  });

  it("reports the ratio the issue computed for the old dark destructive pair", () => {
    const wasRed: Oklch = { l: 0.7, c: 0.19, h: 22 };
    const wasWhite: Oklch = { l: 0.98, c: 0, h: 0 };
    expect(oklchContrast(wasRed, wasWhite)).toBe(2.75);
  });
});

// ---------------------------------------------------------------------------
// The theme tokens themselves.
//
// This is the half of the file that earns its keep. `styles.css` is the source
// of truth, so it is read rather than duplicated: a palette tweak that drops a
// pair below AA fails here instead of shipping.

const THEME_CSS = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8");

/** Custom properties declared in one selector block of `styles.css`. */
function tokensIn(selector: string): Record<string, string> {
  const start = THEME_CSS.indexOf(`\n${selector} {`);
  expect(start, `${selector} block missing from styles.css`).toBeGreaterThan(-1);
  const body = THEME_CSS.slice(start, THEME_CSS.indexOf("\n}", start));
  const declared: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/^\s*--([a-z-]+):\s*([^;]+);/gm)) {
    declared[name] = value.trim();
  }
  return declared;
}

const LIGHT = tokensIn(":root");
// `.dark` only restates what changes, so it inherits the rest from `:root` —
// exactly as the cascade does.
const DARK = { ...LIGHT, ...tokensIn(".dark") };
const THEMES = { light: LIGHT, dark: DARK } as const;

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/**
 * Every foreground/background pair the app actually paints together. The first
 * group is the `-foreground` pairings (a filled surface with its own ink); the
 * second is the tokens used as text ON a page surface, which is most of what
 * `--destructive` and `--muted-foreground` do.
 */
const PAIRS: ReadonlyArray<readonly [background: string, foreground: string]> = [
  ["background", "foreground"],
  ["card", "card-foreground"],
  ["popover", "popover-foreground"],
  ["primary", "primary-foreground"],
  ["secondary", "secondary-foreground"],
  ["muted", "muted-foreground"],
  ["accent", "accent-foreground"],
  ["destructive", "destructive-foreground"],
  ["sidebar", "sidebar-foreground"],
  ["sidebar-primary", "sidebar-primary-foreground"],
  ["sidebar-accent", "sidebar-accent-foreground"],
  ["background", "muted-foreground"],
  ["card", "muted-foreground"],
  ["background", "destructive"],
  ["card", "destructive"],
];

/**
 * Pairs that are below AA today and are NOT this file's to fix.
 *
 * This is an acknowledgement, not a pardon: the recorded ratio is asserted
 * exactly, so the pair cannot quietly get worse, and an entry that starts
 * passing fails the suite so it gets removed. Nothing may be added here to get
 * a red build green without the same reasoning written down.
 */
const KNOWN_BELOW_AA: Record<string, { ratio: number; why: string }> = {
  "light:primary/primary-foreground": {
    ratio: 3.99,
    why: "UTS Sport Teal #008eaa carrying white. Passes AA large (3:1) only. Fixing it means moving the club's brand colour, which is a decision for the club, not a palette tweak.",
  },
  "light:sidebar-primary/sidebar-primary-foreground": {
    ratio: 3.99,
    why: "The same teal, same call.",
  },
};

describe("theme token contrast", () => {
  const cases = (["light", "dark"] as const).flatMap((theme) =>
    PAIRS.map(([background, foreground]) => ({
      theme,
      background,
      foreground,
      key: `${theme}:${background}/${foreground}`,
    })),
  );

  it.each(cases)("$key", ({ theme, background, foreground, key }) => {
    const tokens = THEMES[theme];
    const bg = parseOklch(tokens[background] ?? "");
    const fg = parseOklch(tokens[foreground] ?? "");
    expect(bg, `--${background} is not an opaque oklch value in ${theme}`).not.toBeNull();
    expect(fg, `--${foreground} is not an opaque oklch value in ${theme}`).not.toBeNull();

    const ratio = oklchContrast(bg!, fg!);
    const known = KNOWN_BELOW_AA[key];
    if (known) {
      expect(ratio, `${key} changed; re-check whether it still belongs on the list`).toBe(
        known.ratio,
      );
      expect(
        ratio,
        `${key} is allowed below AA but must still clear AA large`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
      return;
    }
    expect(
      ratio,
      `${key} is ${ratio}:1 (${rgbToHex(oklchToRgb(bg!))} on ${rgbToHex(oklchToRgb(fg!))}), below WCAG AA for normal text`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("has no stale entries on the below-AA list", () => {
    for (const key of Object.keys(KNOWN_BELOW_AA)) {
      expect(
        cases.some((c) => c.key === key),
        `${key} is not a pair this file checks`,
      ).toBe(true);
    }
  });
});

describe("the destructive pair", () => {
  // The regression this file was written for: `bg-destructive` +
  // `text-destructive-foreground` on every delete/revoke button in the app.
  it("carries its own label in both themes", () => {
    expect(
      oklchContrast(parseOklch(LIGHT.destructive)!, parseOklch(LIGHT["destructive-foreground"])!),
    ).toBe(4.65);
    expect(
      oklchContrast(parseOklch(DARK.destructive)!, parseOklch(DARK["destructive-foreground"])!),
    ).toBe(6.72);
  });

  // The other half of the token's job, and the reason the dark red itself was
  // left alone: `text-destructive` is how every form error and failed-submit
  // panel is coloured, on the page and inside a card.
  it("stays readable as error text on both surfaces", () => {
    for (const [theme, tokens] of Object.entries(THEMES)) {
      const red = parseOklch(tokens.destructive)!;
      for (const surface of ["background", "card"] as const) {
        expect(
          oklchContrast(parseOklch(tokens[surface])!, red),
          `--destructive on --${surface} in ${theme}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  // Out-of-gamut oklch is clipped here and gamut-mapped by a browser, so the
  // two only agree while the colours fit in sRGB. The dark pair is the one this
  // change chose, so it is the one held to that.
  it("is inside the sRGB gamut, so the computed ratio is the painted one", () => {
    expect(isSrgbGamut(parseOklch(DARK.destructive)!)).toBe(true);
    expect(isSrgbGamut(parseOklch(DARK["destructive-foreground"])!)).toBe(true);
  });
});
