import { describe, expect, it } from "vitest";
import {
  cellProblems,
  changedEntries,
  editorCells,
  moveTopic,
  positionChanges,
  withPositions,
} from "./syllabus-editor";
import { topicTree, type SyllabusData } from "./syllabus";

const DATA: SyllabusData = {
  belts: [
    {
      slug: "green",
      name: "Green",
      grade: "5th Kyu",
      colour: "#000000",
      position: 40,
      page_slug: null,
      visibility: null,
    },
    {
      slug: "yellow",
      name: "Yellow",
      grade: "7th Kyu",
      colour: "#000000",
      position: 20,
      page_slug: "yellow-belt",
      visibility: "members",
    },
  ],
  topics: [
    { slug: "uke", title: "Uke", parent: null, position: 40 },
    { slug: "throws", title: "Throws", parent: "techniques", position: 10 },
    { slug: "techniques", title: "Techniques", parent: null, position: 30 },
  ],
  entries: [{ belt: "yellow", topic: "throws", body_md: "- O Goshi" }],
};

describe("editorCells", () => {
  it("shows every topic for a belt, each sub-topic after its topic", () => {
    const cells = editorCells(DATA, "belt", "yellow");
    expect(cells.map((c) => [c.topic, c.depth, c.stored])).toEqual([
      ["techniques", 2, ""],
      ["throws", 3, "- O Goshi"],
      ["uke", 2, ""],
    ]);
  });

  it("shows every belt with a page for a topic, junior first", () => {
    const cells = editorCells(DATA, "topic", "throws");
    expect(cells.map((c) => [c.belt, c.label])).toEqual([["yellow", "Yellow belt (7th Kyu)"]]);
  });

  // Writing a belt's first block makes its page, which should be a choice made
  // by picking that belt, not a side effect of filling a topic's column.
  it("leaves a belt with no page out of a topic's boxes, but not out of its own", () => {
    expect(editorCells(DATA, "topic", "throws").map((c) => c.belt)).not.toContain("green");
    expect(editorCells(DATA, "belt", "green")).toHaveLength(3);
  });

  it("shows nothing for a selection that does not exist", () => {
    expect(editorCells(DATA, "belt", "blue")).toEqual([]);
    expect(editorCells(DATA, "topic", "weapons")).toEqual([]);
  });
});

describe("changedEntries", () => {
  const cells = editorCells(DATA, "belt", "yellow");

  it("sends only what changed, including a cleared block", () => {
    expect(
      changedEntries(cells, {
        "yellow/throws": "",
        "yellow/uke": "- Attack",
        "yellow/techniques": "",
      }),
    ).toEqual([
      { belt: "yellow", topic: "throws", body_md: "" },
      { belt: "yellow", topic: "uke", body_md: "- Attack" },
    ]);
  });

  it("does not count trailing whitespace as an edit", () => {
    expect(changedEntries(cells, { "yellow/throws": "- O Goshi\n" })).toEqual([]);
  });
});

describe("cellProblems", () => {
  it("names the box with a heading in it", () => {
    const cells = editorCells(DATA, "belt", "yellow");
    const problems = cellProblems(cells, { "yellow/uke": "## Oops" });
    expect([...problems.keys()]).toEqual(["yellow/uke"]);
  });
});

describe("moveTopic and positionChanges", () => {
  const stored = [
    { slug: "a", title: "A", parent: null, position: 10 },
    { slug: "b", title: "B", parent: null, position: 20 },
    { slug: "c", title: "C", parent: null, position: 30 },
    { slug: "x", title: "X", parent: "b", position: 10 },
    { slug: "y", title: "Y", parent: "b", position: 20 },
  ];
  const tree = topicTree(stored);
  const slugs = (t: ReturnType<typeof topicTree> | null) => t?.map((n) => n.slug);

  it("moves a topic one place among its siblings", () => {
    expect(slugs(moveTopic(tree, "c", "up"))).toEqual(["a", "c", "b"]);
    expect(slugs(moveTopic(tree, "a", "down"))).toEqual(["b", "a", "c"]);
  });

  it("moves a sub-topic within its own topic", () => {
    const moved = moveTopic(tree, "y", "up")!;
    expect(moved[1].children.map((c) => c.slug)).toEqual(["y", "x"]);
  });

  it("does nothing at either end", () => {
    expect(moveTopic(tree, "a", "up")).toBeNull();
    expect(moveTopic(tree, "y", "down")).toBeNull();
  });

  // Three presses, one save: what is sent is the end state, not the steps.
  it("saves only the positions a burst of moves changed, renumbered in tens", () => {
    const moved = moveTopic(moveTopic(tree, "c", "up")!, "c", "up")!;
    expect(positionChanges(stored, moved)).toEqual([
      { slug: "c", position: 10 },
      { slug: "a", position: 20 },
      { slug: "b", position: 30 },
    ]);
    expect(positionChanges(stored, tree)).toEqual([]);
  });

  // A move saved, then undone before the reload came back: compared with the
  // positions from before the save, the undo would look like no change.
  it("sees an undo of a save still being reloaded", () => {
    const up = moveTopic(tree, "c", "up")!;
    const saved = positionChanges(stored, up);
    expect(positionChanges(stored, tree)).toEqual([]);
    expect(positionChanges(withPositions(stored, saved), tree)).toEqual([
      { slug: "b", position: 20 },
      { slug: "c", position: 30 },
    ]);
  });

  it("renumbers a group whose numbers had drifted", () => {
    const drifted = [
      { slug: "a", title: "A", parent: null, position: 10 },
      { slug: "b", title: "B", parent: null, position: 65 },
    ];
    expect(positionChanges(drifted, topicTree(drifted))).toEqual([{ slug: "b", position: 20 }]);
  });
});
