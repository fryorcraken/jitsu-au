import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AU_STATES,
  auAddressColumns,
  auAddressFromRow,
  auAddressProblems,
  auAddressSchema,
  completeAuAddress,
  composeAuAddress,
  draftAddressLine,
  EMPTY_AU_ADDRESS,
  addressPartsFromLine,
  isBlankAuAddress,
  readComposedAuAddress,
  postcodeStateNote,
  resolveAddressInput,
  sameAuAddress,
  splitAuAddress,
  type AuAddress,
} from "./au-address";

// The migration that defines what the database composes and splits. These
// tests read it, because a waiver whose line differs from the database's
// composition by one character is refused by `waivers_address_matches_parts`,
// and that would stop every waiver from being signed.
const MIGRATION = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "supabase",
    "migrations",
    "20261029000000_structured_address.sql",
  ),
  "utf8",
);

const broadway: AuAddress = {
  street: "1 Broadway",
  suburb: "Ultimo",
  state: "NSW",
  postcode: "2007",
};

/** Evaluate a SQL `a || ', ' || b` concatenation over an address's columns. */
function evalSqlConcat(expr: string, a: AuAddress): string {
  const columns = auAddressColumns(a) as Record<string, string | null>;
  return expr
    .split("||")
    .map((token) => {
      const t = token.trim();
      const literal = /^'(.*)'$/s.exec(t);
      if (literal) return literal[1].replaceAll("''", "'");
      const column = /^(?:NEW\.)?(address_\w+)$/.exec(t);
      if (!column) throw new Error(`unexpected token in the SQL composition: ${t}`);
      return columns[column[1]];
    })
    .join("");
}

describe("composeAuAddress", () => {
  it("writes the one line every screen, email and PDF reads", () => {
    expect(composeAuAddress(broadway)).toBe("1 Broadway, Ultimo NSW 2007");
  });

  it("matches the line the database requires on a waiver, character for character", () => {
    const check =
      /waivers_address_matches_parts CHECK \(\s*address_street IS NULL\s*OR address = ([\s\S]*?)\s*\);/.exec(
        MIGRATION,
      );
    expect(check, "the waivers_address_matches_parts CHECK was not found").not.toBeNull();
    for (const a of [
      broadway,
      { ...broadway, street: "Unit 3, 12 Smith St", state: "ACT" as const },
    ]) {
      expect(evalSqlConcat(check![1], a)).toBe(composeAuAddress(a));
    }
  });

  it("matches the line the profiles trigger composes", () => {
    const assignment = /NEW\.address := ([\s\S]*?);/.exec(MIGRATION);
    expect(assignment, "the trigger's composition was not found").not.toBeNull();
    expect(evalSqlConcat(assignment![1], broadway)).toBe(composeAuAddress(broadway));
  });

  it("reads back as the same parts it was made from", () => {
    expect(splitAuAddress(composeAuAddress(broadway))).toEqual(broadway);
  });
});

describe("splitAuAddress", () => {
  it("is the database's split_au_address, rule for rule", () => {
    // The pattern is a string literal in the migration; compare the two
    // sources, so a fix to one that misses the other fails here.
    const sql = /regexp_match\(\s*line,\s*'([^']+)',\s*'i'\s*\)/.exec(MIGRATION);
    expect(sql, "the split pattern was not found in the migration").not.toBeNull();
    // The TS module holds the same pattern as a regex literal.
    const tsSource = readFileSync(join(import.meta.dirname, "au-address.ts"), "utf8");
    const literal = /const SPLIT =\s*\/([\s\S]*?)\/i;/.exec(tsSource);
    expect(literal, "the TS split pattern was not found").not.toBeNull();
    expect(literal![1]).toBe(sql![1]);
    for (const state of AU_STATES) {
      const sqlLead = new RegExp(`WHEN '${state}'\\s+THEN '([^']+)'`).exec(MIGRATION)?.[1];
      const tsLead = new RegExp(`${state}: /([^/]+)/`).exec(tsSource)?.[1];
      expect(tsLead, state).toBe(sqlLead);
    }
  });

  it.each([
    ["1 Broadway, Ultimo NSW 2007", broadway],
    [
      "Unit 3, 12 Smith St, Pyrmont NSW 2009",
      { street: "Unit 3, 12 Smith St", suburb: "Pyrmont", state: "NSW", postcode: "2009" },
    ],
    [
      "12 Smith St, Pyrmont, NSW, 2009",
      { street: "12 Smith St", suburb: "Pyrmont", state: "NSW", postcode: "2009" },
    ],
    [
      "5 Quay St, Haymarket nsw 2000, Australia",
      { street: "5 Quay St", suburb: "Haymarket", state: "NSW", postcode: "2000" },
    ],
    [
      "4/20 Stuart Hwy, Darwin NT 0800",
      { street: "4/20 Stuart Hwy", suburb: "Darwin", state: "NT", postcode: "0800" },
    ],
    [
      "7 Main Rd, McMahons Point, NSW 2060 Australia",
      { street: "7 Main Rd", suburb: "McMahons Point", state: "NSW", postcode: "2060" },
    ],
  ])("reads %j", (line, parts) => {
    expect(splitAuAddress(line)).toEqual(parts);
  });

  it.each([
    ["no comma before the suburb", "1 Broadway Ultimo NSW 2007"],
    ["a street with no number", "Unit 3, Rose Avenue Glebe NSW 2037"],
    ["a suburb with a digit in it", "Unit 3, 12 Smith St Pyrmont NSW 2009"],
    ["a postcode that cannot belong to the state", "12 Smith St, Ultimo VIC 2007"],
    ["more than one line", "Unit 3\n12 Smith St, Ultimo NSW 2007"],
    ["an overseas address", "10 Downing St, London SW1A 2AA"],
    ["nothing at all", ""],
  ])("refuses %s rather than guessing", (_why, line) => {
    expect(splitAuAddress(line)).toBeNull();
  });
});

