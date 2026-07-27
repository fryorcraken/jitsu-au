import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import { applyWaiverPlaceholders, buildWaiverPlaceholders } from "./waiver-document";

export type WaiverPdfData = {
  full_name: string;
  date_of_birth: string;
  address: string;
  phone: string;
  email: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  medical_notes: string;
  /** Template-defined acknowledgements + whether each was accepted. */
  acknowledgements: { label: string; checked: boolean }[];
  signature_name: string;
  signed_at: string;
  template_title: string;
  template_body: string;
  template_version: number;
  club_name: string;
  is_minor: boolean;
  guardian_name: string;
  guardian_relationship: string;
  guardian_signature: string;
  /** Optional PNG bytes for drawn participant signature */
  signature_image_png?: Uint8Array | null;
  /** Optional PNG bytes for drawn guardian signature */
  guardian_signature_image_png?: Uint8Array | null;
  /** If true, overlay a DRAFT watermark and skip signed-at footer */
  draft?: boolean;
};

/** Largest box a drawn signature is scaled into, in PDF points. */
const SIGNATURE_MAX_WIDTH = 220;
const SIGNATURE_MAX_HEIGHT = 60;
/** Gap between the baseline rule and the glyph resting on it. */
const SIGNATURE_SIT = 4;
/** Gap between the text above the block and the top of the drawn glyph. */
const SIGNATURE_CLEARANCE = 6;

export type SignatureBlockLayout = {
  /** y of the horizontal rule the signature sits on. */
  lineY: number;
  /** y of the bottom-left corner of the drawn signature image. */
  imageY: number;
  /** y of the top edge of the drawn signature image. */
  imageTop: number;
  /** Cursor for the printed signer name below the rule. */
  nameY: number;
  /** Font size for the printed signer name. */
  nameSize: number;
  /** y for the "electronically signed on ..." line, when there is one. */
  timestampY: number;
  /** Cursor position after the whole block. */
  next: number;
  /** Total vertical space the block consumes, for ensureSpace(). */
  height: number;
};

/**
 * Vertical layout for a signature block.
 *
 * A drawn signature is rendered *above* its rule, so its height has to be
 * reserved before the rule is positioned. Without that reservation the glyph
 * runs back up the page and overlaps the text already drawn there (the
 * template's "Signed by ... on ..." line).
 *
 * `top` is the cursor before the block; every returned coordinate is at or
 * below it.
 */
export function layoutSignatureBlock(opts: {
  top: number;
  /** Scaled height of the drawn signature, or 0 when the name is typed. */
  signatureHeight: number;
  hasTimestamp: boolean;
}): SignatureBlockLayout {
  const { top, signatureHeight, hasTimestamp } = opts;
  const reserved = signatureHeight > 0 ? signatureHeight + SIGNATURE_SIT + SIGNATURE_CLEARANCE : 0;
  const lineY = top - reserved;
  const nameY = lineY - 14;
  const nameSize = signatureHeight > 0 ? 10 : 14;
  const timestampY = nameY - (nameSize + 8);
  const next = hasTimestamp ? timestampY - 13 : timestampY;
  return {
    lineY,
    imageY: lineY + SIGNATURE_SIT,
    imageTop: lineY + SIGNATURE_SIT + signatureHeight,
    nameY,
    nameSize,
    timestampY,
    next,
    height: top - next,
  };
}

