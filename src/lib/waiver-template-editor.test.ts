import { describe, expect, it } from "vitest";
import { isDirty, meaningfulAcks, versionLabel } from "./waiver-template-editor";
import type { AcknowledgementDef } from "./validation";

const ack = (over: Partial<AcknowledgementDef> = {}): AcknowledgementDef => ({
  id: "risk",
  label: "I accept the risks.",
  required: true,
  ...over,
});

const stored = { title: "Waiver", body_md: "# Waiver", acknowledgements: [ack()] };

describe("meaningfulAcks", () => {
  it("trims labels and drops the blank ones", () => {
    expect(
      meaningfulAcks([ack({ label: "  I accept.  " }), ack({ id: "empty", label: "   " })]),
    ).toEqual([ack({ label: "I accept." })]);
  });
});

describe("isDirty", () => {
  it("is false with nothing loaded", () => {
    expect(isDirty({ title: "x", body_md: "y", acknowledgements: [] }, null)).toBe(false);
  });

  it("is false when the editor matches what was loaded", () => {
    expect(isDirty({ ...stored }, stored)).toBe(false);
  });

  it("notices a changed title, body, label or required flag", () => {
    expect(isDirty({ ...stored, title: "Other" }, stored)).toBe(true);
    expect(isDirty({ ...stored, body_md: "# Other" }, stored)).toBe(true);
    expect(isDirty({ ...stored, acknowledgements: [ack({ label: "Changed" })] }, stored)).toBe(
      true,
    );
    expect(isDirty({ ...stored, acknowledgements: [ack({ required: false })] }, stored)).toBe(true);
  });

  it("notices an added or removed acknowledgement", () => {
    expect(isDirty({ ...stored, acknowledgements: [ack(), ack({ id: "media" })] }, stored)).toBe(
      true,
    );
    expect(isDirty({ ...stored, acknowledgements: [] }, stored)).toBe(true);
  });

  it("ignores an empty acknowledgement row that a save would discard", () => {
    // "Add acknowledgement" appends a blank row to type into. Abandoning it is
    // not an edit, and treating it as one prompts about losing work that a save
    // would have thrown away anyway.
    expect(
      isDirty({ ...stored, acknowledgements: [ack(), ack({ id: "new", label: "" })] }, stored),
    ).toBe(false);
  });

  it("ignores key order within an acknowledgement", () => {
    // A serialize-and-compare check would call this an edit.
    const reordered = { required: true, label: "I accept the risks.", id: "risk" };
    expect(isDirty({ ...stored, acknowledgements: [reordered] }, stored)).toBe(false);
  });
});

describe("versionLabel", () => {
  it("marks the live version", () => {
    expect(versionLabel({ version: 2, is_current: true }, 2)).toBe("Live");
  });

  it("calls an older version Previous, not Draft", () => {
    // It may have signatures against it. Labelling a superseded legal document
    // "Draft" on the screen where a manager picks what the club stands behind
    // makes a rollback read like publishing something unfinished.
    expect(versionLabel({ version: 1, is_current: false }, 2)).toBe("Previous");
  });

  it("calls a never-promoted newer version Draft", () => {
    expect(versionLabel({ version: 3, is_current: false }, 2)).toBe("Draft");
  });

  it("calls everything a draft when nothing is live", () => {
    expect(versionLabel({ version: 1, is_current: false }, null)).toBe("Draft");
  });
});
