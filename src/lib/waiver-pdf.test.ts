import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFRawStream, type PDFPage } from "pdf-lib";
import {
  layoutSignatureBlock,
  renderWaiverPdf,
  winAnsiSafe,
  type WaiverPdfData,
} from "./waiver-pdf";

// A real, minimal 1x1 PNG. pdf-lib's embedPng parses the IHDR/IDAT chunks, so
// the signature-image tests need actual PNG bytes, not an arbitrary buffer.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A 400x120 greyscale PNG. Real drawn signatures are wide and tall; this one
// scales into the full 220x60 signature box, which is what makes the overlap
// regression visible (a 1x1 pixel is too small to collide with anything).
const PNG_400x120_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAZAAAAB4CAAAAAD5tPtLAAAARUlEQVR42u3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgb7v4AAH1tVnmAAAAAElFTkSuQmCC";

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const validPng = () => decodeBase64(PNG_1x1_BASE64);
const tallPng = () => decodeBase64(PNG_400x120_BASE64);

type PlacedText = { x: number; y: number; text: string };
type PlacedImage = { x: number; y: number; width: number; height: number };

/**
 * Read back where text and images actually landed on a rendered page.
 *
 * This parses only the operator shapes pdf-lib emits for `drawText`/`drawImage`
 * (`1 0 0 1 x y Tm` + `<hex> Tj`, and a `q`-scoped chain of `cm` matrices before
 * `/Image… Do`), which is enough to assert geometry without a full PDF parser.
 */