export async function renderWaiverPdf(data: WaiverPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = 50;
  const pageWidth = 595;
  const pageHeight = 842;
  const maxWidth = pageWidth - margin * 2;
  const primary = rgb(0, 0.557, 0.667); // #008eaa
  const ink = rgb(0.1, 0.12, 0.15);
  const muted = rgb(0.4, 0.42, 0.45);

  const pages: PDFPage[] = [];
  let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  pages.push(page);
  let y = pageHeight - margin;

  const newPage = () => {
    page = doc.addPage([pageWidth, pageHeight]);
    pages.push(page);
    y = pageHeight - margin;
  };

  const ensureSpace = (needed: number) => {
    if (y - needed < margin) newPage();
  };

  const wrap = (text: string, size: number, f: PDFFont): string[] => {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      if (paragraph === "") {
        lines.push("");
        continue;
      }
      const words = paragraph.split(/\s+/);
      let line = "";
      for (const w of words) {
        const candidate = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(candidate, size) > maxWidth) {
          if (line) lines.push(line);
          line = w;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  };

  const drawText = (
    text: string,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; leading?: number } = {},
  ) => {
    const size = opts.size ?? 11;
    const f = opts.font ?? font;
    const color = opts.color ?? ink;
    const leading = opts.leading ?? size * 1.4;
    for (const line of wrap(text, size, f)) {
      ensureSpace(leading);
      page.drawText(line, { x: margin, y: y - size, size, font: f, color });
      y -= leading;
    }
  };

  type EmbeddedSignature = { img: Awaited<ReturnType<typeof doc.embedPng>>; w: number; h: number };

  /** Embed a drawn signature, scaled into the signature box. Null if absent or unreadable. */
  const embedSignature = async (png?: Uint8Array | null): Promise<EmbeddedSignature | null> => {
    if (!png || png.byteLength === 0) return null;
    try {
      const img = await doc.embedPng(png);
      const scale = Math.min(SIGNATURE_MAX_WIDTH / img.width, SIGNATURE_MAX_HEIGHT / img.height, 1);
      return { img, w: img.width * scale, h: img.height * scale };
    } catch {
      // A corrupt PNG must never fail the whole render; fall back to typed text.
      return null;
    }
  };

  /** Rule + drawn-or-typed signature + printed name + optional timestamp. */
  const drawSignatureBlock = (
    sig: EmbeddedSignature | null,
    typedName: string,
    timestamp: string | null,
  ) => {
    const measure = () =>
      layoutSignatureBlock({
        top: y,
        signatureHeight: sig?.h ?? 0,
        hasTimestamp: timestamp !== null,
      });
    ensureSpace(measure().height);
    // Re-measure: ensureSpace may have moved the cursor to a fresh page.
    const layout = measure();
    page.drawLine({
      start: { x: margin, y: layout.lineY },
      end: { x: margin + 260, y: layout.lineY },
      thickness: 0.5,
      color: muted,
    });
    if (sig) {
      page.drawImage(sig.img, { x: margin, y: layout.imageY, width: sig.w, height: sig.h });
    }
    page.drawText(typedName, {
      x: margin,
      y: layout.nameY - 4,
      size: layout.nameSize,
      font: sig ? font : bold,
      color: sig ? muted : ink,
    });
    if (timestamp !== null) {
      page.drawText(timestamp, { x: margin, y: layout.timestampY, size: 9, font, color: muted });
    }
    y = layout.next;
  };

  // Header
  page.drawRectangle({ x: 0, y: pageHeight - 8, width: pageWidth, height: 8, color: primary });
  drawText(data.club_name, { size: 10, color: muted });
  y -= 2;
  drawText(data.template_title, { size: 22, font: bold });
  y -= 6;
  const dateLabel = data.draft
    ? "Draft preview"
    : `Template version ${data.template_version} · Signed ${new Date(data.signed_at).toLocaleString("en-AU")}`;
  drawText(dateLabel, { size: 9, color: muted });
  y -= 10;

  // Body: parse simple markdown-ish (# heading, **bold**, ---). Participant
  // data appears only where the body/labels use a {{placeholder}}.
  const placeholders = buildWaiverPlaceholders({
    fullName: data.full_name,
    dateOfBirth: data.date_of_birth,
    address: data.address,
    phone: data.phone,
    email: data.email,
    emergencyContactName: data.emergency_contact_name,
    emergencyContactPhone: data.emergency_contact_phone,
    medicalNotes: data.medical_notes,
    signatureName: data.signature_name,
    clubName: data.club_name,
    signedDate: data.draft ? "" : new Date(data.signed_at).toLocaleDateString("en-AU"),
  });
  const paragraphs = applyWaiverPlaceholders(data.template_body, placeholders).split(/\n{2,}/);
  for (const raw of paragraphs) {
    const block = raw.trim();
    if (!block) continue;
    if (block === "---") {
      ensureSpace(14);
      page.drawLine({
        start: { x: margin, y: y - 4 },
        end: { x: pageWidth - margin, y: y - 4 },
        thickness: 0.5,
        color: muted,
      });
      y -= 14;
      continue;
    }
    if (block.startsWith("# ")) {
      y -= 6;
      drawText(block.slice(2), { size: 16, font: bold });
      continue;
    }
    if (block.startsWith("## ")) {
      y -= 4;
      drawText(block.slice(3), { size: 13, font: bold });
      continue;
    }
    const clean = block.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\n/g, " ");
    drawText(clean, { size: 11 });
    y -= 4;
  }

  // Acknowledgements (defined on the template)
  if (data.acknowledgements.length > 0) {
    y -= 6;
    ensureSpace(20);
    drawText("Acknowledgements", { size: 13, font: bold, color: primary });
    for (const ack of data.acknowledgements) {
      ensureSpace(20);
      page.drawRectangle({
        x: margin,
        y: y - 12,
        width: 10,
        height: 10,
        borderColor: ink,
        borderWidth: 0.8,
      });
      if (ack.checked) {
        page.drawText("X", { x: margin + 2, y: y - 11, size: 9, font: bold, color: primary });
      }
      const lines = wrap(applyWaiverPlaceholders(ack.label, placeholders), 10, font);
      for (let i = 0; i < lines.length; i++) {
        page.drawText(lines[i], { x: margin + 18, y: y - 10 - i * 12, size: 10, font, color: ink });
      }
      y -= Math.max(16, lines.length * 12 + 4);
    }
  }

  // Signature
  y -= 10;
  const signature = await embedSignature(data.signature_image_png);
  drawSignatureBlock(
    signature,
    // A drawn signature may carry no typed name (validation accepts either), so
    // an unreadable PNG must still fall back to a name, never a blank line.
    data.signature_name || data.full_name || "",
    data.draft
      ? null
      : `Electronically signed on ${new Date(data.signed_at).toLocaleString("en-AU")}`,
  );

  if (data.is_minor) {
    y -= 24;
    ensureSpace(120);
    drawText("Parent / guardian consent", { size: 13, font: bold, color: primary });
    const gRows: [string, string][] = [
      ["Guardian name", data.guardian_name || ""],
      ["Relationship to participant", data.guardian_relationship || ""],
    ];
    for (const [label, value] of gRows) {
      ensureSpace(16);
      page.drawText(label, { x: margin, y: y - 10, size: 9, font: bold, color: muted });
      y -= 12;
      page.drawText(value || "—", { x: margin, y: y - 11, size: 11, font, color: ink });
      y -= 16;
    }
    y -= 4;
    const guardianSignature = await embedSignature(data.guardian_signature_image_png);
    drawSignatureBlock(
      guardianSignature,
      data.guardian_signature || data.guardian_name || "",
      data.draft
        ? null
        : `Guardian electronically signed on ${new Date(data.signed_at).toLocaleString("en-AU")}`,
    );
  }

  // DRAFT watermark on every page
  if (data.draft) {
    for (const p of pages) {
      p.drawText("DRAFT — NOT SIGNED", {
        x: 60,
        y: 380,
        size: 60,
        font: bold,
        color: rgb(0.85, 0.87, 0.9),
        rotate: degrees(30),
        opacity: 0.55,
      });
    }
  }

  return await doc.save();
}
