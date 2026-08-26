import { describe, expect, it } from "vitest";
import {
  hasMediaAcknowledgement,
  isDirty,
  meaningfulAcks,
  parseAcksJson,
  versionLabel,
} from "./waiver-template-editor";
import type { AcknowledgementDef } from "./validation";
import { MEDIA_ACK_ID } from "./waiver-acknowledgements";

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

describe("hasMediaAcknowledgement", () => {
  const media = ack({ id: MEDIA_ACK_ID, label: "I consent to being photographed." });

  it("is true when the media item is present with a real label", () => {
    expect(hasMediaAcknowledgement([ack(), media])).toBe(true);
  });

  // The guard trips when a manager clears the media row's label to nothing,
  // even though the id is still in the list -- this is what would otherwise
  // be silently dropped by `meaningfulAcks` on save.
  it("trips when the media item's label is cleared", () => {
    expect(hasMediaAcknowledgement([ack(), { ...media, label: "" }])).toBe(false);
    expect(hasMediaAcknowledgement([ack(), { ...media, label: "   " }])).toBe(false);
  });

  // Rewording the label or flipping required must keep working: the source
  // PR explicitly wanted the media item's wording to stay editable.
  it("stays true when only wording or required-ness changes", () => {
    expect(hasMediaAcknowledgement([{ ...media, label: "New wording." }])).toBe(true);
    expect(hasMediaAcknowledgement([{ ...media, required: false }])).toBe(true);
  });

  // A version from before the media-consent feature existed has no such item
  // at all, and loading + re-saving it unchanged must trip the guard too.
  it("trips when the media item is missing entirely (a pre-media version)", () => {
    expect(hasMediaAcknowledgement([ack()])).toBe(false);
    expect(hasMediaAcknowledgement([])).toBe(false);
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

describe("parseAcksJson", () => {
  const current = [ack({ id: "a", label: "Media consent" })];

  it("reads back a list that was stored as JSON", () => {
    const stored = [ack({ id: "b", label: "Something else" })];
    expect(parseAcksJson(JSON.stringify(stored), current)).toEqual(stored);
  });

  it("falls back to what is on screen rather than to nothing", () => {
    // Restoring into an empty list would put the editor into a state it refuses
    // to save from (the media consent row is required), with no obvious way out.
    expect(parseAcksJson("{not json", current)).toEqual(current);
    expect(parseAcksJson("", current)).toEqual(current);
    expect(parseAcksJson('{"not":"an array"}', current)).toEqual(current);
    expect(parseAcksJson("null", current)).toEqual(current);
    expect(parseAcksJson("42", current)).toEqual(current);
  });

  it("accepts a genuinely empty list, which is a real answer", () => {
    // Distinct from the fallback above: "[]" is somebody having removed every
    // row, which the save then refuses on its own terms with a message.
    expect(parseAcksJson("[]", current)).toEqual([]);
  });
});
