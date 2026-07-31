// Regenerates the PWA icon set in public/icons/ from the club logo.
//
// Run with: node scripts/generate-pwa-icons.mjs
//
// Deliberately dependency-free: the repo has no image library, and adding one
// for a handful of icons that change roughly never is not worth the install.
// Node's zlib does the compression; the PNG container is small enough to read
// and write by hand (the source logo is 8-bit RGBA, non-interlaced).

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentBounds, computeRenderGeometry } from "./pwa-icon-geometry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "public", "logo.png");
const OUT_DIR = join(root, "public", "icons");

// UTS Sport Teal (`--color-brand-teal` in styles.css), with the wordmark
// recoloured white on top of it. Keeps every icon opaque, which is what iOS
// wants for the home-screen icon.
const BACKGROUND = [0, 142, 170];
const FOREGROUND = [255, 255, 255];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Decode an 8-bit, non-interlaced PNG into flat RGBA pixels. */
function decodePng(buf) {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG");
  }
  let offset = 8;
  let header;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.depth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.colorType)) {
    throw new Error(
      `unsupported PNG: depth ${header.depth}, colour type ${header.colorType}, interlace ${header.interlace}`,
    );
  }

  const channels = header.colorType === 6 ? 4 : 3;
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter}`);
      }
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = line[from];
      pixels[to + 1] = line[from + 1];
      pixels[to + 2] = line[from + 2];
      pixels[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }

  return { width, height, pixels };
}

/** Encode opaque RGB pixels (one byte per channel) as a PNG. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Draw the source, scaled so the wordmark's own bounding box fills `coverage`
 * of a square canvas and is centred within it, recoloured white over the flat
 * background colour.
 *
 * The downscale is a box average over the source pixels landing in each target
 * pixel, which is what keeps a 786px-wide logo legible at 192px.
 */
function render(source, bounds, size, coverage) {
  const { drawWidth, drawHeight, originX, originY } = computeRenderGeometry({
    sourceWidth: source.width,
    sourceHeight: source.height,
    bounds,
    size,
    coverage,
  });

  const out = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    out[i * 3] = BACKGROUND[0];
    out[i * 3 + 1] = BACKGROUND[1];
    out[i * 3 + 2] = BACKGROUND[2];
  }

  // `drawWidth`/`drawHeight` cover the whole (padded) source at the
  // content-derived scale, so for an unevenly-padded source they can extend
  // past the canvas — these two guards clip that overflow. For the current
  // logo.png the overflow is entirely padding (see contentBounds' doc
  // comment), so this only ever discards blank pixels, never the wordmark
  // itself; that's a property of this specific asset, not something enforced
  // here, so re-check it visually if the source logo is ever replaced.
  for (let y = 0; y < drawHeight; y++) {
    const py = originY + y;
    if (py < 0 || py >= size) continue;
    const sy0 = Math.floor((y * source.height) / drawHeight);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * source.height) / drawHeight));
    for (let x = 0; x < drawWidth; x++) {
      const px = originX + x;
      if (px < 0 || px >= size) continue;
      const sx0 = Math.floor((x * source.width) / drawWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * source.width) / drawWidth));

      let alpha = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const at = (sy * source.width + sx) * 4;
          alpha += source.pixels[at + 3] / 255;
          count++;
        }
      }
      if (!count) continue;
      const coverAlpha = alpha / count;
      if (coverAlpha <= 0) continue;
      const to = (py * size + px) * 3;
      for (let c = 0; c < 3; c++) {
        out[to + c] = Math.round(FOREGROUND[c] * coverAlpha + BACKGROUND[c] * (1 - coverAlpha));
      }
    }
  }

  return encodePng(size, size, out);
}

const source = decodePng(readFileSync(SOURCE));
const bounds = contentBounds(source);
mkdirSync(OUT_DIR, { recursive: true });

// `any` icons are shown as-is, so the logo can fill most of the square.
// `maskable` icons get cropped to whatever shape the platform uses, so the
// logo has to stay inside the safe zone (the middle 80%) with room to spare.
const targets = [
  { file: "icon-192.png", size: 192, coverage: 0.9 },
  { file: "icon-512.png", size: 512, coverage: 0.9 },
  { file: "icon-maskable-192.png", size: 192, coverage: 0.6 },
  { file: "icon-maskable-512.png", size: 512, coverage: 0.6 },
  { file: "apple-touch-icon.png", size: 180, coverage: 0.82 },
];

for (const target of targets) {
  const png = render(source, bounds, target.size, target.coverage);
  writeFileSync(join(OUT_DIR, target.file), png);
  console.log(`wrote public/icons/${target.file} (${png.length} bytes)`);
}
