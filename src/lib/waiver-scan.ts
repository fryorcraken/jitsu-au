import { PDFDocument } from "pdf-lib";
import type { ScanMimeType } from "./validation";

/**
 * Turning a scanned paper waiver into the one PDF the club's record points at.
 *
 * Everything downstream of a waiver row assumes `pdf_path` is a single PDF: the
 * manager's download button, the member's copy on their account page, and the
 * Save-to-Drive upload. A paper waiver arrives as whatever the manager's phone
 * or scanner produced, often several files, so it is merged here rather than
 * teaching every one of those places about photos.
 */

/** One file as it arrives from the upload form, already decoded. */
export type ScanPage = {
  name: string;
  type: ScanMimeType;
  bytes: Uint8Array;
};

/** A4 portrait in PDF points: the box a scanned photo is fitted into. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

/** Decode raw base64 (no `data:` prefix) into bytes. Throws on malformed input. */
export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The size a scanned image is drawn at, and where, to sit centred on the page.
 *
 * Only ever scales DOWN: a scan smaller than the page keeps its own size rather
 * than being blown up into a blurry full-page image. Pure so the arithmetic is
 * testable without reading it back out of a PDF content stream.
 */
export function fitOnPage(
  imageWidth: number,
  imageHeight: number,
  pageWidth = PAGE_WIDTH,
  pageHeight = PAGE_HEIGHT,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight, 1);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height };
}

/**
 * Merge scanned files into one PDF, in the order given.
 *
 * PDFs contribute all of their pages; images each become one page, scaled to
 * fit A4 without distortion and centred. An unreadable file fails the whole
 * upload rather than silently dropping a page: a waiver missing its signature
 * page is worse than an upload the manager has to retry.
 */
export async function buildScanPdf(pages: ScanPage[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("No scan to save.");

  const out = await PDFDocument.create();
  out.setTitle("Signed waiver (scanned)");
  out.setProducer("UTS Jitsu");

  for (const page of pages) {
    try {
      if (page.type === "application/pdf") {
        const src = await PDFDocument.load(page.bytes);
        const copied = await out.copyPages(src, src.getPageIndices());
        for (const p of copied) out.addPage(p);
        continue;
      }

      const image =
        page.type === "image/png" ? await out.embedPng(page.bytes) : await out.embedJpg(page.bytes);
      const sheet = out.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      sheet.drawImage(image, fitOnPage(image.width, image.height));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not read "${page.name}": ${reason}`);
    }
  }

  if (out.getPageCount() === 0) throw new Error("The scan has no pages.");
  return out.save();
}
