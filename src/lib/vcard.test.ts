import { describe, expect, it } from "vitest";
import { buildVCard, vCardFileName, type VCardPerson } from "./vcard";

function person(over: Partial<VCardPerson> = {}): VCardPerson {
  return {
    first_name: "Ada",
    middle_name: null,
    last_name: "Lovelace",
    preferred_name: null,
    guardian_user_id: null,
    email: "ada@example.com",
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

/** The day every card here is built on, so "still a minor" never drifts. */
const NOW = new Date("2026-10-30T00:00:00Z");

/** An account-holding minor: twelve on NOW. */
function minor(over: Partial<VCardPerson> = {}): VCardPerson {
  return person({ is_minor: true, date_of_birth: "2014-05-01", ...over });
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

  const GUARDIAN = "22222222-2222-4222-8222-222222222222";

  /** Only the TEL / EMAIL lines, in card order. */
  function contactLines(card: string): string[] {
    return lines(card).filter((l) => l.startsWith("TEL") || l.startsWith("EMAIL"));
  }

  it("labels a dependant's phone and email as their guardian's, not the child's", () => {
    // How a dependant filing actually lands: the parent's number and mailbox on
    // the child's record, and nothing typed in the guardian fields.
    const card = buildVCard(
      person({
        guardian_user_id: GUARDIAN,
        is_minor: true,
        phone: "0400 000 003",
        email: "parent@example.com",
        guardian_name: "Pat Lovelace",
        emergency_contact_phone: "0400 000 004",
      }),
    );
    expect(contactLines(card)).toEqual([
      "TEL;TYPE=X-Guardian:0400 000 003",
      "TEL;TYPE=X-Emergency:0400 000 004",
      "EMAIL;TYPE=X-Guardian:parent@example.com",
    ]);
    expect(card).not.toContain("TYPE=CELL");
    expect(card).not.toContain("TYPE=HOME:parent");
  });

  it("treats a dependant as having a guardian even when is_minor is false", () => {
    const card = buildVCard(
      person({
        guardian_user_id: GUARDIAN,
        is_minor: false,
        guardian_name: "Pat Lovelace",
        guardian_relationship: "Parent",
        guardian_phone: "0400 000 009",
      }),
    );
    expect(contactLines(card)).toContain("TEL;TYPE=X-Guardian:0400 000 009");
    expect(lines(card).find((l) => l.startsWith("NOTE:"))).toContain(
      "Guardian: Pat Lovelace (Parent)",
    );
  });

  it("writes one number once, with every label it was typed under", () => {
    // An account-holding minor whose parent filled every field with their own
    // number. Three entries for one number would call it the child's mobile first.
    const card = buildVCard(
      minor({
        phone: "0400 000 003",
        guardian_phone: "0400000003",
        emergency_contact_phone: "0400 000 003",
      }),
      NOW,
    );
    expect(contactLines(card).filter((l) => l.startsWith("TEL"))).toEqual([
      "TEL;TYPE=X-Guardian-Emergency:0400 000 003",
    ]);
  });

  it.each(["+61 400 000 003", "0061 400 000 003", "+61 (0)400 000 003"])(
    "knows %s is the same number as 0400 000 003",
    (international) => {
      const card = buildVCard(
        minor({
          phone: "0400 000 003",
          guardian_phone: international,
          emergency_contact_phone: null,
        }),
        NOW,
      );
      expect(contactLines(card).filter((l) => l.startsWith("TEL"))).toEqual([
        "TEL;TYPE=X-Guardian:0400 000 003",
      ]);
    },
  );

  it("keeps an adult's own mobile as theirs when it is also their emergency number", () => {
    const card = buildVCard(person({ emergency_contact_phone: "0400 000 001" }), NOW);
    expect(contactLines(card).filter((l) => l.startsWith("TEL"))).toEqual([
      "TEL;TYPE=X-Mobile-Emergency:0400 000 001",
    ]);
  });

  it("keeps a teenager's own mobile as theirs when they are on a parent's account", () => {
    const card = buildVCard(
      person({
        guardian_user_id: GUARDIAN,
        date_of_birth: "2009-03-01",
        phone: "0400 000 005",
        guardian_phone: "0400 000 003",
        emergency_contact_phone: null,
      }),
      NOW,
    );
    expect(contactLines(card).filter((l) => l.startsWith("TEL"))).toEqual([
      "TEL;TYPE=CELL:0400 000 005",
      "TEL;TYPE=X-Guardian:0400 000 003",
    ]);
  });

  it("labels a minor's email as the guardian's when it is the guardian's address", () => {
    const card = buildVCard(
      minor({ email: "parent@example.com", guardian_email: "Parent@example.com" }),
      NOW,
    );
    expect(contactLines(card).filter((l) => l.startsWith("EMAIL"))).toEqual([
      "EMAIL;TYPE=X-Guardian:parent@example.com",
    ]);
  });

  it("keeps a minor's own number and email beside their guardian's", () => {
    const card = buildVCard(
      minor({
        guardian_name: "Pat Lovelace",
        guardian_relationship: "Parent",
        guardian_phone: "0400 000 003",
        guardian_email: "parent@example.com",
      }),
      NOW,
    );
    expect(contactLines(card)).toEqual([
      "TEL;TYPE=CELL:0400 000 001",
      "TEL;TYPE=X-Guardian:0400 000 003",
      "TEL;TYPE=X-Emergency:0400 000 002",
      "EMAIL;TYPE=HOME:ada@example.com",
      "EMAIL;TYPE=X-Guardian:parent@example.com",
    ]);
    expect(lines(card).find((l) => l.startsWith("NOTE:"))).toContain(
      "Guardian: Pat Lovelace (Parent)",
    );
  });

  it("drops the guardian once a minor has turned 18, whatever the waiver tick says", () => {
    const grownUp = { guardian_name: "Pat Lovelace", guardian_phone: "0400 000 003" };
    // Signed at 17, and 18 today.
    expect(buildVCard(minor({ ...grownUp, date_of_birth: "2008-10-30" }), NOW)).not.toContain(
      "Guardian",
    );
    // The day before their birthday they are still 17.
    expect(buildVCard(minor({ ...grownUp, date_of_birth: "2008-10-31" }), NOW)).toContain(
      "TEL;TYPE=X-Guardian:0400 000 003",
    );
    // The 18th birthday is Sydney's date: 8am there on the 30th is still the
    // 29th in UTC, and they are already an adult.
    expect(
      buildVCard(
        minor({ ...grownUp, date_of_birth: "2008-10-30" }),
        new Date("2026-10-29T21:00:00Z"),
      ),
    ).not.toContain("Guardian");
    // With no birthday on file, the tick is all there is to go on.
    expect(buildVCard(minor({ ...grownUp, date_of_birth: null }), NOW)).toContain(
      "TEL;TYPE=X-Guardian:0400 000 003",
    );
  });

  it("keeps a dependant's guardian after they turn 18", () => {
    const card = buildVCard(
      person({ guardian_user_id: GUARDIAN, guardian_phone: "0400 000 003" }),
      NOW,
    );
    expect(card).toContain("TEL;TYPE=X-Guardian:0400 000 003");
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
