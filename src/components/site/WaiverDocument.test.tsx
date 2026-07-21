import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaiverDocument, type WaiverDocumentProps } from "./WaiverDocument";
import {
  applyWaiverPlaceholders,
  buildWaiverPlaceholders,
  parseWaiverBlocks,
} from "@/lib/waiver-document";

const base: WaiverDocumentProps = {
  fullName: "Jane Sample",
  dateOfBirth: "1995-06-12",
  address: "123 Broadway, Ultimo NSW 2007",
  phone: "0400 000 000",
  email: "jane@example.com",
  emergencyContactName: "John Sample",
  emergencyContactPhone: "0400 111 222",
  medicalNotes: "",
  ackRisk: true,
  ackRelease: true,
  ackMedia: false,
  signatureName: "Jane Sample",
  templateTitle: "Training Waiver",
  templateBody: "# Terms\n\nYou **must** train safely.\n\n---\n\n## Notes\n\nBe kind.",
  templateVersion: 3,
  clubName: "UTS Jitsu",
  signedAt: "2026-07-21T10:00:00.000Z",
  isMinor: false,
  guardianName: "",
  guardianRelationship: "",
  guardianSignature: "",
};

describe("parseWaiverBlocks", () => {
  it("recognises headings, rules, and paragraphs, and joins wrapped lines", () => {
    expect(parseWaiverBlocks("# H1\n\n## H2\n\n---\n\nline one\nline two")).toEqual([
      { kind: "h1", text: "H1" },
      { kind: "h2", text: "H2" },
      { kind: "hr" },
      { kind: "p", text: "line one line two" },
    ]);
  });

  it("skips blank blocks", () => {
    expect(parseWaiverBlocks("\n\n  \n\ntext")).toEqual([{ kind: "p", text: "text" }]);
  });
});

describe("waiver placeholders", () => {
  const values = buildWaiverPlaceholders({
    fullName: "Jane Sample",
    dateOfBirth: "1995-06-12",
    address: "1 Broadway",
    phone: "0400",
    email: "jane@example.com",
    emergencyContactName: "John",
    emergencyContactPhone: "0411",
    medicalNotes: "",
    signatureName: "",
    clubName: "UTS Jitsu",
    signedDate: "21/07/2026",
  });

  it("empty medical notes become 'None provided'", () => {
    expect(values.medical_notes).toBe("None provided");
  });

  it("signature_name falls back to the full name when not typed", () => {
    expect(values.signature_name).toBe("Jane Sample");
  });

  it("fills known tokens and leaves unknown tokens intact", () => {
    const body = "Hi {{full_name}} ({{club_name}}) on {{signed_date}}. {{mystery}}";
    expect(applyWaiverPlaceholders(body, values)).toBe(
      "Hi Jane Sample (UTS Jitsu) on 21/07/2026. {{mystery}}",
    );
  });
});

describe("WaiverDocument", () => {
  it("renders the title, meta line, and template body", () => {
    render(<WaiverDocument {...base} />);
    expect(screen.getByRole("heading", { name: "Training Waiver" })).toBeInTheDocument();
    expect(screen.getByText(/Template version 3/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Terms" })).toBeInTheDocument();
    // **bold** renders as an emphasised span, not literal asterisks
    expect(screen.getByText("must").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("shows form data only where the body uses a placeholder, with no auto details section", () => {
    render(<WaiverDocument {...base} templateBody={"{{full_name}}\n\n{{email}}"} />);
    // Values appear because the body referenced them...
    expect(screen.getAllByText("Jane Sample").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    // ...but there is no auto-generated "Participant details" section, and no
    // fields (address/phone) the body did not reference.
    expect(screen.queryByText("Participant details")).not.toBeInTheDocument();
    expect(screen.queryByText("123 Broadway, Ultimo NSW 2007")).not.toBeInTheDocument();
    expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
  });

  it("marks checked acknowledgements and leaves optional ones unchecked", () => {
    render(<WaiverDocument {...base} />);
    const risk = screen.getByText(/participate voluntarily/).closest("li")!;
    const media = screen.getByText(/photos and video/).closest("li")!;
    expect(within(risk).getByText("✓")).toBeInTheDocument();
    expect(within(media).queryByText("✓")).not.toBeInTheDocument();
  });

  it("shows the draft watermark and hides the signed footer when draft", () => {
    render(<WaiverDocument {...base} draft />);
    expect(screen.getByText(/Draft — not signed/i)).toBeInTheDocument();
    expect(screen.getByText("Draft preview")).toBeInTheDocument();
    expect(screen.queryByText(/Electronically signed on/)).not.toBeInTheDocument();
  });

  it("shows the signed footer when not a draft", () => {
    render(<WaiverDocument {...base} />);
    expect(screen.getByText(/Electronically signed on/)).toBeInTheDocument();
    expect(screen.queryByText(/Draft — not signed/i)).not.toBeInTheDocument();
  });

  it("renders the guardian block only for minors", () => {
    const { rerender } = render(<WaiverDocument {...base} />);
    expect(screen.queryByText("Parent / guardian consent")).not.toBeInTheDocument();

    rerender(
      <WaiverDocument
        {...base}
        isMinor
        guardianName="Pat Sample"
        guardianRelationship="Parent"
        guardianSignature="Pat Sample"
      />,
    );
    expect(screen.getByText("Parent / guardian consent")).toBeInTheDocument();
    expect(screen.getAllByText("Pat Sample").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Parent")).toBeInTheDocument();
  });

  it("renders a drawn signature image when provided", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    render(<WaiverDocument {...base} signatureImage={dataUrl} />);
    const img = screen.getByAltText("Signature") as HTMLImageElement;
    expect(img.src).toBe(dataUrl);
  });
});