function readPlacements(doc: PDFDocument, page: PDFPage) {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const src = refs
    .map((ref) => {
      const stream = doc.context.lookup(ref) as PDFRawStream;
      return inflateSync(Buffer.from(stream.contents)).toString("latin1");
    })
    .join("\n");

  const texts: PlacedText[] = [];
  const images: PlacedImage[] = [];
  let cursor: { x: number; y: number } | null = null;
  let matrices: number[][] = [];

  for (const line of src.split("\n").map((l) => l.trim())) {
    const tm = line.match(/^1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm$/);
    if (tm) {
      cursor = { x: Number(tm[1]), y: Number(tm[2]) };
      continue;
    }
    const tj = line.match(/^<([0-9A-Fa-f]*)> Tj$/);
    if (tj && cursor) {
      const text = (tj[1].match(/../g) ?? [])
        .map((pair) => String.fromCharCode(parseInt(pair, 16)))
        .join("");
      texts.push({ ...cursor, text });
      continue;
    }
    const cm = line.match(/^(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm$/);
    if (cm) {
      matrices.push(cm.slice(1).map(Number));
      continue;
    }
    if (/^\/Image\S* Do$/.test(line)) {
      // pdf-lib emits translate-then-scale, so summing offsets and multiplying
      // scales reconstructs the placement.
      images.push({
        x: matrices.reduce((acc, [, , tx]) => acc + tx, 0),
        y: matrices.reduce((acc, [, , , ty]) => acc + ty, 0),
        width: matrices.reduce((acc, [sx]) => acc * sx, 1),
        height: matrices.reduce((acc, [, sy]) => acc * sy, 1),
      });
      continue;
    }
    if (line === "q" || line === "Q") matrices = [];
  }
  return { texts, images };
}

const base: WaiverPdfData = {
  full_name: "Jane Sample",
  first_name: "Jane",
  preferred_name: "",
  date_of_birth: "1990-01-01",
  address: "123 Broadway, Ultimo NSW 2007",
  phone: "0400 000 000",
  email: "jane@example.com",
  emergency_contact_name: "John Sample",
  emergency_contact_relationship: "Partner",
  emergency_contact_phone: "0400 111 222",
  medical_notes: "",
  health_answers: {
    drugs: false,
    blackouts: false,
    device: false,
    impairments: false,
    other: false,
  },
  acknowledgements: [{ label: "I accept the risks.", checked: true }],
  signature_name: "Jane Sample",
  signed_at: "2026-07-21T10:00:00.000Z",
  template_title: "Training Waiver",
  template_body:
    "# Terms\n\nYou **must** train safely, {{full_name}}.\n\n---\n\n## Notes\n\nBe kind.",
  template_version: 3,
  club_name: "UTS Jitsu",
  is_minor: false,
  has_guardian: false,
  guardian_name: "",
  guardian_relationship: "",
  guardian_address: "",
  guardian_phone: "",
  guardian_email: "",
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

describe("layoutSignatureBlock", () => {
  const TOP = 700;

  it("never lets a drawn signature reach above the cursor it starts from", () => {
    // The invariant the overlap fix rests on: whatever the signature's height,
    // the glyph stays below whatever was already drawn on the page.
    for (const signatureHeight of [1, 12, 30, 59.5, 60]) {
      const layout = layoutSignatureBlock({ top: TOP, signatureHeight, hasTimestamp: true });
      expect(layout.imageTop).toBeLessThanOrEqual(TOP);
      expect(layout.imageY).toBe(layout.lineY + 4);
    }
  });

  it("pushes the rule down by the full height of a drawn signature", () => {
    const short = layoutSignatureBlock({ top: TOP, signatureHeight: 10, hasTimestamp: true });
    const tall = layoutSignatureBlock({ top: TOP, signatureHeight: 60, hasTimestamp: true });
    expect(tall.lineY).toBe(short.lineY - 50);
    expect(tall.height).toBe(short.height + 50);
  });

  it("leaves the rule at the cursor when the signature is typed", () => {
    const layout = layoutSignatureBlock({ top: TOP, signatureHeight: 0, hasTimestamp: true });
    expect(layout.lineY).toBe(TOP);
    expect(layout.nameSize).toBe(14);
  });

  it("orders the rule, printed name and timestamp top to bottom", () => {
    const layout = layoutSignatureBlock({ top: TOP, signatureHeight: 60, hasTimestamp: true });
    expect(layout.lineY).toBeLessThan(layout.imageY);
    expect(layout.nameY).toBeLessThan(layout.lineY);
    expect(layout.timestampY).toBeLessThan(layout.nameY);
    expect(layout.next).toBeLessThan(layout.timestampY);
  });

  it("reports a height that spans the whole block", () => {
    for (const hasTimestamp of [true, false]) {
      const layout = layoutSignatureBlock({ top: TOP, signatureHeight: 60, hasTimestamp });
      expect(layout.height).toBe(TOP - layout.next);
      expect(layout.next).toBeLessThanOrEqual(layout.timestampY);
    }
  });
});

describe("winAnsiSafe", () => {
  it("keeps ASCII, Latin-1 and the typographic characters the font can encode", () => {
    expect(winAnsiSafe('Café — "quoted" 50% · ok')).toBe('Café — "quoted" 50% · ok');
    expect(winAnsiSafe("line one\nline two")).toBe("line one\nline two");
  });

  it("drops what the standard font cannot encode", () => {
    // A ⚠ pasted into a template heading used to throw out of drawText and fail
    // the whole render, telling the signer their PDF could not be generated.
    expect(winAnsiSafe("⚠️ WARNING ⚠️")).toBe(" WARNING ");
    expect(winAnsiSafe("危険")).toBe("");
  });
});

describe("renderWaiverPdf", () => {
  // The health answers have no column behind them: the signed document is
  // their only record. A template that never references them (the version live
  // before this form shipped does not) would otherwise collect five safety
  // answers and print them nowhere.
  it("prints the health declaration when the body does not reference it", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        template_body: "# Terms\n\nTrain safely.",
        health_answers: { ...base.health_answers, blackouts: true },
        medical_notes: "Fainted once in 2024.",
      }),
    );
    const { texts } = readPlacements(doc, doc.getPage(0));
    const printed = texts.map((t) => t.text).join(" ");
    expect(printed).toContain("Health declaration");
    expect(printed).toContain("Yes");
  });

  it("leaves the declaration to the body when the body does reference it", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        template_body: "Blackouts: {{health_blackouts}}",
      }),
    );
    const { texts } = readPlacements(doc, doc.getPage(0));
    const printed = texts.map((t) => t.text).join(" ");
    expect(printed).not.toContain("Health declaration");
    expect(printed).toContain("Blackouts:");
  });

  // {{adult_checkbox}}/{{minor_checkbox}}-style tokens substitute to `[X]
  // label` / `[ ] label` lines. These must draw as real checkbox glyphs
  // (indented label, boxed mark), never as literal bracket text.
  it("draws [X]/[ ] template lines as checkboxes, not literal bracket text", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        template_body: "[X] Adult (18+)\n[ ] Minor (under 18)",
      }),
    );
    const { texts } = readPlacements(doc, doc.getPage(0));
    expect(texts.some((t) => t.text.includes("["))).toBe(false);
    const adultLabel = texts.find((t) => t.text.startsWith("Adult"));
    expect(adultLabel).toBeDefined();
    // Indented past the checkbox glyph (margin 50 + 18), not flush with margin
    // the way an ordinary paragraph line would be.
    expect(adultLabel!.x).toBe(68);
    // The ticked box draws a bold "X" mark of its own, distinct from the label.
    expect(texts.filter((t) => t.text === "X").length).toBeGreaterThanOrEqual(1);
  });

  it("renders a template body containing characters the font cannot encode", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({ ...base, template_body: "# ⚠ Warning ⚠\n\nTrain safely 🥋." }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

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
        has_guardian: true,
        guardian_name: "Pat Sample",
        guardian_relationship: "Parent",
        guardian_address: "9 Quay St, Haymarket NSW",
        guardian_phone: "0400 333 444",
        guardian_email: "pat@example.com",
        guardian_signature: "Pat Sample",
        guardian_signature_image_png: validPng(),
      }),
    );
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // The guardian is the person who signs and the person the club has to be able
  // to reach about a child. Their details are drawn by this renderer, not by a
  // template token, so they appear on every version of the form.
  it("prints the guardian's mobile, email and address on a minor's document", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        is_minor: true,
        has_guardian: true,
        guardian_name: "Pat Sample",
        guardian_relationship: "Parent",
        guardian_address: "9 Quay St, Haymarket NSW",
        guardian_phone: "0400 333 444",
        guardian_email: "pat@example.com",
        guardian_signature: "Pat Sample",
      }),
    );
    const printed = doc
      .getPages()
      .flatMap((page) => readPlacements(doc, page).texts.map((t) => t.text));
    expect(printed).toContain("0400 333 444");
    expect(printed).toContain("pat@example.com");
    expect(printed).toContain("9 Quay St, Haymarket NSW");
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

  it("keeps a drawn signature clear of the body text above it", async () => {
    // Regression: the drawn signature is rendered *above* its rule, and no
    // vertical space was reserved for it, so a full-height signature ran back
    // up the page and struck through the template's closing "Signed by …" line.
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        template_body: "## Media consent\n\nI may consent.\n\n---\n\nSigned by {{full_name}}.",
        signature_image_png: tallPng(),
      }),
    );
    const { texts, images } = readPlacements(doc, doc.getPage(0));

    expect(images).toHaveLength(1);
    const [signature] = images;
    // The fixture must actually fill the signature box, or the test proves nothing.
    expect(signature.height).toBeCloseTo(60, 5);

    const signedBy = texts.find((t) => t.text.startsWith("Signed by"));
    expect(signedBy).toBeDefined();
    expect(signature.y + signature.height).toBeLessThan(signedBy!.y);
  });

  it("keeps a drawn guardian signature clear of the consent details above it", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        is_minor: true,
        has_guardian: true,
        guardian_name: "Pat Sample",
        guardian_relationship: "Parent",
        guardian_address: "9 Quay St, Haymarket NSW",
        guardian_phone: "0400 333 444",
        guardian_email: "pat@example.com",
        guardian_signature: "Pat Sample",
        signature_image_png: tallPng(),
        guardian_signature_image_png: tallPng(),
      }),
    );
    // The consent block carries five detail rows now, so it does not always fit
    // on one page with a tall drawn signature. What must hold either way is the
    // reading order: the guardian's signature comes after the details it
    // consents to, never on top of them. Compare by page first, then by height
    // within a page (PDF y grows upwards, so "below" is a smaller y).
    const pages = doc.getPages().map((page) => readPlacements(doc, page));
    const relationshipPage = pages.findIndex((p) => p.texts.some((t) => t.text === "Parent"));
    expect(relationshipPage).toBeGreaterThanOrEqual(0);
    // The guardian's is the last signature drawn on the document, so it is the
    // last image on the last page that carries one.
    const signaturePage = pages.reduce((acc, p, i) => (p.images.length > 0 ? i : acc), -1);
    expect(signaturePage).toBeGreaterThanOrEqual(relationshipPage);

    if (signaturePage === relationshipPage) {
      const guardianSignature = pages[signaturePage].images.at(-1)!;
      const relationship = pages[relationshipPage].texts.find((t) => t.text === "Parent")!;
      expect(guardianSignature.y + guardianSignature.height).toBeLessThan(relationship.y);
    }
  });

  it("still names the signer when a drawn signature fails to embed", async () => {
    // Validation accepts a drawn signature with no typed name, so a corrupt PNG
    // must not leave the waiver with a blank signer line.
    const doc = await expectValidPdf(
      await renderWaiverPdf({
        ...base,
        signature_name: "",
        signature_image_png: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      }),
    );
    const { texts, images } = readPlacements(doc, doc.getPage(0));
    expect(images).toHaveLength(0);
    expect(texts.some((t) => t.text === "Jane Sample")).toBe(true);
  });

  it("prints the signer name and timestamp below the drawn signature", async () => {
    const doc = await expectValidPdf(
      await renderWaiverPdf({ ...base, signature_image_png: tallPng() }),
    );
    const { texts, images } = readPlacements(doc, doc.getPage(0));
    const [signature] = images;
    const printedName = texts.find((t) => t.text === "Jane Sample" && t.y < signature.y);
    const timestamp = texts.find((t) => t.text.startsWith("Electronically signed on"));

    expect(printedName).toBeDefined();
    expect(timestamp).toBeDefined();
    expect(timestamp!.y).toBeLessThan(printedName!.y);
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
