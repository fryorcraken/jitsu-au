import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaiverDocument, type WaiverDocumentProps } from "./WaiverDocument";
import {
  applyWaiverPlaceholders,
  bodyReferences,
  buildWaiverPlaceholders,
  parseWaiverBlocks,
} from "@/lib/waiver-document";

const base: WaiverDocumentProps = {
  fullName: "Jane Sample",
  firstName: "Jane",
  preferredName: "",
  dateOfBirth: "1995-06-12",
  address: "123 Broadway, Ultimo NSW 2007",
  phone: "0400 000 000",
  email: "jane@example.com",
  emergencyContactName: "John Sample",
  emergencyContactRelationship: "Partner",
  emergencyContactPhone: "0400 111 222",
  medicalNotes: "",
  healthAnswers: {
    drugs: false,
    blackouts: false,
    device: false,
    impairments: false,
    other: false,
  },
  acknowledgements: [],
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
  it("recognises headings, rules, and paragraphs", () => {
    expect(parseWaiverBlocks("# H1\n\n## H2\n\n---\n\nparagraph")).toEqual([
      { kind: "h1", text: "H1" },
      { kind: "h2", text: "H2" },
      { kind: "hr" },
      { kind: "p", text: "paragraph" },
    ]);
  });

  // The document is a form: "Full name: …" and "Date of birth: …" on
  // consecutive lines must stay on consecutive lines. They used to be joined
  // into one run-on sentence.
  it("keeps a single newline inside a paragraph as a line break", () => {
    expect(parseWaiverBlocks("Full name: Jane\nDate of birth: 1995-06-12")).toEqual([
      { kind: "p", text: "Full name: Jane\nDate of birth: 1995-06-12" },
    ]);
  });

  it("skips blank blocks", () => {
    expect(parseWaiverBlocks("\n\n  \n\ntext")).toEqual([{ kind: "p", text: "text" }]);
  });
});

describe("waiver placeholders", () => {
  const input = {
    fullName: "Jane Sample",
    firstName: "Jane",
    preferredName: "",
    dateOfBirth: "1995-06-12",
    address: "1 Broadway",
    phone: "0400",
    email: "jane@example.com",
    emergencyContactName: "John",
    emergencyContactRelationship: "Partner",
    emergencyContactPhone: "0411",
    medicalNotes: "",
    healthAnswers: {
      drugs: false,
      blackouts: false,
      device: true,
      impairments: false,
      other: false,
    },
    isMinor: false,
    signedDate: "21/07/2026",
    signatureName: "",
    clubName: "UTS Jitsu",
  };
  const values = buildWaiverPlaceholders(input);

  it("empty medical notes become 'None provided'", () => {
    expect(values.medical_notes).toBe("None provided");
  });

  it("signature_name falls back to the full name when not typed", () => {
    expect(values.signature_name).toBe("Jane Sample");
  });

  it("preferred_name falls back to the first name when not given", () => {
    expect(values.preferred_name).toBe("Jane");
  });

  it("preferred_name uses the submitted preferred name when given", () => {
    const withPreferred = buildWaiverPlaceholders({ ...input, preferredName: "Janey" });
    expect(withPreferred.preferred_name).toBe("Janey");
  });

  // The live preview feeds raw form state while the PDF feeds Zod-trimmed
  // input, so a whitespace-only entry must fall back in both, not render blank
  // on screen and the first name on paper.
  it("preferred_name falls back when the entry is only whitespace", () => {
    const blank = buildWaiverPlaceholders({ ...input, preferredName: "   " });
    expect(blank.preferred_name).toBe("Jane");
  });

  // Only reachable in the half-filled live preview: never render an empty
  // greeting, even before the signer has typed a first name.
  it("preferred_name falls back to the full name when there is no first name", () => {
    const noFirst = buildWaiverPlaceholders({ ...input, preferredName: "", firstName: "" });
    expect(noFirst.preferred_name).toBe("Jane Sample");
  });

  it("renders each health answer as Yes or No", () => {
    expect(values.health_device).toBe("Yes");
    expect(values.health_drugs).toBe("No");
  });

  it("ticks exactly one participant-type box, from the age", () => {
    expect(values.adult_checkbox).toBe("[X]");
    expect(values.minor_checkbox).toBe("[  ]");
    const minor = buildWaiverPlaceholders({ ...input, isMinor: true });
    expect(minor.adult_checkbox).toBe("[  ]");
    expect(minor.minor_checkbox).toBe("[X]");
  });

  // For a minor the guardian IS the emergency contact, so the guardian tokens
  // read off that one block instead of a second copy of the same person.
  it("fills the guardian tokens from the emergency contact for a minor only", () => {
    expect(values.guardian_name).toBe("N/A");
    expect(values.guardian_relationship).toBe("N/A");
    const minor = buildWaiverPlaceholders({ ...input, isMinor: true });
    expect(minor.guardian_name).toBe("John");
    expect(minor.guardian_relationship).toBe("Partner");
  });

  it("reports whether the body prints a token, so a renderer can fall back", () => {
    expect(bodyReferences("Blackouts: {{health_blackouts}}", ["health_blackouts"])).toBe(true);
    // Whitespace inside the braces is how the substituter accepts them too.
    expect(bodyReferences("{{ health_drugs }}", ["health_drugs"])).toBe(true);
    expect(bodyReferences("# Terms\n\nTrain safely.", ["health_drugs"])).toBe(false);
    // A near-miss must not read as "the body covers it".
    expect(bodyReferences("health_drugs", ["health_drugs"])).toBe(false);
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

  it("renders acknowledgements from the prop, marking checked state and filling label tokens", () => {
    render(
      <WaiverDocument
        {...base}
        clubName="UTS Jitsu"
        acknowledgements={[
          { label: "I accept the risks.", checked: true },
          { label: "I release {{club_name}} from liability.", checked: false },
        ]}
      />,
    );
    const accepted = screen.getByText("I accept the risks.").closest("li")!;
    const declined = screen.getByText("I release UTS Jitsu from liability.").closest("li")!;
    expect(within(accepted).getByText("✓")).toBeInTheDocument();
    expect(within(declined).queryByText("✓")).not.toBeInTheDocument();
  });

  // The health answers have no column behind them, so a template that never
  // prints them would lose them entirely. The document falls back to a section
  // of its own, matching the PDF.
  it("prints the health declaration when the body does not", () => {
    render(<WaiverDocument {...base} healthAnswers={{ ...base.healthAnswers, drugs: true }} />);
    expect(screen.getByText("Health declaration")).toBeInTheDocument();
    expect(screen.getByText(/prescribed any drugs/)).toBeInTheDocument();
    expect(screen.getAllByText("Yes").length).toBeGreaterThanOrEqual(1);
  });

  it("leaves it to the body when the body prints it", () => {
    render(<WaiverDocument {...base} templateBody={"Drugs: {{health_drugs}}"} />);
    expect(screen.queryByText("Health declaration")).not.toBeInTheDocument();
    expect(screen.getByText(/Drugs: No/)).toBeInTheDocument();
  });

  it("omits the acknowledgements section when there are none", () => {
    render(<WaiverDocument {...base} acknowledgements={[]} />);
    expect(screen.queryByText("Acknowledgements")).not.toBeInTheDocument();
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
