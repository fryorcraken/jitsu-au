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
  type SyllabusTopicNode,
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
 * read top to bottom the way the belt page does. By topic: every belt that has
 * a page, junior first. A belt with no page is left out there on purpose:
 * writing its first block MAKES its page, and that should be a decision taken
 * by picking the belt, not a side effect of filling a column of boxes (white,
 * which has no syllabus, would otherwise get a page from one stray line). A
 * parent topic chosen by topic is its OWN text only; its sub-topics are topics
 * in their own right, one pick away.
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
  return orderBelts(data.belts.filter((belt) => belt.page_slug !== null)).map((belt) => ({
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
 * The topic tree with one topic moved one place up or down among its siblings,
 * or null when it is already at that end. A sub-topic moves within its own
 * topic; filing it under another topic is a separate edit.
 *
 * Applied on screen straight away, before anything is saved, so a manager
 * pressing the arrow three times sees it move three places at once rather than
 * waiting a round of republishing per press (`positionChanges` is what is then
 * saved, once, for the whole burst).
 */
export function moveTopic(
  tree: SyllabusTopicNode[],
  slug: string,
  direction: "up" | "down",
): SyllabusTopicNode[] | null {
  const swap = <T extends { slug: string }>(list: T[]): T[] | null => {
    const i = list.findIndex((t) => t.slug === slug);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return null;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  const roots = swap(tree);
  if (roots) return roots;
  for (const [index, root] of tree.entries()) {
    const children = swap(root.children);
    if (children) {
      const next = [...tree];
      next[index] = { ...root, children };
      return next;
    }
  }
  return null;
}

/**
 * The positions that make the stored topics read in `tree`'s order: each
 * sibling group renumbered 10, 20, 30, and only the topics whose number
 * actually changes. Renumbering in tens keeps a gap for the next one added.
 */
export function positionChanges(
  stored: SyllabusTopic[],
  tree: SyllabusTopicNode[],
): { slug: string; position: number }[] {
  const current = new Map(stored.map((t) => [t.slug, t.position]));
  const wanted: { slug: string; position: number }[] = [];
  const number = (list: { slug: string }[]) =>
    list.forEach((t, i) => wanted.push({ slug: t.slug, position: (i + 1) * 10 }));
  number(tree);
  tree.forEach((root) => number(root.children));
  return wanted.filter((t) => current.get(t.slug) !== t.position);
}
