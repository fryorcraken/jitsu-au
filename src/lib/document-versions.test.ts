import { describe, expect, it } from "vitest";
import { DocumentVersionError, versionLabel } from "./document-versions";

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

describe("versionLabel, when the document records whether a version was live", () => {
  it("calls a version rolled away from Previous even though it is newer", () => {
    expect(versionLabel({ version: 5, is_current: false }, 4, true)).toBe("Previous");
  });

  it("calls an older version that never went live a Draft", () => {
    expect(versionLabel({ version: 3, is_current: false }, 4, false)).toBe("Draft");
  });

  it("still says Live for the live one", () => {
    expect(versionLabel({ version: 4, is_current: true }, 4, true)).toBe("Live");
  });
});

describe("DocumentVersionError", () => {
  it("carries the reason and, when one was written, the version that is not live", () => {
    const e = new DocumentVersionError("not live", "not_published", 4);
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe("not_published");
    expect(e.version).toBe(4);
    expect(new DocumentVersionError("bad", "invalid").version).toBeUndefined();
  });
});
