// The manager's syllabus editor, as decisions rather than components: which
// boxes a selection shows, what counts as changed, and where a moved topic
// lands. Pure, so `syllabus-editor.test.ts` can pin them directly, the way
// `kb-editor.ts` does for the knowledge base editor.
import {
  beltPageTitle,
  entryProblem,
  flattenTopics,
  orderBelts,
  tidyBlock,
  topicTree,
  type SyllabusData,
  type SyllabusTopic,
} from "@/lib/syllabus";

/** Edit one belt's every topic, or one topic across every belt. */
export type EditorMode = "belt" | "topic";

/** One box on the editor: one belt's text for one topic. */
export type EditorCell = {
  /** `belt/topic`, the key the draft and the form both use. */
  key: string;
  belt: string;
  topic: string;
  /** What the box is labelled with: the topic (by belt) or the belt (by topic). */
  label: string;
  /** 3 for a sub-topic, so it can be indented under its topic. */
  depth: 2 | 3;
  /** What is saved now. Empty when the belt has nothing on the topic. */
  stored: string;
};

export const cellKey = (belt: string, topic: string) => `${belt}/${topic}`;

/**
 * The boxes for one selection, in reading order.
 *
 * By belt: every topic, each sub-topic straight after its topic, so the boxes
 * read top to bottom the way the belt page does. By topic: every belt, junior
 * first, including belts with no page yet, because writing a belt's first
 * block is how its page is made. A parent topic chosen by topic is its OWN text
 * only; its sub-topics are topics in their own right, one pick away.
 */
export function editorCells(data: SyllabusData, mode: EditorMode, selection: string): EditorCell[] {
  const stored = new Map(data.entries.map((e) => [cellKey(e.belt, e.topic), e.body_md]));
  const topics = flattenTopics(topicTree(data.topics));

  if (mode === "belt") {
    if (!data.belts.some((b) => b.slug === selection)) return [];
    return topics.map((topic) => ({
      key: cellKey(selection, topic.slug),
      belt: selection,
      topic: topic.slug,
      label: topic.title,
      depth: topic.parent ? 3 : 2,
      stored: stored.get(cellKey(selection, topic.slug)) ?? "",
    }));
  }

  const topic = topics.find((t) => t.slug === selection);
  if (!topic) return [];
  return orderBelts(data.belts).map((belt) => ({
    key: cellKey(belt.slug, topic.slug),
    belt: belt.slug,
    topic: topic.slug,
    label: beltPageTitle(belt),
    depth: 2,
    stored: stored.get(cellKey(belt.slug, topic.slug)) ?? "",
  }));
}

/**
 * The blocks a save sends: only the boxes that differ from what is saved,
 * compared as the server stores them (`tidyBlock`), since a stray trailing
 * newline is not an edit anybody made on purpose.
 */
export function changedEntries(
  cells: EditorCell[],
  values: Record<string, string>,
): { belt: string; topic: string; body_md: string }[] {
  return cells
    .filter((cell) => tidyBlock(values[cell.key] ?? cell.stored) !== tidyBlock(cell.stored))
    .map((cell) => ({ belt: cell.belt, topic: cell.topic, body_md: values[cell.key] ?? "" }));
}

/** Each changed box's problem, if it has one, so the screen can say which. */
export function cellProblems(
  cells: EditorCell[],
  values: Record<string, string>,
): Map<string, string> {
  const problems = new Map<string, string>();
  for (const cell of cells) {
    const problem = entryProblem(values[cell.key] ?? cell.stored);
    if (problem) problems.set(cell.key, problem);
  }
  return problems;
}

/**
 * Where a topic goes when moved one place up or down among its siblings.
 *
 * Positions are handed out in tens, so there is nearly always a free number
 * between the neighbour and the one beyond it, and the move is ONE save. Each
 * save of a topic republishes the belt pages it is on, so a swap (two saves)
 * would give every one of those pages two new versions for one click. Only
 * when there is no gap left does it fall back to swapping with the neighbour.
 */
export function movedPosition(
  siblings: Pick<SyllabusTopic, "slug" | "position">[],
  slug: string,
  direction: "up" | "down",
): { position: number; swapWith?: { slug: string; position: number } } | null {
  const ordered = [...siblings].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((t) => t.slug === slug);
  const neighbourIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || neighbourIndex < 0 || neighbourIndex >= ordered.length) return null;
  const neighbour = ordered[neighbourIndex];
  const beyond = ordered[direction === "up" ? neighbourIndex - 1 : neighbourIndex + 1];
  const limit =
    beyond?.position ?? (direction === "up" ? neighbour.position - 20 : neighbour.position + 20);
  const gap = Math.abs(neighbour.position - limit);
  if (gap >= 2) {
    const position = Math.round((neighbour.position + limit) / 2);
    if (position >= 0) return { position };
  }
  return {
    position: neighbour.position,
    swapWith: { slug: neighbour.slug, position: ordered[index].position },
  };
}
