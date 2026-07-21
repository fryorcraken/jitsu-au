import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  applyWaiverPlaceholders,
  buildWaiverPlaceholders,
  parseWaiverBlocks,
} from "@/lib/waiver-document";

/**
 * Props for {@link WaiverDocument}. These mirror the fields that
 * `renderWaiverPdf` (src/lib/waiver-pdf.ts) draws, so the on-screen HTML stays
 * visually close to the generated PDF.
 */
export type WaiverDocumentProps = {
  fullName: string;
  dateOfBirth: string;
  address: string;
  phone: string;
  email: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  medicalNotes: string;
  ackRisk: boolean;
  ackRelease: boolean;
  ackMedia: boolean;
  /** Typed signature name (used when the participant did not draw). */
  signatureName: string;
  /** Data URL (image/png) of the drawn participant signature, if any. */
  signatureImage?: string;
  templateTitle: string;
  templateBody: string;
  templateVersion: number | null;
  clubName: string;
  /** ISO timestamp; omit/empty for an unsigned draft. */
  signedAt?: string | null;
  isMinor: boolean;
  guardianName: string;
  guardianRelationship: string;
  guardianSignature: string;
  guardianSignatureImage?: string;
  /** When true, show a DRAFT watermark and hide the "signed on" footers. */
  draft?: boolean;
  className?: string;
};

const PRIMARY = "#008eaa"; // matches the PDF header/accent colour

const ACK_LABELS = {
  risk: "I understand the risks of Japanese Jiu-Jitsu training and participate voluntarily.",
  release:
    "I release Sydney Jitsu Inc, UTS Jitsu, its instructors and training partners from liability, except for gross negligence.",
  media: "I consent to photos and video for club promotion (optional).",
} as const;

/** Render `**bold**` spans within a line of body text. */
function renderInline(text: string): ReactNode {
  const parts = text.split(/(\*\*.+?\*\*)/g);
  return parts.map((part, i) => {
    const m = /^\*\*(.+?)\*\*$/.exec(part);
    if (m) return <strong key={i}>{m[1]}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-AU");
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-slate-100 py-2 last:border-b-0">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-800">
        {value || "—"}
      </dd>
    </div>
  );
}

function Acknowledgement({ checked, children }: { checked: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-[3px] border text-[10px] font-bold text-white",
          checked ? "border-transparent" : "border-slate-400",
        )}
        style={checked ? { backgroundColor: PRIMARY } : undefined}
      >
        {checked ? "✓" : ""}
      </span>
      <span className="text-sm leading-snug text-slate-800">{children}</span>
    </li>
  );
}

function SignatureBlock({
  image,
  name,
  caption,
}: {
  image?: string;
  name: string;
  caption?: string;
}) {
  return (
    <div>
      <div className="flex h-16 max-w-[280px] items-end border-b border-slate-400 pb-1">
        {image ? (
          <img src={image} alt="Signature" className="max-h-14 w-auto object-contain" />
        ) : (
          <span className="pb-1 text-lg font-semibold text-slate-800">{name || " "}</span>
        )}
      </div>
      {image && name ? <p className="mt-1 text-xs text-slate-500">{name}</p> : null}
      {caption ? <p className="mt-1 text-xs text-slate-500">{caption}</p> : null}
    </div>
  );
}

/**
 * HTML rendering of a signed (or draft) waiver, kept visually close to the
 * generated PDF but fully responsive so it reads well on mobile. The paper look
 * is fixed light-on-white regardless of the site theme, matching the PDF.
 */
