import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type WaiverPdfData = {
  full_name: string;
  date_of_birth: string;
  address: string;
  phone: string;
  email: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  medical_notes: string;
  ack_risk: boolean;
  ack_release: boolean;
  ack_media: boolean;
  signature_name: string;
  signed_at: string;
  template_title: string;
  template_body: string;
  template_version: number;
  club_name: string;
};

export function applyPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in values ? values[k] : `{{${k}}}`));
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

  let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (needed: number) => {
    if (y - needed < margin) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const wrap = (text: string, size: number, f: PDFFont): string[] => {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      if (paragraph === "") { lines.push(""); continue; }
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

  const drawText = (text: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; leading?: number } = {}) => {
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

  // Header
  page.drawRectangle({ x: 0, y: pageHeight - 8, width: pageWidth, height: 8, color: primary });
  drawText(data.club_name, { size: 10, color: muted });
  y -= 2;
  drawText(data.template_title, { size: 22, font: bold });
  y -= 6;
  drawText(`Template version ${data.template_version} · Signed ${new Date(data.signed_at).toLocaleString("en-AU")}`, { size: 9, color: muted });
  y -= 10;

  // Body: parse simple markdown-ish (# heading, **bold**, ---)
  const paragraphs = data.template_body.split(/\n{2,}/);
  for (const raw of paragraphs) {
    const block = raw.trim();
    if (!block) continue;
    if (block === "---") {
      ensureSpace(14);
      page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: pageWidth - margin, y: y - 4 }, thickness: 0.5, color: muted });
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
    // Strip **bold** and render as regular (simple approach). Keep it readable.
    const clean = block.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\n/g, " ");
    drawText(clean, { size: 11 });
    y -= 4;
  }

  // Details table
  y -= 8;
  ensureSpace(20);
  drawText("Participant details", { size: 13, font: bold, color: primary });
  const rows: [string, string][] = [
    ["Full name", data.full_name],
    ["Date of birth", data.date_of_birth],
    ["Address", data.address],
    ["Phone", data.phone],
    ["Email", data.email],
    ["Emergency contact", `${data.emergency_contact_name} (${data.emergency_contact_phone})`],
    ["Medical notes", data.medical_notes || "None provided"],
  ];
  for (const [label, value] of rows) {
    ensureSpace(16);
    page.drawText(label, { x: margin, y: y - 10, size: 9, font: bold, color: muted });
    y -= 12;
    for (const line of wrap(value, 11, font)) {
      ensureSpace(14);
      page.drawText(line, { x: margin, y: y - 11, size: 11, font, color: ink });
      y -= 14;
    }
    y -= 2;
  }

  // Acknowledgements
  y -= 6;
  ensureSpace(20);
  drawText("Acknowledgements", { size: 13, font: bold, color: primary });
  const acks: [boolean, string][] = [
    [data.ack_risk, "I understand the risks of Japanese Jiu-Jitsu training and participate voluntarily."],
    [data.ack_release, "I release Sydney Jitsu Inc, UTS Jitsu, its instructors and training partners from liability, except for gross negligence."],
    [data.ack_media, "I consent to photos and video for club promotion (optional)."],
  ];
  for (const [checked, text] of acks) {
    ensureSpace(20);
    page.drawRectangle({ x: margin, y: y - 12, width: 10, height: 10, borderColor: ink, borderWidth: 0.8 });
    if (checked) {
      page.drawText("X", { x: margin + 2, y: y - 11, size: 9, font: bold, color: primary });
    }
    const lines = wrap(text, 10, font);
    for (let i = 0; i < lines.length; i++) {
      page.drawText(lines[i], { x: margin + 18, y: y - 10 - i * 12, size: 10, font, color: ink });
    }
    y -= Math.max(16, lines.length * 12 + 4);
  }

  // Signature
  y -= 10;
  ensureSpace(60);
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 260, y }, thickness: 0.5, color: muted });
  y -= 14;
  page.drawText(data.signature_name, { x: margin, y: y - 4, size: 14, font: bold, color: ink });
  y -= 22;
  page.drawText(`Electronically signed on ${new Date(data.signed_at).toLocaleString("en-AU")}`, { x: margin, y, size: 9, font, color: muted });

  return await doc.save();
}
