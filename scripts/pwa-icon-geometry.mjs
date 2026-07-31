// Pure geometry helpers for generate-pwa-icons.mjs, split out so the centring
// math is unit-testable (see pwa-icon-geometry.test.mjs) independently of PNG
// decoding/encoding. No dependencies, same as the rest of the icon generator.

/**
 * Find the bounding box of the non-transparent wordmark within the source
 * canvas. The source PNG's own canvas is padded unevenly on the right and
 * bottom (an export artefact), so centring against `source.width/height`
 * centres the padded canvas, not the logo — the wordmark ends up visibly
 * off-centre in the round icon mask. Centring against the content's own
 * bounding box instead fixes that regardless of how the source is padded.
 */
export function contentBounds(source) {
  const { width, height, pixels } = source;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] <= 10) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Compute the scale and placement needed to draw a `sourceWidth`x`sourceHeight`
 * source image onto a `size`x`size` canvas so that the `bounds` sub-region
 * (see `contentBounds`) fills `coverage` of the canvas and is centred within
 * it.
 *
 * `drawWidth`/`drawHeight` cover the *whole* source at this scale, not just
 * the content box, so when the source has much more padding on one side than
 * the other the drawn image can extend beyond the canvas — callers must clip
 * `originX + x` / `originY + y` to `[0, size)` rather than assume every drawn
 * pixel lands on-canvas.
 */
export function computeRenderGeometry({ sourceWidth, sourceHeight, bounds, size, coverage }) {
  const contentWidth = bounds.maxX - bounds.minX + 1;
  const contentHeight = bounds.maxY - bounds.minY + 1;
  const contentCenterX = (bounds.minX + bounds.maxX + 1) / 2;
  const contentCenterY = (bounds.minY + bounds.maxY + 1) / 2;

  const boxWidth = size * coverage;
  const scale = Math.min(boxWidth / contentWidth, boxWidth / contentHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const originX = Math.round(size / 2 - contentCenterX * scale);
  const originY = Math.round(size / 2 - contentCenterY * scale);

  return { scale, drawWidth, drawHeight, originX, originY };
}
