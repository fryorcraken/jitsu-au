import { describe, it, expect } from "vitest";
import { resolveWaiverContacts, type WaiverContactInput } from "./waiver-contacts";

describe("resolveWaiverContacts", () => {
  const base: WaiverContactInput = {
    isMinor: false,
    address: "1 Broadway, Ultimo NSW",
    phone: "0400 000 000",
    email: "kid@example.com",
    guardianName: "",
    guardianRelationship: "",
    guardianAddress: "",
    guardianPhone: "",
    guardianEmail: "",
    emergencyContactIsGuardian: false,
    emergencyContactName: "Grace Hopper",
    emergencyContactRelationship: "Aunt",
    emergencyContactPhone: "0400 111 111",
  };

  const minor: WaiverContactInput = {
    ...base,
    isMinor: true,
    guardianName: "Charles Babbage",
    guardianRelationship: "Father",
  };

  it("gives an adult no guardian at all", () => {
    const resolved = resolveWaiverContacts({
      ...base,
      guardianName: "Charles Babbage",
      guardianPhone: "0400 222 222",
    });
    expect(resolved.guardianName).toBe("");
    expect(resolved.guardianPhone).toBe("");
    expect(resolved.emergencyContactName).toBe("Grace Hopper");
  });

  // The whole point of the change: the person who signs and the person we ring
  // are allowed to be two different people.
  it("keeps a minor's guardian and emergency contact apart", () => {
    const resolved = resolveWaiverContacts(minor);
    expect(resolved.guardianName).toBe("Charles Babbage");
    expect(resolved.guardianRelationship).toBe("Father");
    expect(resolved.emergencyContactName).toBe("Grace Hopper");
    expect(resolved.emergencyContactRelationship).toBe("Aunt");
    expect(resolved.emergencyContactPhone).toBe("0400 111 111");
  });

  // A blank contact field is stored as the value it stands for, so nobody
  // reading the frozen record later has to work out what the blank meant.
  it("fills a blank guardian address, mobile and email from the participant's", () => {
    const resolved = resolveWaiverContacts(minor);
    expect(resolved.guardianAddress).toBe("1 Broadway, Ultimo NSW");
    expect(resolved.guardianPhone).toBe("0400 000 000");
    expect(resolved.guardianEmail).toBe("kid@example.com");
  });

  it("keeps the guardian's own address, mobile and email when they gave them", () => {
    const resolved = resolveWaiverContacts({
      ...minor,
      guardianAddress: "2 Harris St, Ultimo NSW",
      guardianPhone: "0400 222 222",
      guardianEmail: "charles@example.com",
    });
    expect(resolved.guardianAddress).toBe("2 Harris St, Ultimo NSW");
    expect(resolved.guardianPhone).toBe("0400 222 222");
    expect(resolved.guardianEmail).toBe("charles@example.com");
  });

  it("treats a whitespace-only guardian field as blank", () => {
    const resolved = resolveWaiverContacts({ ...minor, guardianPhone: "   " });
    expect(resolved.guardianPhone).toBe("0400 000 000");
  });

  // The form's default: one person is both, asked for once.
  it("copies the guardian into the emergency contact when they are the same person", () => {
    const resolved = resolveWaiverContacts({
      ...minor,
      emergencyContactIsGuardian: true,
      emergencyContactName: "",
      emergencyContactRelationship: "",
      emergencyContactPhone: "",
    });
    expect(resolved.emergencyContactName).toBe("Charles Babbage");
    expect(resolved.emergencyContactRelationship).toBe("Father");
    expect(resolved.emergencyContactPhone).toBe("0400 000 000");
  });

  it("copies the guardian's own mobile across, not the participant's, when they gave one", () => {
    const resolved = resolveWaiverContacts({
      ...minor,
      guardianPhone: "0400 222 222",
      emergencyContactIsGuardian: true,
      emergencyContactPhone: "",
    });
    expect(resolved.emergencyContactPhone).toBe("0400 222 222");
  });

  // A paper form from the club's old single-block layout names one person, and
  // that person is who signed it.
  it("falls back to the emergency contact for an unnamed guardian", () => {
    const resolved = resolveWaiverContacts({ ...base, isMinor: true });
    expect(resolved.guardianName).toBe("Grace Hopper");
    expect(resolved.guardianRelationship).toBe("Aunt");
    expect(resolved.guardianPhone).toBe("0400 000 000");
  });

  it("trims what it stores", () => {
    const resolved = resolveWaiverContacts({
      ...minor,
      guardianName: "  Charles Babbage  ",
      emergencyContactName: "  Grace Hopper ",
    });
    expect(resolved.guardianName).toBe("Charles Babbage");
    expect(resolved.emergencyContactName).toBe("Grace Hopper");
  });
});
