import { describe, expect, it } from "vitest";
import { buildVCard, vCardFileName, type VCardPerson } from "./vcard";

function person(over: Partial<VCardPerson> = {}): VCardPerson {
  return {
    first_name: "Ada",
    middle_name: null,
    last_name: "Lovelace",
    preferred_name: null,
    email: "ada@example.com",
    email_belongs_to: null,
    phone: "0400 000 001",
    address: "1 Example St, Ultimo NSW 2007",
    date_of_birth: "1990-01-01",
    emergency_contact_name: "Bea",
    emergency_contact_relationship: "Sister",
    emergency_contact_phone: "0400 000 002",
    is_minor: false,
    guardian_name: null,
    guardian_relationship: null,
    guardian_phone: null,
    guardian_email: null,
    ...over,
  };
}

/** The card's lines, unfolded, without the CRLFs. */
function lines(card: string): string[] {
  return card.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}

describe("buildVCard", () => {
  it("writes a vCard 3.0 Android can import, with CRLF line ends", () => {
    const card = buildVCard(person());
    expect(card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(card.endsWith("END:VCARD\r\n")).toBe(true);
    expect(card.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("carries the name, mobile, email, address and birthday", () => {
    expect(lines(buildVCard(person({ middle_name: "King" })))).toEqual(
      expect.arrayContaining([
        "N:Lovelace;Ada;King;;",
        "FN:Ada King Lovelace",
        "TEL;TYPE=CELL:0400 000 001",
        "EMAIL;TYPE=HOME:ada@example.com",
        "ADR;TYPE=HOME:;;1 Example St\\, Ultimo NSW 2007;;;;",
        "BDAY:1990-01-01",
      ]),
    );
  });

  it("labels the emergency number, and names the contact in the note", () => {
    const card = lines(buildVCard(person()));
    expect(card).toContain("TEL;TYPE=X-Emergency:0400 000 002");
    expect(card).toContain("NOTE:UTS Jitsu\\nEmergency contact: Bea (Sister)");
  });

  it("adds a preferred name as a nickname, unless it is just the first name", () => {
    expect(lines(buildVCard(person({ preferred_name: "Addy" })))).toContain("NICKNAME:Addy");
    expect(buildVCard(person({ preferred_name: "ada" }))).not.toContain("NICKNAME");
  });

  it("leaves out what is missing rather than writing empty fields", () => {
    const card = buildVCard(
      person({
        phone: null,
        email: null,
        address: "  ",
        date_of_birth: null,
        emergency_contact_name: null,
        emergency_contact_relationship: null,
        emergency_contact_phone: null,
      }),
    );
    for (const field of ["TEL", "EMAIL", "ADR", "BDAY"]) expect(card).not.toContain(`${field};`);
    expect(card).not.toContain("BDAY");
    expect(lines(card)).toContain("NOTE:UTS Jitsu");
  });

  it("adds a minor's guardian, and lists a shared email only once", () => {
    const card = lines(
      buildVCard(
        person({
          is_minor: true,
          email: "parent@example.com",
          email_belongs_to: "Pat Lovelace",
          guardian_name: "Pat Lovelace",
          guardian_relationship: "Parent",
          guardian_phone: "0400 000 003",
          guardian_email: "Parent@example.com",
        }),
      ),
    );
    expect(card).toContain("TEL;TYPE=X-Guardian:0400 000 003");
    // A dependant's email is their account holder's, so it says so.
    expect(card.filter((l) => l.startsWith("EMAIL"))).toEqual([
      "EMAIL;TYPE=X-Guardian:parent@example.com",
    ]);
    expect(card.find((l) => l.startsWith("NOTE:"))).toContain("Guardian: Pat Lovelace (Parent)");
  });

  it("ignores guardian details on an adult's record", () => {
    const card = buildVCard(person({ guardian_name: "Pat", guardian_phone: "0400 000 003" }));
    expect(card).not.toContain("Guardian");
  });

  it("never carries medical notes, consents or kit sizes", () => {
    const card = buildVCard({
      ...person(),
      medical_notes: "Asthma",
      uts_student_number: "12345678",
      gi_size: "A2",
    } as VCardPerson);
    expect(card).not.toContain("Asthma");
    expect(card).not.toContain("12345678");
    expect(card).not.toContain("A2");
  });

  it("escapes the characters that would break a line", () => {
    const card = lines(
      buildVCard(person({ last_name: "O;Brien", address: "Unit 1\n2 Example St" })),
    );
    expect(card).toContain("N:O\\;Brien;Ada;;;");
    expect(card).toContain("ADR;TYPE=HOME:;;Unit 1\\n2 Example St;;;;");
  });

  it("folds long lines at 75 octets", () => {
    const card = buildVCard(person({ address: "Ü".repeat(60) }));
    for (const line of card.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(lines(card)).toContain(`ADR;TYPE=HOME:;;${"Ü".repeat(60)};;;;`);
  });

  it("links back to the person page when given one", () => {
    const url = "https://utsjitsu.com.au/manager/users/11111111-1111-4111-8111-111111111111";
    expect(lines(buildVCard(person({ url })))).toContain(`URL:${url}`);
  });
});

describe("vCardFileName", () => {
  it("names the file after the person", () => {
    expect(vCardFileName(person({ middle_name: "King" }))).toBe("Ada King Lovelace.vcf");
  });

  it("drops characters a file system refuses", () => {
    expect(vCardFileName(person({ last_name: 'Love/lace:"x"' }))).toBe("Ada Lovelacex.vcf");
  });

  it("falls back when there is no name", () => {
    expect(vCardFileName({ first_name: null, middle_name: null, last_name: null })).toBe(
      "contact.vcf",
    );
  });
});
