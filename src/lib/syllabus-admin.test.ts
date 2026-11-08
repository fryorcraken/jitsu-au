// The syllabus's reads and writes, driven against an in-memory database.
//
// A sequence-scripted fake (as `kb-admin.test.ts` uses) would pin the ORDER of
// the queries, and the thing worth pinning here is the outcome: what the belt
// pages say after a save, which pages got a new version and which did not, and
// what a member is allowed to see. So the tables below are real enough to read
// back: filters are evaluated, inserts land, upserts replace, and the article
// version promotion runs exactly as it does against Postgres.
import { describe, expect, it } from "vitest";
import {
  deleteBelt,
  deleteSyllabusTopic,
  loadSyllabus,
  saveBelt,
  saveSyllabusEntries,
  saveSyllabusTopic,
} from "./syllabus-admin";
import { syllabusView } from "./syllabus";
import { memoryDb, type Tables } from "./testing/memory-db";
import { syllabusClub as club } from "./testing/syllabus-club";

const live = (tables: Tables, articleId: string) =>
  tables.kb_article_versions.find((v) => v.article_id === articleId && v.is_current);

const member = { userId: "u-member", isManager: false };
const manager = { userId: "u-manager", isManager: true };

describe("saveSyllabusEntries", () => {
  it("saves a block and republishes that belt's page once", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusEntries(
      db,
      {
        entries: [
          { belt: "yellow", topic: "throws", body_md: "- O Goshi" },
          { belt: "yellow", topic: "uke", body_md: "- Open hands\n- Knees" },
        ],
        change_note: "Throws added",
      },
      "u-manager",
    );
    expect(result).toMatchObject({ saved: 2, cleared: 0 });
    expect(result.pages).toEqual([
      { belt: "yellow", page: "yellow-belt", version: 2, created: false },
    ]);
    expect(live(tables, "a-yellow")).toMatchObject({
      version: 2,
      change_note: "Throws added",
      body_md:
        "## Breakfalling\n\n- Peg leg\n\n## Techniques\n\n### Throws\n\n- O Goshi\n\n## Uke\n\n- Open hands\n- Knees",
    });
  });

  it("publishes nothing when the page would say the same thing", async () => {
    const tables = club();
    const db = memoryDb(tables);
    // Resaving yellow's own text: the stored page has no blank lines under its
    // headings and the assembled one does, which must not count as an update.
    const result = await saveSyllabusEntries(
      db,
      { entries: [{ belt: "yellow", topic: "uke", body_md: "- Open hands" }] },
      "u-manager",
    );
    expect(result.pages).toEqual([
      { belt: "yellow", page: "yellow-belt", version: null, created: false },
    ]);
    expect(tables.kb_article_versions).toHaveLength(1);
  });

  it("clears a block when sent empty text", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusEntries(
      db,
      { entries: [{ belt: "yellow", topic: "uke", body_md: "  " }] },
      "u-manager",
    );
    expect(result).toMatchObject({ saved: 0, cleared: 1 });
    expect(live(tables, "a-yellow")?.body_md).toBe("## Breakfalling\n\n- Peg leg");
  });

  it("makes a page for a belt's first block, at managers visibility, in the syllabus section", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusEntries(
      db,
      { entries: [{ belt: "green", topic: "breakfalling", body_md: "- Judo rolls" }] },
      "u-manager",
    );
    expect(result.pages).toEqual([
      { belt: "green", page: "green-belt", version: 1, created: true },
    ]);
    const page = tables.kb_articles.find((a) => a.slug === "green-belt")!;
    expect(page).toMatchObject({
      visibility: "managers",
      belt_id: "b-green",
      section_id: "s-syl",
      position: 40,
    });
    expect(live(tables, page.id as string)).toMatchObject({
      title: "Green belt (5th Kyu)",
      body_md: "## Breakfalling\n\n- Judo rolls",
    });
  });

  it("refuses the whole save, writing nothing, when a belt or topic is unknown", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await expect(
      saveSyllabusEntries(
        db,
        {
          entries: [
            { belt: "yellow", topic: "uke", body_md: "- Changed" },
            { belt: "blue", topic: "weapons", body_md: "- Knife" },
          ],
        },
        "u-manager",
      ),
    ).rejects.toThrow('Nothing was saved: there is no belt "blue", no topic "weapons"');
    expect(tables.syllabus_entries.find((e) => e.topic_id === "t-uke")?.body_md).toBe(
      "- Open hands",
    );
  });
});

