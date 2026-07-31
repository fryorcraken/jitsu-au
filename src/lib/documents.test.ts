import { describe, it, expect } from "vitest";
import {
  blockId,
  canAnnotate,
  canEditAnnotation,
  canReadDocument,
  canResolveThread,
  groupThreads,
  normalizeBlockText,
  resolveAnchors,
  splitBlocks,
} from "./documents";
import type { Viewer } from "./documents";

const anon: Viewer = { userId: null, isManager: false };
const member: Viewer = { userId: "u-member", isManager: false };
const manager: Viewer = { userId: "u-manager", isManager: true };

describe("normalizeBlockText", () => {
  it("collapses the line breaks inside a wrapped paragraph", () => {
    expect(normalizeBlockText("one\ntwo   three\n")).toBe("one two three");
  });

  it("keeps case, because case is meaning in prose", () => {
    expect(normalizeBlockText("No Gi")).not.toBe(normalizeBlockText("no gi"));
  });
});

describe("splitBlocks", () => {
  it("splits on blank lines and numbers blocks in reading order", () => {
    const blocks = splitBlocks("# Rules\n\nWash your gi.\n\nClip your nails.");
    expect(blocks.map((b) => b.markdown)).toEqual(["# Rules", "Wash your gi.", "Clip your nails."]);
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  it("keeps a blank line inside a fenced code block as part of the code", () => {
    const blocks = splitBlocks("Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro");
    expect(blocks).toHaveLength(3);
    expect(blocks[1].markdown).toContain("const a = 1;");
    expect(blocks[1].markdown).toContain("const b = 2;");
  });

  it("does not close a tilde fence on a backtick fence", () => {
    const blocks = splitBlocks("~~~\ncode\n\n```\nstill code\n~~~\n\nAfter");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].markdown).toContain("still code");
    expect(blocks[1].markdown).toBe("After");
  });

  it("ignores trailing and repeated blank lines rather than minting empty blocks", () => {
    expect(splitBlocks("\n\nOne\n\n\n\nTwo\n\n\n")).toHaveLength(2);
  });

  // The reason ids are content-derived rather than positional. This is the whole
  // point of the anchoring design: inserting a paragraph must not move every
  // annotation below it onto the wrong passage.
  it("keeps every other block's id unchanged when a paragraph is inserted above", () => {
    const before = splitBlocks("Alpha\n\nBravo\n\nCharlie");
    const after = splitBlocks("New intro\n\nAlpha\n\nBravo\n\nCharlie");
    expect(after.map((b) => b.id).slice(1)).toEqual(before.map((b) => b.id));
  });

  it("gives repeated identical blocks distinct ids", () => {
    const blocks = splitBlocks("N/A\n\nSomething\n\nN/A");
    expect(blocks[0].id).not.toBe(blocks[2].id);
    expect(blocks[2].id).toBe(blockId("N/A", 1));
  });

  it("gives the same id to a paragraph that was only re-wrapped", () => {
    const wrapped = splitBlocks("The mat is\nswept before class.");
    const oneLine = splitBlocks("The mat is swept before class.");
    expect(wrapped[0].id).toBe(oneLine[0].id);
  });
});

