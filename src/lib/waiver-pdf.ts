import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import {
  applyWaiverPlaceholders,
  bodyReferences,
  buildWaiverPlaceholders,
  matchChecklistLines,
} from "./waiver-document";
import { healthDeclarationLines, healthTokens, type HealthAnswerDraft } from "./waiver-health";

export type WaiverPdfData = {
  full_name: string;
  /** First name, the fallback for `{{preferred_name}}`. */
  first_name: string;
  /** Optional preferred name, as submitted ("" when not given). */
  preferred_name: string;
  date_of_birth: string;
  address: string;
  phone: string;
  email: string;
  emergency_contact_name: string;
  emergency_contact_relationship: string;
  emergency_contact_phone: string;
  medical_notes: string;
  /** The five health answers, as submitted. */
  health_answers: HealthAnswerDraft;
  /** Template-defined acknowledgements + whether each was accepted. */
  acknowledgements: { label: string; checked: boolean }[];
  signature_name: string;
  signed_at: string;
  template_title: string;
  template_body: string;
  template_version: number;
  club_name: string;
  /** Under 18 on the day of signing: the participant-type tick, and nothing else. */
  is_minor: boolean;
  /**
   * Whether a parent or guardian signed. True for a minor, and for anyone on
   * somebody else's account whatever their age. This is what prints the
   * consent block and the guardian's signature, NOT `is_minor` -- see the note
   * on `hasGuardian` in `waiver-document.ts`.
   */
  has_guardian: boolean;
  guardian_name: string;
  guardian_relationship: string;
  /** The guardian's own contact details, resolved by `resolveWaiverContacts`. */
  guardian_address: string;
  guardian_phone: string;
  guardian_email: string;
  guardian_signature: string;
  /** Optional PNG bytes for drawn participant signature */
  signature_image_png?: Uint8Array | null;
  /** Optional PNG bytes for drawn guardian signature */
  guardian_signature_image_png?: Uint8Array | null;
  /** If true, overlay a DRAFT watermark and skip signed-at footer */
  draft?: boolean;
};

/**
 * The characters outside plain ASCII that WinAnsi (the encoding pdf-lib's
 * standard fonts use) can represent: the Latin-1 range plus the typographic
 * extras in the 0x80-0x9F slots.
 */
const WIN_ANSI_EXTRAS = new Set(
  [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
    0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
    0x0153, 0x017e, 0x0178,
  ].map((code) => String.fromCharCode(code)),
);

/**
 * Drop what the PDF's standard font cannot encode.
 *
 * `drawText` THROWS on an unencodable character, and the template body is
 * manager-authored free text: one pasted emoji (a ⚠ in a warning heading, say)
 * would fail the whole render, and the signer would be told their PDF could not
 * be generated. Losing a decorative glyph is the better failure.
 */
export function winAnsiSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
    } else if (WIN_ANSI_EXTRAS.has(ch)) {
      out += ch;
    }
  }
  return out;
}

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

  const wrap = (raw: string, size: number, f: PDFFont): string[] => {
    const text = winAnsiSafe(raw);
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
    page.drawText(winAnsiSafe(typedName), {
      x: margin,
      y: layout.nameY - 4,
      size: layout.nameSize,
      font: sig ? font : bold,
      color: sig ? muted : ink,
    });
    if (timestamp !== null) {
      // Locale-formatted, so it can carry a narrow no-break space the standard
      // font cannot encode. Every other drawn string is filtered; so is this.
      page.drawText(winAnsiSafe(timestamp), {
        x: margin,
        y: layout.timestampY,
        size: 9,
        font,
        color: muted,
      });
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
    firstName: data.first_name,
    preferredName: data.preferred_name,
    dateOfBirth: data.date_of_birth,
    address: data.address,
    phone: data.phone,
    email: data.email,
    emergencyContactName: data.emergency_contact_name,
    emergencyContactRelationship: data.emergency_contact_relationship,
    emergencyContactPhone: data.emergency_contact_phone,
    guardianName: data.guardian_name,
    guardianRelationship: data.guardian_relationship,
    guardianAddress: data.guardian_address,
    guardianPhone: data.guardian_phone,
    guardianEmail: data.guardian_email,
    medicalNotes: data.medical_notes,
    healthAnswers: data.health_answers,
    signatureName: data.signature_name,
    clubName: data.club_name,
    isMinor: data.is_minor,
    hasGuardian: data.has_guardian,
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
    // `{{adult_checkbox}}`-style tokens substitute to `[X] label` / `[ ] label`
    // lines: draw them as real checkbox glyphs, matching the acknowledgements
    // below, never as literal bracket text.
    const checklist = matchChecklistLines(block);
    if (checklist) {
      for (const item of checklist) {
        const lines = wrap(item.text.replace(/\*\*(.+?)\*\*/g, "$1"), 11, font);
        ensureSpace(Math.max(16, lines.length * 14 + 4));
        page.drawRectangle({
          x: margin,
          y: y - 12,
          width: 10,
          height: 10,
          borderColor: ink,
          borderWidth: 0.8,
        });
        if (item.checked) {
          page.drawText("X", { x: margin + 2, y: y - 11, size: 9, font: bold, color: primary });
        }
        for (let li = 0; li < lines.length; li++) {
          page.drawText(winAnsiSafe(lines[li]), {
            x: margin + 18,
            y: y - 10 - li * 14,
            size: 11,
            font,
            color: ink,
          });
        }
        y -= Math.max(16, lines.length * 14 + 4);
      }
      y -= 4;
      continue;
    }
    // Single newlines are kept: the document is a form, and its "Full name: …"
    // style lines must stay on separate lines (wrap() splits on "\n").
    const clean = block.replace(/\*\*(.+?)\*\*/g, "$1");
    drawText(clean, { size: 11 });
    y -= 4;
  }

  // Health declaration, but only when the template body did not print it
  // itself. The answers have no column behind them: if the current template
  // carries no {{health_*}} token, this section is the only record there will
  // ever be that the signer was asked at all.
  if (!bodyReferences(data.template_body, healthTokens)) {
    y -= 6;
    ensureSpace(20);
    drawText("Health declaration", { size: 13, font: bold, color: primary });
    for (const row of healthDeclarationLines(data.health_answers)) {
      drawText(`${row.question} ${row.answer}`, { size: 10 });
      y -= 2;
    }
    if (data.medical_notes) drawText(`Details: ${data.medical_notes}`, { size: 10 });
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

  if (data.has_guardian) {
    y -= 24;
    // Heading + five detail rows (28pt each) + the signature block: enough that
    // the guardian's consent never starts at the very foot of a page with its
    // signature stranded overleaf.
    ensureSpace(220);
    drawText("Parent / guardian consent", { size: 13, font: bold, color: primary });
    const gRows: [string, string][] = [
      ["Guardian name", data.guardian_name || ""],
      ["Relationship to participant", data.guardian_relationship || ""],
      ["Guardian mobile", data.guardian_phone || ""],
      ["Guardian email", data.guardian_email || ""],
      ["Guardian address", data.guardian_address || ""],
    ];
    for (const [label, value] of gRows) {
      ensureSpace(16);
      page.drawText(label, { x: margin, y: y - 10, size: 9, font: bold, color: muted });
      y -= 12;
      page.drawText(winAnsiSafe(value) || "—", {
        x: margin,
        y: y - 11,
        size: 11,
        font,
        color: ink,
      });
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
      p.drawText("DRAFT: NOT SIGNED", {
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
