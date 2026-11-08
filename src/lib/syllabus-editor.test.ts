import { describe, expect, it } from "vitest";
import { cellProblems, changedEntries, editorCells, movedPosition } from "./syllabus-editor";
import type { SyllabusData } from "./syllabus";

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

  it("shows every belt for a topic, junior first, including one with no page yet", () => {
    const cells = editorCells(DATA, "topic", "throws");
    expect(cells.map((c) => [c.belt, c.label])).toEqual([
      ["yellow", "Yellow belt (7th Kyu)"],
      ["green", "Green belt (5th Kyu)"],
    ]);
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

describe("movedPosition", () => {
  const siblings = [
    { slug: "a", position: 10 },
    { slug: "b", position: 20 },
    { slug: "c", position: 30 },
  ];

  it("lands between the neighbour and the one beyond, in one save", () => {
    expect(movedPosition(siblings, "c", "up")).toEqual({ position: 15 });
    expect(movedPosition(siblings, "a", "down")).toEqual({ position: 25 });
  });

  it("goes before the first or after the last", () => {
    expect(movedPosition(siblings, "b", "up")).toEqual({ position: 0 });
    expect(movedPosition(siblings, "b", "down")).toEqual({ position: 40 });
  });

  it("swaps when there is no gap left", () => {
    const tight = [
      { slug: "a", position: 10 },
      { slug: "b", position: 11 },
      { slug: "c", position: 12 },
    ];
    expect(movedPosition(tight, "c", "up")).toEqual({
      position: 11,
      swapWith: { slug: "b", position: 12 },
    });
  });

  it("does nothing at either end", () => {
    expect(movedPosition(siblings, "a", "up")).toBeNull();
    expect(movedPosition(siblings, "c", "down")).toBeNull();
  });
});