describe("resolveAnchors", () => {
  const blocks = splitBlocks("# Rules\n\nWash your gi.\n\nClip your nails.");

  it("anchors an annotation by exact block id", () => {
    const a = { block_id: blocks[1].id, quote: "Wash your gi." };
    const res = resolveAnchors(blocks, [a]);
    expect(res.anchored.get(blocks[1].id)).toEqual([a]);
    expect(res.orphaned).toEqual([]);
  });

  it("files a null block_id as a document-level note", () => {
    const a = { block_id: null, quote: null };
    expect(resolveAnchors(blocks, [a]).document).toEqual([a]);
  });

  it("orphans an annotation whose passage was rewritten", () => {
    const a = { block_id: blockId("Wear a mouthguard."), quote: "Wear a mouthguard." };
    const res = resolveAnchors(blocks, [a]);
    expect(res.orphaned).toEqual([a]);
    expect(res.anchored.size).toBe(0);
  });

  // The case the quote fallback exists for: removing one of two identical blocks
  // renumbers the ordinal of the survivor, so its id moves while its text does not.
  it("re-anchors by quote when a repeated block's ordinal shifted", () => {
    const a = { block_id: blockId("N/A", 1), quote: "N/A" };
    const res = resolveAnchors(splitBlocks("N/A\n\nOther"), [a]);
    expect(res.orphaned).toEqual([]);
    expect(res.anchored.get(blockId("N/A", 0))).toEqual([a]);
  });

  it("never re-anchors by position when the quote does not match either", () => {
    const a = { block_id: "deadbeefdeadbeef", quote: "Text that is gone." };
    expect(resolveAnchors(blocks, [a]).orphaned).toEqual([a]);
  });

  it("keeps several annotations on one block in the order given", () => {
    const first = { block_id: blocks[1].id, quote: null };
    const second = { block_id: blocks[1].id, quote: null };
    expect(resolveAnchors(blocks, [first, second]).anchored.get(blocks[1].id)).toEqual([
      first,
      second,
    ]);
  });
});

describe("groupThreads", () => {
  it("nests replies under their root, oldest first", () => {
    const root = { id: "r", parent_id: null, created_at: "2026-01-01T00:00:00Z" };
    const later = { id: "b", parent_id: "r", created_at: "2026-01-03T00:00:00Z" };
    const earlier = { id: "a", parent_id: "r", created_at: "2026-01-02T00:00:00Z" };
    const threads = groupThreads([root, later, earlier]);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("promotes a reply whose parent is not in the list rather than dropping it", () => {
    const orphanReply = { id: "a", parent_id: "missing", created_at: null };
    expect(groupThreads([orphanReply])).toEqual([{ root: orphanReply, replies: [] }]);
  });
});

describe("canReadDocument", () => {
  it("lets anyone read a public document", () => {
    expect(canReadDocument("public", anon)).toBe(true);
  });

  it("requires a login for a members document", () => {
    expect(canReadDocument("members", anon)).toBe(false);
    expect(canReadDocument("members", member)).toBe(true);
  });

  it("hides a managers-only document from members", () => {
    expect(canReadDocument("managers", member)).toBe(false);
    expect(canReadDocument("managers", manager)).toBe(true);
  });
});

describe("canAnnotate", () => {
  it("refuses a signed-out reader even on a public document", () => {
    expect(canAnnotate({ visibility: "public", annotations_enabled: true }, anon)).toBe(false);
  });

  it("refuses when the document has annotations turned off, managers included", () => {
    const doc = { visibility: "public", annotations_enabled: false } as const;
    expect(canAnnotate(doc, member)).toBe(false);
    expect(canAnnotate(doc, manager)).toBe(false);
  });

  it("allows a signed-in member on a members document", () => {
    expect(canAnnotate({ visibility: "members", annotations_enabled: true }, member)).toBe(true);
  });
});

describe("canEditAnnotation", () => {
  it("allows the author", () => {
    expect(canEditAnnotation({ user_id: "u-member" }, member)).toBe(true);
  });

  // Moderation is resolving and deleting the document, never rewriting somebody
  // else's words.
  it("refuses a manager editing somebody else's annotation", () => {
    expect(canEditAnnotation({ user_id: "u-member" }, manager)).toBe(false);
  });

  it("refuses a signed-out viewer", () => {
    expect(canEditAnnotation({ user_id: "u-member" }, anon)).toBe(false);
  });
});

describe("canResolveThread", () => {
  it("lets a manager resolve somebody else's shared thread", () => {
    expect(canResolveThread({ user_id: "u-member", visibility: "shared" }, manager)).toBe(true);
  });

  it("lets the author resolve their own shared thread", () => {
    expect(canResolveThread({ user_id: "u-member", visibility: "shared" }, member)).toBe(true);
  });

  // A private note is not a conversation, so there is nothing to resolve.
  it("refuses to resolve a private note, even for a manager", () => {
    expect(canResolveThread({ user_id: "u-member", visibility: "private" }, manager)).toBe(false);
  });
});
