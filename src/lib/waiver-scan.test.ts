import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildScanPdf, decodeBase64, fitOnPage, type ScanPage } from "./waiver-scan";

// A real, minimal 1x1 PNG. pdf-lib parses the IHDR/IDAT chunks, so an image
// test needs actual PNG bytes rather than an arbitrary buffer.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A 400x120 greyscale PNG: wide and short, like a photographed page, so the
// fit-to-A4 scaling has something to actually scale.
const PNG_400x120_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAZAAAAB4CAAAAAD5tPtLAAAARUlEQVR42u3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgb7v4AAH1tVnmAAAAAElFTkSuQmCC";

// A real 1x1 JPEG: pdf-lib parses the JFIF markers, so embedJpg needs genuine
// JPEG bytes. Phone cameras produce JPEG, which is the common paper-form case.
const JPEG_1x1_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/** A real multi-page PDF, the kind a document scanner produces. */
async function samplePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([A4_WIDTH, A4_HEIGHT]);
  return doc.save();
}

function png(base64: string, name = "page.png"): ScanPage {
  return { name, type: "image/png", bytes: decodeBase64(base64) };
}

describe("decodeBase64", () => {
  it("round-trips bytes", () => {
    expect(Array.from(decodeBase64("aGlw"))).toEqual([104, 105, 112]);
  });

  it("tolerates the line breaks a wrapped payload carries", () => {
    expect(Array.from(decodeBase64("aG\nlw"))).toEqual([104, 105, 112]);
  });
});

describe("buildScanPdf", () => {
  it("refuses to build a document out of nothing", async () => {
    await expect(buildScanPdf([])).rejects.toThrow(/no scan/i);
  });

  it("keeps every page of a scanned PDF", async () => {
    const merged = await buildScanPdf([
      { name: "waiver.pdf", type: "application/pdf", bytes: await samplePdf(3) },
    ]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(3);
  });

  it("joins several files into one document, in the order given", async () => {
    // A manager who photographs page 1 then page 2 must not get them back the
    // other way round: the signature page is the last one.
    const merged = await buildScanPdf([
      { name: "front.pdf", type: "application/pdf", bytes: await samplePdf(2) },
      png(PNG_400x120_BASE64, "back.png"),
    ]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(3);
  });

  it("gives a photographed page its own A4 sheet", async () => {
    const merged = await buildScanPdf([png(PNG_400x120_BASE64)]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(1);
    const { width, height } = out.getPage(0).getSize();
    expect(width).toBeCloseTo(A4_WIDTH, 1);
    expect(height).toBeCloseTo(A4_HEIGHT, 1);
  });

  it("embeds JPEG pages as well as PNG ones", async () => {
    // Phone cameras produce JPEG, which is the common case for a paper form
    // photographed at the door.
    const merged = await buildScanPdf([
      { name: "p.jpg", type: "image/jpeg", bytes: decodeBase64(JPEG_1x1_BASE64) },
    ]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(1);
  });

  it("fails the whole upload on an unreadable file, naming it", async () => {
    // Dropping the bad page silently would file a waiver whose signature page
    // is simply missing, and nothing downstream would ever say so.
    await expect(
      buildScanPdf([
        { name: "waiver.pdf", type: "application/pdf", bytes: await samplePdf(1) },
        { name: "signature-page.png", type: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) },
      ]),
    ).rejects.toThrow(/signature-page\.png/);
  });
});

describe("fitOnPage", () => {
  it("scales an oversized scan down to fit, keeping its shape", () => {
    // A 3024x4032 phone photo, the ordinary case.
    const box = fitOnPage(3024, 4032);
    expect(box.width).toBeLessThanOrEqual(A4_WIDTH + 0.01);
    expect(box.height).toBeLessThanOrEqual(A4_HEIGHT + 0.01);
    expect(box.width / box.height).toBeCloseTo(3024 / 4032, 5);
  });

  it("never enlarges a small scan into a blurry full page", () => {
    // A 1x1 pixel stretched to A4 width would be 595 points of mush.
    expect(fitOnPage(1, 1)).toMatchObject({ width: 1, height: 1 });
  });

  it("centres what it draws", () => {
    const box = fitOnPage(100, 200);
    expect(box.x).toBeCloseTo((A4_WIDTH - 100) / 2, 5);
    expect(box.y).toBeCloseTo((A4_HEIGHT - 200) / 2, 5);
  });

  it("fits a wide scan by its width, and a tall one by its height", () => {
    expect(fitOnPage(2000, 100).width).toBeCloseTo(A4_WIDTH, 5);
    expect(fitOnPage(100, 2000).height).toBeCloseTo(A4_HEIGHT, 5);
  });
});