describe("auAddressProblems", () => {
  it("lists every blank part, in the order the form shows them", () => {
    expect(auAddressProblems(EMPTY_AU_ADDRESS).map((p) => p.part)).toEqual([
      "street",
      "suburb",
      "state",
      "postcode",
    ]);
  });

  it("is empty for a complete address", () => {
    expect(auAddressProblems(broadway)).toEqual([]);
  });

  it("says why a postcode or suburb typed in the wrong shape is not accepted", () => {
    const problems = auAddressProblems({ ...broadway, suburb: "Ultimo 2007", postcode: "207" });
    expect(problems.map((p) => [p.part, Boolean(p.hint)])).toEqual([
      ["suburb", true],
      ["postcode", true],
    ]);
  });

  it("agrees with the schema about what is acceptable", () => {
    for (const draft of [
      broadway,
      { ...broadway, postcode: "20070" },
      { ...broadway, suburb: "Ultimo, Sydney" },
      { ...broadway, street: "  " },
    ]) {
      const schemaOk = auAddressSchema.safeParse(draft).success;
      expect(auAddressProblems(draft).length === 0, JSON.stringify(draft)).toBe(schemaOk);
    }
  });
});

describe("auAddressSchema", () => {
  it("trims each part, as the database stores them", () => {
    expect(
      auAddressSchema.parse({
        street: " 1 Broadway ",
        suburb: " Ultimo ",
        state: "NSW",
        postcode: " 2007 ",
      }),
    ).toEqual(broadway);
  });

  it("refuses a state that is not one of the eight", () => {
    expect(auAddressSchema.safeParse({ ...broadway, state: "Nsw" }).success).toBe(false);
  });

  it("refuses a street over more than one line", () => {
    expect(auAddressSchema.safeParse({ ...broadway, street: "Unit 3\n12 Smith St" }).success).toBe(
      false,
    );
  });
});

describe("rows and drafts", () => {
  it("reads the parts off a row only when all four are there", () => {
    expect(auAddressFromRow(auAddressColumns(broadway))).toEqual(broadway);
    expect(auAddressFromRow({ ...auAddressColumns(broadway), address_postcode: null })).toBeNull();
    expect(auAddressFromRow({ ...auAddressColumns(broadway), address_state: "Nsw" })).toBeNull();
  });

  it("writes four nulls for no address", () => {
    expect(Object.values(auAddressColumns(null))).toEqual([null, null, null, null]);
  });

  it("knows a blank draft from a started one", () => {
    expect(isBlankAuAddress(EMPTY_AU_ADDRESS)).toBe(true);
    expect(isBlankAuAddress({ ...EMPTY_AU_ADDRESS, state: "VIC" })).toBe(false);
  });
});

describe("drafts on the way to an address", () => {
  it("reads as the composed line once complete, and as what is typed before", () => {
    expect(draftAddressLine({ ...broadway, street: " 1 Broadway " })).toBe(
      "1 Broadway, Ultimo NSW 2007",
    );
    expect(draftAddressLine({ ...EMPTY_AU_ADDRESS, street: "1 Broadway", state: "NSW" })).toBe(
      "1 Broadway, NSW",
    );
    expect(draftAddressLine(EMPTY_AU_ADDRESS)).toBe("");
  });

  it("gives the parts only when the draft would be accepted", () => {
    expect(completeAuAddress({ ...broadway, postcode: " 2007 " })).toEqual(broadway);
    expect(completeAuAddress({ ...broadway, state: "" })).toBeNull();
  });

  it("stores a line as typed when a client sends no parts", () => {
    expect(resolveAddressInput(" 1 Broadway Ultimo ", undefined)).toEqual({
      address: "1 Broadway Ultimo",
      parts: null,
    });
    expect(resolveAddressInput("ignored", broadway)).toEqual({
      address: "1 Broadway, Ultimo NSW 2007",
      parts: broadway,
    });
  });
});