describe("loadSyllabus", () => {
  it("hides a belt whose page is managers-only from a member, text and all", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await saveSyllabusEntries(
      db,
      { entries: [{ belt: "green", topic: "breakfalling", body_md: "- Judo rolls" }] },
      "u-manager",
    );

    const forMember = await loadSyllabus(db, member);
    expect(forMember.belts.map((b) => b.slug)).toEqual(["yellow"]);
    expect(forMember.entries.map((e) => e.belt)).not.toContain("green");

    const forManager = await loadSyllabus(db, manager);
    expect(forManager.belts.map((b) => b.slug)).toEqual(["yellow", "green"]);
  });

  it("refuses a signed-out reader everything", async () => {
    const data = await loadSyllabus(memoryDb(club()), { userId: null, isManager: false });
    expect(data.belts).toEqual([]);
    expect(data.entries).toEqual([]);
  });

  it("gives a manager screen every belt, including one with no page", async () => {
    const data = await loadSyllabus(memoryDb(club()));
    expect(data.belts.map((b) => [b.slug, b.page_slug])).toEqual([
      ["white", null],
      ["yellow", "yellow-belt"],
      ["green", null],
    ]);
    expect(syllabusView(data).choices.map((b) => b.slug)).toEqual(["yellow"]);
  });
});

describe("saveSyllabusTopic", () => {
  it("renames a topic and republishes the pages it is on, keeping its anchor", async () => {
    const tables = club();
    const db = memoryDb(tables);
    const result = await saveSyllabusTopic(
      db,
      { slug: "breakfalling", title: "Ukemi" },
      "u-manager",
    );
    expect(result.pages).toEqual([
      { belt: "yellow", page: "yellow-belt", version: 2, created: false },
    ]);
    expect(live(tables, "a-yellow")?.body_md).toContain("## Ukemi {#breakfalling}");
    expect(live(tables, "a-yellow")?.change_note).toBe('"Breakfalling" renamed to "Ukemi"');
  });

  it("creates a sub-topic under a topic, after its siblings", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await saveSyllabusTopic(db, { slug: "locks", title: "Locks", parent: "techniques" }, null);
    expect(tables.syllabus_topics.find((t) => t.slug === "locks")).toMatchObject({
      parent_id: "t-tech",
      position: 20,
    });
  });

  it("goes only one level deep", async () => {
    const db = memoryDb(club());
    await expect(
      saveSyllabusTopic(db, { slug: "o-goshi", title: "O Goshi", parent: "throws" }, null),
    ).rejects.toThrow(/only one level deep/);
    await expect(
      saveSyllabusTopic(db, { slug: "techniques", parent: "uke" }, null),
    ).rejects.toThrow(/has sub-topics of its own/);
  });

  it("refuses to create a topic that already exists when told it is new", async () => {
    await expect(
      saveSyllabusTopic(memoryDb(club()), { slug: "uke", title: "Uke", expect_new: true }, null),
    ).rejects.toThrow(/already a topic/);
  });
});

describe("deleteSyllabusTopic", () => {
  it("refuses while a belt still has text on it, naming the belt", async () => {
    await expect(deleteSyllabusTopic(memoryDb(club()), "uke")).rejects.toThrow(
      '"Uke" still has text for Yellow',
    );
  });

  it("refuses while it has sub-topics", async () => {
    await expect(deleteSyllabusTopic(memoryDb(club()), "techniques")).rejects.toThrow(/sub-topics/);
  });

  it("deletes an unused topic", async () => {
    const tables = club();
    await deleteSyllabusTopic(memoryDb(tables), "throws");
    expect(tables.syllabus_topics.map((t) => t.slug)).not.toContain("throws");
  });
});

describe("saveBelt", () => {
  it("retitles the page when the grade changes", async () => {
    const tables = club();
    const result = await saveBelt(memoryDb(tables), { slug: "yellow", grade: "8th Kyu" }, null);
    expect(result.pages[0]).toMatchObject({ version: 2 });
    expect(live(tables, "a-yellow")?.title).toBe("Yellow belt (8th Kyu)");
  });

  it("moves the page with the belt, without publishing a version", async () => {
    const tables = club();
    const result = await saveBelt(memoryDb(tables), { slug: "yellow", position: 25 }, null);
    expect(result.pages).toEqual([]);
    expect(tables.kb_articles[0].position).toBe(25);
    expect(tables.kb_article_versions).toHaveLength(1);
  });

  it("creates a belt at the end, and needs a name and colour to do it", async () => {
    const tables = club();
    const db = memoryDb(tables);
    await expect(saveBelt(db, { slug: "black" }, null)).rejects.toThrow(
      /needs a name and a colour/,
    );
    await saveBelt(db, { slug: "black", name: "Black", colour: "#000000" }, null);
    expect(tables.belts.find((b) => b.slug === "black")).toMatchObject({
      position: 50,
      grade: null,
    });
  });
});

describe("deleteBelt", () => {
  it("refuses a belt with a page", async () => {
    await expect(deleteBelt(memoryDb(club()), "yellow")).rejects.toThrow(/has a syllabus page/);
  });

  it("deletes a belt with nothing attached", async () => {
    const tables = club();
    await deleteBelt(memoryDb(tables), "white");
    expect(tables.belts.map((b) => b.slug)).toEqual(["yellow", "green"]);
  });
});
