// Decisions the knowledge base editor makes, kept out of the component so
// they are unit-testable — the same split `waiver-template-editor.ts` uses, for
// the same reason. No React, no toasts, no server calls.
import { visibilityReach } from "./kb";
import type { ArticleVisibility } from "./kb";
import { slugify } from "./slug";

/** What the editor holds right now, and what a stored version holds. */
export type ArticleDraft = {
  title: string;
  body_md: string;
  visibility: ArticleVisibility;
  annotations_enabled: boolean;
  /** Slug of the section it sits in, or "" for none. */
  section: string;
  /** Lower sorts first within the section. */
  position: number;
  /** Sidebar label, or "" to fall back to the title. */
  nav_title: string;
  /** Non-empty makes the entry a LINK to a page elsewhere on the site. */
  link_path: string;
};

/**
 * Whether the editor holds work a save would keep, and navigating away would
 * lose.
 *
 * With no `stored` version the editor is composing a NEW article, and anything
 * typed into it is unsaved work. Returning false there (as this used to) meant
 * the "Unsaved changes" hint never appeared while creating, and the guard on
 * "New article" — which only consults this — silently wiped a fully typed
 * article on a second click.
 *
 * `change_note` is deliberately NOT part of this: it describes a save rather
 * than being part of the article, so a note typed against an otherwise
 * unchanged body is not an edit worth warning about losing.
 */
export function isArticleDirty(draft: ArticleDraft, stored: ArticleDraft | null): boolean {
  if (!stored) {
    return Boolean(draft.title.trim() || draft.body_md.trim() || draft.link_path.trim());
  }
  return (
    draft.title !== stored.title ||
    draft.body_md !== stored.body_md ||
    draft.visibility !== stored.visibility ||
    draft.annotations_enabled !== stored.annotations_enabled ||
    // Placement counts as unsaved work for the same reason the text does: a
    // manager who has just moved an article into "Start here" and clicks
    // another one has lost that move, and nothing on the screen said so.
    draft.section !== stored.section ||
    draft.position !== stored.position ||
    draft.nav_title !== stored.nav_title ||
    draft.link_path !== stored.link_path
  );
}

/** What a manager is warned about before a save that changes who can read it. */
export type VisibilityChange = { from: ArticleVisibility; to: ArticleVisibility } | null;

/**
 * The visibility change a save would make, when it is one worth confirming.
 *
 * Only WIDENING is flagged. Narrowing (public → members, members → managers)
 * takes an article away from people who could read it, which is recoverable and
 * unsurprising. Widening publishes text to an audience that could not see it a
 * moment ago, and for an article that has been sitting at `managers` while it
 * was drafted, that is the one click nobody should make by accident.
 */
export function wideningVisibility(
  stored: ArticleVisibility | null,
  next: ArticleVisibility,
): VisibilityChange {
  if (!stored || stored === next) return null;
  return visibilityReach[next] > visibilityReach[stored] ? { from: stored, to: next } : null;
}

/** Anything the reading order can move: a section, or an entry inside one. */
export type Orderable = { slug: string; position: number };

/**
 * The step between two neighbours in the reading order.
 *
 * Ten, matching the seeded 10/20/30, so a manager (or the agent API) can still
 * slot something between two entries by hand without renumbering anything.
 */
export const POSITION_STEP = 10;

/**
 * The position a new entry should take: after everything already there.
 *
 * A new article defaulting to 0 would land it at the TOP of the section it was
 * filed into, ahead of the article the manager deliberately made first, which is
 * the one thing the reading order is for.
 */
export function nextPosition(siblings: Orderable[]): number {
  const highest = siblings.reduce((max, item) => Math.max(max, item.position), 0);
  return highest + POSITION_STEP;
}

/**
 * Move one item to a new index in its list, and report the rows whose position
 * that changes.
 *
 * The whole list is renumbered in steps of ten and only the rows that actually
 * moved are returned, which is what makes dragging reliable rather than
 * usually-right: positions default to 0, so a knowledge base nobody has ordered
 * yet has every entry tied on the same number, and a "swap these two numbers"
 * implementation would swap 0 for 0 and appear to do nothing. Renumbering breaks
 * the tie once, on the first move, and after that the swaps are the only writes.
 *
 * `items` must already be IN the order they are shown, not in some order this
 * function re-derives. Ties on `position` are broken by title in the sidebar
 * (`buildKbNav`), and a second, slightly different sort here would move whatever
 * this function thinks is above rather than what the manager can see is above.
 *
 * Dropping something back where it already was returns nothing, so a drag that
 * goes nowhere writes nothing.
 */
