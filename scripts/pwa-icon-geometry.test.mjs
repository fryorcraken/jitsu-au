import { describe, expect, it } from "vitest";
import { computeRenderGeometry, contentBounds } from "./pwa-icon-geometry.mjs";

/** Build a flat RGBA buffer for a `width`x`height` canvas, opaque within `box` and
 * transparent everywhere else. `box` is `{ minX, maxX, minY, maxY }`, inclusive. */
function canvasWithOpaqueBox(width, height, box) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBox = x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
      pixels[(y * width + x) * 4 + 3] = inBox ? 255 : 0;
    }
  }
  return { width, height, pixels };
}

describe("contentBounds", () => {
  it("finds the bounding box of the non-transparent content", () => {
    const source = canvasWithOpaqueBox(10, 10, { minX: 2, maxX: 5, minY: 1, maxY: 3 });
    expect(contentBounds(source)).toEqual({ minX: 2, maxX: 5, minY: 1, maxY: 3 });
  });

  it("ignores near-transparent pixels (alpha <= 10)", () => {
    const source = canvasWithOpaqueBox(5, 5, { minX: 1, maxX: 3, minY: 1, maxY: 3 });
    source.pixels[(0 * 5 + 0) * 4 + 3] = 10;
    expect(contentBounds(source)).toEqual({ minX: 1, maxX: 3, minY: 1, maxY: 3 });
  });

  it("reproduces the real logo.png's uneven padding (right/bottom heavy)", () => {
    // Regression fixture for the bug this module fixes: a canvas padded almost
    // entirely on the right and bottom, as public/logo.png actually is.
    const source = canvasWithOpaqueBox(786, 491, { minX: 1, maxX: 703, minY: 0, maxY: 451 });
    expect(contentBounds(source)).toEqual({ minX: 1, maxX: 703, minY: 0, maxY: 451 });
  });
});

describe("computeRenderGeometry", () => {
  it("centres a symmetric content box with no scaling needed", () => {
    // 100x100 canvas, content already centred and exactly coverage-sized: no
    // translation should be needed.
    const geometry = computeRenderGeometry({
      sourceWidth: 100,
      sourceHeight: 100,
      bounds: { minX: 10, maxX: 89, minY: 10, maxY: 89 },
      size: 100,
      coverage: 0.8,
    });
    expect(geometry.originX).toBe(0);
    expect(geometry.originY).toBe(0);
    expect(geometry.drawWidth).toBe(100);
    expect(geometry.drawHeight).toBe(100);
  });

  it("shifts the origin to centre content that is off-centre in its source canvas", () => {
    // A 20x20 source whose 10x10 content box sits in the top-left corner
    // (heavy padding on the right/bottom) — the historical bug this fixes.
    const geometry = computeRenderGeometry({
      sourceWidth: 20,
      sourceHeight: 20,
      bounds: { minX: 0, maxX: 9, minY: 0, maxY: 9 },
      size: 40,
      coverage: 0.5,
    });
    // scale = boxWidth(20) / contentWidth(10) = 2; contentCenter = 5,5
    expect(geometry.scale).toBe(2);
    // originX = size/2 - contentCenterX*scale = 20 - 5*2 = 10
    expect(geometry.originX).toBe(10);
    expect(geometry.originY).toBe(10);
    // The content box (source px 0..9) now maps to canvas px 10..29, i.e.
    // centred in the 40px canvas (10 px margin each side).
    const contentStartOnCanvas = geometry.originX + 0 * geometry.scale;
    const contentEndOnCanvas = geometry.originX + 10 * geometry.scale;
    expect(contentStartOnCanvas).toBe(10);
    expect(contentEndOnCanvas).toBe(30);
    expect(40 - contentEndOnCanvas).toBe(contentStartOnCanvas);
  });

  it("can draw the padded source past the canvas edge, by design", () => {
    // Mirrors logo.png at icon-192/coverage 0.9: heavy padding means the full
    // (padded) drawn image legitimately overflows the canvas even though the
    // content itself fits — callers must clip to [0, size).
    const geometry = computeRenderGeometry({
      sourceWidth: 786,
      sourceHeight: 491,
      bounds: { minX: 1, maxX: 703, minY: 0, maxY: 451 },
      size: 192,
      coverage: 0.9,
    });
    expect(geometry.originX + geometry.drawWidth).toBeGreaterThan(192);
    // But the content box itself must stay within the canvas.
    const contentRightOnCanvas = geometry.originX + 703 * geometry.scale;
    expect(contentRightOnCanvas).toBeLessThanOrEqual(192);
    expect(geometry.originX).toBeGreaterThanOrEqual(0);
  });
});