export function WaiverDocument(props: WaiverDocumentProps) {
  const {
    fullName,
    dateOfBirth,
    address,
    phone,
    email,
    emergencyContactName,
    emergencyContactPhone,
    medicalNotes,
    ackRisk,
    ackRelease,
    ackMedia,
    signatureName,
    signatureImage,
    templateTitle,
    templateBody,
    templateVersion,
    clubName,
    signedAt,
    isMinor,
    guardianName,
    guardianRelationship,
    guardianSignature,
    guardianSignatureImage,
    draft,
    className,
  } = props;

  // Participant data appears only where the template body uses a {{placeholder}}.
  const filledBody = applyWaiverPlaceholders(
    templateBody,
    buildWaiverPlaceholders({
      fullName,
      dateOfBirth,
      address,
      phone,
      email,
      emergencyContactName,
      emergencyContactPhone,
      medicalNotes,
      signatureName,
      clubName,
      signedDate: signedAt ? new Date(signedAt).toLocaleDateString("en-AU") : "",
    }),
  );
  const blocks = parseWaiverBlocks(filledBody);
  const metaLine = draft
    ? "Draft preview"
    : `Template version ${templateVersion ?? "—"}${
        signedAt ? ` · Signed ${formatDate(signedAt)}` : ""
      }`;

  return (
    <article
      className={cn(
        "relative isolate overflow-hidden rounded-xl bg-white text-slate-900 shadow-sm ring-1 ring-slate-200",
        className,
      )}
    >
      <div className="h-2 w-full" style={{ backgroundColor: PRIMARY }} />

      {draft ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
        >
          <span className="-rotate-[30deg] select-none whitespace-nowrap text-4xl font-black uppercase tracking-widest text-slate-200/70 sm:text-5xl">
            Draft — not signed
          </span>
        </div>
      ) : null}

      <div className="relative z-0 px-5 py-6 sm:px-8 sm:py-8">
        <p className="text-xs text-slate-500">{clubName}</p>
        <h2 className="mt-1 text-2xl font-bold leading-tight text-slate-900">{templateTitle}</h2>
        <p className="mt-1 text-xs text-slate-500">{metaLine}</p>

        {/* Template body */}
        <div className="mt-5 space-y-3">
          {blocks.map((b, i) => {
            if (b.kind === "hr") return <hr key={i} className="my-4 border-slate-200" />;
            if (b.kind === "h1")
              return (
                <h3 key={i} className="pt-1 text-lg font-bold text-slate-900">
                  {renderInline(b.text)}
                </h3>
              );
            if (b.kind === "h2")
              return (
                <h4 key={i} className="pt-1 text-base font-bold text-slate-900">
                  {renderInline(b.text)}
                </h4>
              );
            return (
              <p key={i} className="text-sm leading-relaxed text-slate-700">
                {renderInline(b.text)}
              </p>
            );
          })}
        </div>

        {/* Acknowledgements */}
        <section className="mt-7">
          <h3 className="text-base font-bold" style={{ color: PRIMARY }}>
            Acknowledgements
          </h3>
          <ul className="mt-2 space-y-2">
            <Acknowledgement checked={ackRisk}>{ACK_LABELS.risk}</Acknowledgement>
            <Acknowledgement checked={ackRelease}>{ACK_LABELS.release}</Acknowledgement>
            <Acknowledgement checked={ackMedia}>{ACK_LABELS.media}</Acknowledgement>
          </ul>
        </section>

        {/* Participant signature */}
        <section className="mt-7">
          <SignatureBlock
            image={signatureImage}
            name={signatureName || fullName}
            caption={
              !draft && signedAt ? `Electronically signed on ${formatDate(signedAt)}` : undefined
            }
          />
        </section>

        {/* Guardian consent (minors only) */}
        {isMinor ? (
          <section className="mt-7">
            <h3 className="text-base font-bold" style={{ color: PRIMARY }}>
              Parent / guardian consent
            </h3>
            <dl className="mt-2">
              <DetailRow label="Guardian name" value={guardianName} />
              <DetailRow label="Relationship to participant" value={guardianRelationship} />
            </dl>
            <div className="mt-4">
              <SignatureBlock
                image={guardianSignatureImage}
                name={guardianSignature || guardianName}
                caption={
                  !draft && signedAt
                    ? `Guardian electronically signed on ${formatDate(signedAt)}`
                    : undefined
                }
              />
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
}
