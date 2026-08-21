// WCAG contrast maths for the theme tokens in `src/styles.css`.
//
// This exists because a contrast ratio is computable and was not being
// computed. The dark-mode destructive pair shipped at 2.75:1 (below even the
// 3:1 large-text floor) because the red was lightened by eye to sit well on a
// dark ground while its foreground stayed near-white. Nobody could have caught
// that by looking: both colours are individually fine, it is the pair that
// fails, and the failure is a number.
//
// The tokens are written in `oklch()`, which no test runner can resolve on its
// own (jsdom does not do colour conversion), so the whole path is here:
// oklch -> OKLab -> linear sRGB -> gamma-encoded sRGB -> relative luminance.
// The OKLab matrices are Björn Ottosson's published constants; the luminance
// and ratio formulae are WCAG 2.1 §1.4.3.
//
// One deliberate simplification: an out-of-sRGB-gamut oklch value is clipped
// per channel, where a browser gamut-maps by reducing chroma. Keep the tokens
// inside sRGB (`isSrgbGamut` says whether one is) and the two agree.

/** An oklch colour: lightness 0-1, chroma, hue in degrees. */
export type Oklch = { l: number; c: number; h: number };

/** sRGB channels, each 0-1, gamma-encoded (i.e. what a `#rrggbb` holds). */
export type Rgb = [number, number, number];

const OKLCH_PATTERN = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*\)$/i;

/**
 * Parse an `oklch(L C H)` string. Returns null for anything else, including the
 * `oklch(1 0 0 / 10%)` alpha form: a translucent token has no fixed contrast
 * (it depends what is behind it), so callers must not treat one as a colour.
 */
export function parseOklch(value: string): Oklch | null {
  const match = OKLCH_PATTERN.exec(value.trim());
  if (!match) return null;
  const number = (raw: string) =>
    raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  return { l: number(match[1]), c: number(match[2]), h: Number.parseFloat(match[3]) };
}

/** oklch -> linear-light sRGB, unclamped, so out-of-gamut values stay visible. */
function toLinearSrgb({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);

  const lCone = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
    -1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
    -0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
  ];
}

const encode = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);
const decode = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const clamp = (u: number) => Math.min(1, Math.max(0, u));

/** True when the colour survives the trip to sRGB without a channel clipping. */
export function isSrgbGamut(colour: Oklch, tolerance = 0.001): boolean {
  return toLinearSrgb(colour).every((u) => {
    const encoded = encode(u);
    return encoded >= -tolerance && encoded <= 1 + tolerance;
  });
}

/** oklch -> gamma-encoded sRGB, clipped into range. */
export function oklchToRgb(colour: Oklch): Rgb {
  return toLinearSrgb(colour).map((u) => clamp(encode(u))) as Rgb;
}

/** `#rrggbb`, for putting a real colour in a failure message. */
export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(decode);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast ratio between two oklch tokens, rounded to two decimals. */
export function oklchContrast(background: Oklch, foreground: Oklch): number {
  const ratio = contrastRatio(oklchToRgb(background), oklchToRgb(foreground));
  return Math.round(ratio * 100) / 100;
}
