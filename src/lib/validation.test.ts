import { describe, expect, it } from "vitest";
import {
  composeFullName,
  contactSchema,
  decodeDataUrlPng,
  interestSchema,
  saveTemplateSchema,
  splitFullName,
  waiverSubmitSchema,
} from "./validation";

describe("composeFullName", () => {
  it("joins first/middle/last with single spaces", () => {
    expect(composeFullName("Ada", "M", "Lovelace")).toBe("Ada M Lovelace");
  });

  it("drops blank/whitespace-only parts", () => {
    expect(composeFullName("Ada", "", "Lovelace")).toBe("Ada Lovelace");
    expect(composeFullName("Ada", "   ", "Lovelace")).toBe("Ada Lovelace");
  });

  it("trims each part", () => {
    expect(composeFullName("  Ada ", " M ", " Lovelace ")).toBe("Ada M Lovelace");
  });

  it("returns empty string when everything is blank", () => {
    expect(composeFullName("", " ", "")).toBe("");
  });
});

describe("splitFullName", () => {
  it("returns first only for a single word", () => {
    expect(splitFullName("Ada")).toEqual({ first: "Ada", middle: "", last: "" });
  });

  it("splits two words into first + last", () => {
    expect(splitFullName("Ada Lovelace")).toEqual({ first: "Ada", middle: "", last: "Lovelace" });
  });

  it("folds the middle words into the middle name for three+ words", () => {
    expect(splitFullName("Ada King Byron Lovelace")).toEqual({
      first: "Ada",
      middle: "King Byron",
      last: "Lovelace",
    });
  });

  it("collapses extra whitespace and ignores leading/trailing spaces", () => {
    expect(splitFullName("  Ada   M   Lovelace  ")).toEqual({
      first: "Ada",
      middle: "M",
      last: "Lovelace",
    });
  });

  it("returns all-empty parts for a blank string", () => {
    expect(splitFullName("   ")).toEqual({ first: "", middle: "", last: "" });
  });

  it("round-trips through composeFullName for a simple name", () => {
    const { first, middle, last } = splitFullName("Ada Lovelace");
    expect(composeFullName(first, middle, last)).toBe("Ada Lovelace");
  });
});

describe("decodeDataUrlPng", () => {
  it("decodes a valid base64 PNG data URL to bytes", () => {
    // "PNG" -> base64 "UE5H"
    const bytes = decodeDataUrlPng("data:image/png;base64,UE5H");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes!)).toEqual([0x50, 0x4e, 0x47]);
  });

  it("returns null for an empty string", () => {
    expect(decodeDataUrlPng("")).toBeNull();
  });

  it("returns null for a non-PNG or non-data-URL string", () => {
    expect(decodeDataUrlPng("data:image/jpeg;base64,UE5H")).toBeNull();
    expect(decodeDataUrlPng("just a name")).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(decodeDataUrlPng("data:image/png;base64,@@@not-base64@@@")).toBeNull();
  });
});

describe("interestSchema", () => {
  const valid = {
    name: "Sam Trainee",
    email: "sam@example.com",
    uts_student: true,
  };

  it("accepts a minimal valid submission", () => {
    expect(interestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an invalid email", () => {
    expect(interestSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(interestSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects a name over 100 chars", () => {
    expect(interestSchema.safeParse({ ...valid, name: "a".repeat(101) }).success).toBe(false);
  });

  it("rejects a filled honeypot", () => {
    expect(interestSchema.safeParse({ ...valid, hp: "bot" }).success).toBe(false);
  });

  it("allows an empty honeypot", () => {
    expect(interestSchema.safeParse({ ...valid, hp: "" }).success).toBe(true);
  });
});

describe("contactSchema", () => {
  const valid = {
    name: "Sam",
    email: "sam@example.com",
    message: "Hello, when do beginner classes run?",
  };

  it("accepts a valid message", () => {
    expect(contactSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a non-empty message", () => {
    expect(contactSchema.safeParse({ ...valid, message: "" }).success).toBe(false);
  });

  it("rejects a message over 2000 chars", () => {
    expect(contactSchema.safeParse({ ...valid, message: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("waiverSubmitSchema", () => {
  const validAdult = {
    first_name: "Ada",
    last_name: "Lovelace",
    date_of_birth: "1990-12-10",
    address: "1 Broadway, Ultimo NSW",
    phone: "0400000000",
    email: "ada@example.com",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_phone: "0400000001",
    ack_risk: true as const,
    ack_release: true as const,
    ack_media: false,
    signature_name: "Ada Lovelace",
  };

  it("accepts a valid adult waiver with a typed signature", () => {
    expect(waiverSubmitSchema.safeParse(validAdult).success).toBe(true);
  });

  it("accepts a drawn signature (image) with no typed name", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      signature_name: "",
      signature_image: "data:image/png;base64,UE5H",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when neither typed nor drawn signature is provided", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      signature_name: "",
      signature_image: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("signature_name"))).toBe(true);
    }
  });

  it("requires ack_risk and ack_release to be literally true", () => {
    expect(waiverSubmitSchema.safeParse({ ...validAdult, ack_risk: false }).success).toBe(false);
    expect(waiverSubmitSchema.safeParse({ ...validAdult, ack_release: false }).success).toBe(false);
  });

  it("rejects a malformed date of birth", () => {
    expect(
      waiverSubmitSchema.safeParse({ ...validAdult, date_of_birth: "10/12/1990" }).success,
    ).toBe(false);
  });

  it("defaults is_minor to false when omitted", () => {
    const result = waiverSubmitSchema.safeParse(validAdult);
    expect(result.success && result.data.is_minor).toBe(false);
  });

  it("requires guardian details for a minor", () => {
    const result = waiverSubmitSchema.safeParse({ ...validAdult, is_minor: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("guardian_name"))).toBe(true);
    }
  });

  it("accepts a minor with full guardian details and signature", () => {
    const result = waiverSubmitSchema.safeParse({
      ...validAdult,
      is_minor: true,
      guardian_name: "Charles Babbage",
      guardian_relationship: "Father",
      guardian_signature: "Charles Babbage",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a filled honeypot", () => {
    expect(waiverSubmitSchema.safeParse({ ...validAdult, hp: "bot" }).success).toBe(false);
  });
});

describe("saveTemplateSchema", () => {
  it("accepts a valid template", () => {
    expect(saveTemplateSchema.safeParse({ title: "Waiver v2", body_md: "# Hi" }).success).toBe(
      true,
    );
  });

  it("requires a non-empty title and body", () => {
    expect(saveTemplateSchema.safeParse({ title: "", body_md: "# Hi" }).success).toBe(false);
    expect(saveTemplateSchema.safeParse({ title: "T", body_md: "" }).success).toBe(false);
  });
});
