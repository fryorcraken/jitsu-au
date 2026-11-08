// A small club for syllabus tests: three belts (white with no page), a few
// topics with one sub-topic, and yellow's page already written the way the
// pages were before the syllabus was structured. Synthetic, like every fixture
// in this repo.
import type { Tables } from "./memory-db";

/** A club with three belts, a few topics, and yellow's page already written. */
export function syllabusClub(): Tables {
  return {
    belts: [
      { id: "b-white", slug: "white", name: "White", grade: null, colour: "#ffffff", position: 10 },
      {
        id: "b-yellow",
        slug: "yellow",
        name: "Yellow",
        grade: "7th Kyu",
        colour: "#facc15",
        position: 20,
      },
      {
        id: "b-green",
        slug: "green",
        name: "Green",
        grade: "5th Kyu",
        colour: "#16a34a",
        position: 40,
      },
    ],
    syllabus_topics: [
      { id: "t-break", slug: "breakfalling", title: "Breakfalling", parent_id: null, position: 10 },
      { id: "t-tech", slug: "techniques", title: "Techniques", parent_id: null, position: 30 },
      { id: "t-throws", slug: "throws", title: "Throws", parent_id: "t-tech", position: 10 },
      { id: "t-uke", slug: "uke", title: "Uke", parent_id: null, position: 40 },
    ],
    syllabus_entries: [
      { belt_id: "b-yellow", topic_id: "t-break", body_md: "- Peg leg" },
      { belt_id: "b-yellow", topic_id: "t-uke", body_md: "- Open hands" },
    ],
    kb_sections: [
      { id: "s-syl", slug: "syllabus", title: "Syllabus", kind: "syllabus", position: 65 },
    ],
    kb_articles: [
      {
        id: "a-yellow",
        slug: "yellow-belt",
        visibility: "members",
        belt_id: "b-yellow",
        section_id: "s-syl",
        position: 20,
        link_path: null,
      },
    ],
    kb_article_versions: [
      {
        id: "v-yellow-1",
        article_id: "a-yellow",
        version: 1,
        title: "Yellow belt (7th Kyu)",
        // As it was written before the syllabus was structured: no blank lines.
        body_md: "## Breakfalling\n- Peg leg\n\n## Uke\n- Open hands",
        is_current: true,
      },
    ],
  };
}