export function moveSection<T extends Orderable>(
  items: T[],
  slug: string,
  toIndex: number,
): Orderable[] {
  const from = items.findIndex((item) => item.slug === slug);
  if (from === -1) return [];
  const to = clamp(toIndex, items.length - 1);

  const moved = items.slice();
  moved.splice(to, 0, ...moved.splice(from, 1));

  const before = new Map(items.map((item) => [item.slug, item.position]));
  return moved
    .map((item, index) => ({ slug: item.slug, position: (index + 1) * POSITION_STEP }))
    .filter((item) => before.get(item.slug) !== item.position);
}

/** Where one entry ends up: which section, and where in it. */
export type Placement = { slug: string; section: string; position: number };

/** A section's entries, in the order they are shown. `slug` is "" for none. */
export type EntryGroup = { slug: string; entries: Orderable[] };

/**
 * Move an entry to a place in the reading order, possibly in another section,
 * and report every row that has to be written.
 *
 * Cross-section is the case worth having, and the reason this is not
 * `moveSection` with an extra argument: taking an entry OUT of a section leaves
 * a gap behind it, so both lists are renumbered, and a manager dragging the
 * middle article of "Start here" into "Belts" changes rows in two sections at
 * once. Returning only what changed keeps that to the two or three writes it
 * really is rather than the whole knowledge base.
 *
 * `toSection` is "" for the catch-all "Everything else" group, matching the ""
 * that `save_kb_article` reads as "in no section". A `toSection` that is not in
 * `groups` is treated as an empty section, which is what makes an empty section
 * (only the manager screen shows them) a place you can drop something.
 */
export function moveEntry(
  groups: EntryGroup[],
  slug: string,
  toSection: string,
  toIndex: number,
): Placement[] {
  const from = groups.find((group) => group.entries.some((entry) => entry.slug === slug));
  if (!from) return [];
  const entry = from.entries.find((e) => e.slug === slug) as Orderable;

  const before = new Map<string, { section: string; position: number }>();
  for (const group of groups) {
    for (const row of group.entries) {
      before.set(row.slug, { section: group.slug, position: row.position });
    }
  }

  const source = from.entries.filter((e) => e.slug !== slug);
  // Same section: insert into the list the entry has ALREADY been taken out of,
  // so an index the caller read off the rendered list still means the slot the
  // manager dropped onto. Re-reading it from the untouched list would put a
  // downward move one place short of where it was let go.
  const target =
    from.slug === toSection
      ? source
      : (groups.find((group) => group.slug === toSection)?.entries.slice() ?? []);

  target.splice(clamp(toIndex, target.length), 0, entry);

  const renumber = (list: Orderable[], section: string): Placement[] =>
    list.map((row, index) => ({
      slug: row.slug,
      section,
      position: (index + 1) * POSITION_STEP,
    }));

  const next =
    from.slug === toSection
      ? renumber(target, toSection)
      : [...renumber(source, from.slug), ...renumber(target, toSection)];

  return next.filter((row) => {
    const was = before.get(row.slug);
    return !was || was.section !== row.section || was.position !== row.position;
  });
}

/** An index that lands inside the list, wherever a drop reported it. */
function clamp(index: number, max: number): number {
  return Math.max(0, Math.min(index, max));
}

/** What the section editor holds, and what the stored section holds. */
export type SectionDraft = { title: string };

/**
 * Whether the section editor holds work a save would keep.
 *
 * Field by field rather than a stringify, for the same reason `isArticleDirty`
 * is: it is one field today, and a comparison that quietly starts covering
 * whatever else gets added is a comparison nobody chose.
 */
export function isSectionDirty(draft: SectionDraft, stored: SectionDraft | null): boolean {
  if (!stored) return Boolean(draft.title.trim());
  return draft.title !== stored.title;
}

/**
 * A slug proposed from a title, so a manager creating an article does not have
 * to invent one. Satisfies the `kb_articles.slug` CHECK: lowercase, digits,
 * single hyphens, no leading or trailing hyphen, at most 100 characters.
 *
 * Built on the repo's existing `slugify` rather than a second implementation.
 * That matters beyond tidiness: `slugify` normalises accents, so "Café
 * etiquette" becomes `cafe-etiquette` instead of the `caf-etiquette` a
 * hand-rolled ASCII filter produces.
 *
 * Returns "" when the title has nothing usable in it (all punctuation, or a
 * script this cannot transliterate), which the form treats as "you type it":
 * better than proposing a slug the database would reject.
 */
export function slugFromTitle(title: string): string {
  // Trim AFTER the length cap: slicing can land mid-word and leave a trailing
  // hyphen, which the CHECK rejects outright.
  return slugify(title).slice(0, 100).replace(/-+$/g, "");
}
