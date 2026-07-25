import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderWaiverPdf, type WaiverPdfData } from "./waiver-pdf";

// A real, minimal 1x1 PNG. pdf-lib's embedPng parses the IHDR/IDAT chunks, so
// the signature-image tests need actual PNG bytes, not an arbitrary buffer.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const validPng = () => decodeBase64(PNG_1x1_BASE64);

const base: WaiverPdfData = {
  full_name: "Jane Sample",
  date_of_birth: "1990-01-01",
  address: "123 Broadway, Ultimo NSW 2007",
  phone: "0400 000 000",
  email: "jane@example.com",
  emergency_contact_name: "John Sample",
  emergency_contact_phone: "0400 111 222",
  medical_notes: "",
  acknowledgements: [{ label: "I accept the risks.", checked: true }],
  signature_name: "Jane Sample",
  signed_at: "2026-07-21T10:00:00.000Z",
  template_title: "Training Waiver",
  template_body:
    "# Terms\n\nYou **must** train safely, {{full_name}}.\n\n---\n\n## Notes\n\nBe kind.",
  template_version: 3,
  club_name: "UTS Jitsu",
  is_minor: false,
  guardian_name: "",
  guardian_relationship: "",
  guardian_signature: "",
};

/** Assert the bytes are a structurally valid PDF pdf-lib can re-parse. */
async function expectValidPdf(bytes: Uint8Array): Promise<PDFDocument> {
  expect(bytes.byteLength).toBeGreaterThan(500);
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  // Round-tripping through load() proves the output is well-formed, not just
  // that it starts with the magic bytes.
  return await PDFDocument.load(bytes);
}

describe("renderWaiverPdf", () => {
  it("renders a valid single-page PDF for a signed adult with a typed signature", async () => {
    const doc = await expectValidPdf(await renderWaiverPdf(base));
    expect(doc.getPageCount()).toBe(1);
  });

  it("renders when the participant drew their signature (embeds the PNG)", async () => {
    // A drawn signature exercises the embedPng branch rather than typed text.
    const doc = await expectValidPdf(
      await renderWaiverPdf({ ...base, signature_name: "", signature_image_png: validPng() }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("does not throw on a corrupt signature PNG, falling back to a valid PDF", async () => {
    // The renderer wraps embedPng in try/catch and falls back to the typed name;
    // a bad image must never crash the whole render.
    const bogus = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const doc = await expectValidPdf(
      await renderWaiverPdf({ ...base, signature_image_png: bogus }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("renders the guardian consent block for a minor with a drawn guardian signature", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        is_minor: true,
        guardian_name: "Pat Sample",
        guardian_relationship: "Parent",
        guardian_signature: "Pat Sample",
        guardian_signature_image_png: validPng(),
      }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("renders a draft (watermarked) PDF and a signed PDF, both valid", async () => {
    const draft = await expectValidPdf(await renderWaiverPdf({ ...base, draft: true }));
    const signed = await expectValidPdf(await renderWaiverPdf({ ...base, draft: false }));
    expect(draft.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(signed.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("paginates onto multiple pages when the body is long", async () => {
    // Each paragraph is its own block; enough of them must overflow onto a
    // second page, exercising ensureSpace()/newPage().
    const longBody = Array.from({ length: 150 }, (_, i) => `Clause ${i + 1}: train safely.`).join(
      "\n\n",
    );
    const doc = await expectValidPdf(await renderWaiverPdf({ ...base, template_body: longBody }));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("renders with no acknowledgements and empty optional fields", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        acknowledgements: [],
        medical_notes: "",
        signature_name: "",
      }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("fills {{placeholder}} tokens in acknowledgement labels without throwing", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        acknowledgements: [
          { label: "I release {{club_name}} from liability.", checked: true },
          { label: "I confirm the details for {{full_name}}.", checked: false },
        ],
      }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