describe("sameAuAddress", () => {
  it("reads a recomposed line as the address it was copied from", () => {
    expect(sameAuAddress("12 Smith St, Pyrmont, NSW, 2009", "12 Smith St, Pyrmont NSW 2009")).toBe(
      true,
    );
    expect(sameAuAddress("1 broadway,  ultimo nsw 2007", "1 Broadway, Ultimo NSW 2007")).toBe(true);
  });

  it("tells two different addresses apart", () => {
    expect(sameAuAddress("1 Broadway, Ultimo NSW 2007", "9 Quay St, Haymarket NSW 2000")).toBe(
      false,
    );
    expect(sameAuAddress("Rose Cottage, Glebe", "Ivy Cottage, Glebe")).toBe(false);
  });
});

describe("control characters", () => {
  // The database's [[:cntrl:]] in a UTF-8 locale reaches past ASCII, so the
  // app's rule has to as well, or a pasted value fails its CHECK mid-signing.
  it.each([
    ["a tab", "1 Broadway\tUnit 2"],
    ["a C1 next-line", "1 Broadway\u0085Unit 2"],
    ["a line separator", "1 Broadway\u2028Unit 2"],
  ])("refuses %s in the street, and says so under the field", (_why, street) => {
    expect(auAddressSchema.safeParse({ ...broadway, street }).success).toBe(false);
    expect(auAddressProblems({ ...broadway, street })).toEqual([
      {
        part: "street",
        label: "Street address",
        hint: "Please keep the street address on one line",
      },
    ]);
  });
});

describe("postcodeStateNote", () => {
  it("says nothing while the postcode and state agree, or are not both in", () => {
    expect(postcodeStateNote(broadway)).toBeNull();
    expect(postcodeStateNote({ ...broadway, state: "" })).toBeNull();
    expect(postcodeStateNote({ ...broadway, postcode: "20" })).toBeNull();
  });

  // The slip it is for: a right postcode next to the wrong state from the list.
  it("asks about a state the postcode does not usually belong to, naming the usual one", () => {
    expect(postcodeStateNote({ ...broadway, state: "VIC" })).toBe(
      "2007 is usually in NSW, not VIC. Please check the state, unless you're just over the border.",
    );
  });

  it("names every state a postcode can belong to", () => {
    expect(postcodeStateNote({ ...broadway, state: "QLD", postcode: "2600" })).toMatch(
      /usually in ACT or NSW, not QLD/,
    );
  });

  it("flags a postcode no state uses", () => {
    expect(postcodeStateNote({ ...broadway, postcode: "0100" })).toMatch(
      /doesn't look like an Australian postcode/,
    );
  });

  // A note, never a refusal: a border town's real postcode must still go in.
  it("never stops a border town's real address being accepted", () => {
    const barooga = {
      street: "1 Vermont St",
      suburb: "Barooga",
      state: "NSW" as const,
      postcode: "3644",
    };
    expect(postcodeStateNote(barooga)).not.toBeNull();
    expect(auAddressProblems(barooga)).toEqual([]);
    expect(completeAuAddress(barooga)).toEqual(barooga);
  });
});

describe("readComposedAuAddress", () => {
  // Lines this app composed from parts somebody entered. splitAuAddress
  // refuses both of these on purpose, which is why the guardian's address,
  // stored only as its line, has to be read back this way.
  it.each([
    [{ street: "Rose Cottage", suburb: "Glebe", state: "NSW", postcode: "2037" }],
    [{ street: "Lot 12", suburb: "Barooga", state: "NSW", postcode: "3644" }],
  ] as const)("reads back %j", (parts) => {
    const line = composeAuAddress(parts);
    expect(splitAuAddress(line)).toBeNull();
    expect(readComposedAuAddress(line)).toEqual(parts);
    expect(addressPartsFromLine(line)).toEqual(parts);
  });

  it("reads nothing that is not exactly the composed shape", () => {
    expect(readComposedAuAddress("1 Broadway, Ultimo, NSW 2007")).toBeNull();
    expect(readComposedAuAddress("1 Broadway Ultimo NSW 2007")).toBeNull();
    expect(readComposedAuAddress("Unit 3, 12 Smith St Pyrmont NSW 2009")).toBeNull();
  });

  it("falls back to the careful split for a line somebody typed", () => {
    expect(addressPartsFromLine("5 Quay St, Haymarket nsw 2000, Australia")).toEqual({
      street: "5 Quay St",
      suburb: "Haymarket",
      state: "NSW",
      postcode: "2000",
    });
  });
});

describe("auAddressSchema refuses keys it does not read", () => {
  // Dropping a `unit` silently would put a shorter address on a signed waiver.
  it("refuses a unit or a country rather than dropping it", () => {
    expect(auAddressSchema.safeParse({ ...broadway, unit: "3" }).success).toBe(false);
    expect(auAddressSchema.safeParse({ ...broadway, country: "AU" }).success).toBe(false);
  });
});
