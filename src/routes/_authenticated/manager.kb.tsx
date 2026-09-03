// Manager screen for club articles: pick one, edit it, publish it, and read
// the feedback members left on it.
//
// Deliberately the same shape as `/manager/waiver-template` — versions listed
// down the side, "Save as new version" writing a new one, a preview underneath —
// so a manager learns one editor and not two. The differences are the ones the
// feature actually has: several articles rather than one, a visibility setting,
// and a feedback panel.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { ExternalLink, GripVertical, Link2, Plus, Trash2 } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownEditor } from "@/components/site/MarkdownEditor";
import { CopyButton } from "@/components/site/CopyButton";
import { UserLink } from "@/components/site/UserLink";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteManagerSection,
  getManagerArticle,
  listArticleVersions,
  listManagerAnnotations,
  listManagerArticles,
  listManagerSections,
  saveManagerArticle,
  saveManagerSection,
  setCurrentArticleVersion,
} from "@/lib/kb.functions";
import { kbMarkdownComponents, kbRemarkPlugins } from "@/lib/kb-markdown";
import { useEditorDraft } from "@/hooks/use-editor-draft";
import { DraftRestoreBanner } from "@/components/site/DraftRestoreBanner";
import { SaveFailure } from "@/components/site/SaveFailure";
import { useInvalidateKbReader } from "@/hooks/useKbArticle";
import { articleVisibilities, visibilityAudience } from "@/lib/kb";
import { discardUnsavedChanges, useConfirm } from "@/hooks/use-confirm";
import type { ArticleVisibility } from "@/lib/kb";
import { buildKbNav, extractHeadings, UNSECTIONED_TITLE } from "@/lib/kb-nav";
import type { KbNavEntry } from "@/lib/kb-nav";
import {
  isArticleDirty,
  isSectionDirty,
  moveEntry,
  moveSection,
  nextPosition,
  slugFromTitle,
  wideningVisibility,
} from "@/lib/kb-editor";
import type { Placement } from "@/lib/kb-editor";
import { versionLabel } from "@/lib/waiver-template-editor";
import { formatDate } from "@/lib/dates";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/manager/kb")({
  head: () => ({
    meta: [{ title: "Knowledge base editor | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: KnowledgeBaseManager,
});

type ArticleSummary = Awaited<ReturnType<typeof listManagerArticles>>[number];
type SectionRow = Awaited<ReturnType<typeof listManagerSections>>[number];
type VersionRow = Awaited<ReturnType<typeof listArticleVersions>>[number];
type Feedback = Awaited<ReturnType<typeof listManagerAnnotations>>[number];

/**
 * Which of the two rows the editor is holding.
 *
 * A LINK ENTRY is a sidebar item pointing at a page elsewhere on the site
 * (`/first-class`, `/faq`). It has no text, no versions and no comments, so it
 * is not a mode of the article form so much as a different, much smaller form
 * that happens to live in the same reading order.
 */
type EntryKind = "article" | "link";

/** The label used for an entry in the structure panel. */
function entryLabel(article: ArticleSummary): string {
  return article.nav_title ?? article.title ?? article.slug;
}

// No em dashes: AGENTS.md bans them in user-facing copy, and that covers the
// manager pages, not just the public site.
const VISIBILITY_LABEL: Record<ArticleVisibility, string> = {
  members: "Members (anyone signed in)",
  managers: "Managers only (drafts and internal notes)",
};

/** Mirrors the `articles.slug` CHECK, so a bad key is caught before the server. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A section as the reading order panel holds it. `slug` is "" for the catch-all
 * "Everything else" group, matching the "" that `save_kb_article` reads as "in
 * no section" — so a drop target and a wire value are never two different
 * things.
 */
type NavGroup = { slug: string; title: string; entries: KbNavEntry[] };

/** Drag ids, namespaced so a section and an article can share a slug. */
const entryId = (slug: string) => `entry:${slug}`;
const sectionId = (slug: string) => `section:${slug}`;
const containerId = (slug: string) => `container:${slug}`;

/** One entry, wherever in the list it currently is. Empty if it is not there. */
function entriesNamed(groups: NavGroup[], slug: string): KbNavEntry[] {
  const found = groups.flatMap((group) => group.entries).find((entry) => entry.slug === slug);
  return found ? [found] : [];
}

/** The group a drag id belongs to, or null if the id is not in the list. */
function containerOf(groups: NavGroup[], id: string): string | null {
  if (id.startsWith("container:")) return id.slice("container:".length);
  // A section HEADING resolves to its own section, so an entry let go over the
  // heading lands in the section under it rather than nowhere.
  if (id.startsWith("section:")) return id.slice("section:".length);
  if (!id.startsWith("entry:")) return null;
  const slug = id.slice("entry:".length);
  return groups.find((g) => g.entries.some((e) => e.slug === slug))?.slug ?? null;
}

/**
 * One entry's draft, flattened. `position` is a number on screen and a string
 * here for the same reason every other field is a string or a boolean: the
 * stored shape has to be readable by a later build without a migration.
 */
type KbDraftFields = {
  title: string;
  body: string;
  visibility: string;
  annotationsEnabled: boolean;
  section: string;
  position: string;
  navTitle: string;
  linkPath: string;
  changeNote: string;
};

const KB_DRAFT_SHAPE: KbDraftFields = {
  title: "",
  body: "",
  visibility: "members",
  annotationsEnabled: true,
  section: "",
  position: "0",
  navTitle: "",
  linkPath: "",
  changeNote: "",
};

function KnowledgeBaseManager() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  const fetchArticles = useServerFn(listManagerArticles);
  const fetchSections = useServerFn(listManagerSections);
  const fetchDocument = useServerFn(getManagerArticle);
  const fetchVersions = useServerFn(listArticleVersions);
  const fetchFeedback = useServerFn(listManagerAnnotations);
  const save = useServerFn(saveManagerArticle);
  const saveSection = useServerFn(saveManagerSection);
  const removeSection = useServerFn(deleteManagerSection);
  const promote = useServerFn(setCurrentArticleVersion);

  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);

  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<EntryKind>("article");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<ArticleVisibility>("members");
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true);
  const [changeNote, setChangeNote] = useState("");
  /** Where it sits in the reading order: section slug ("" = none) and position. */
  const [section, setSection] = useState("");
  const [position, setPosition] = useState(0);
  const [navTitle, setNavTitle] = useState("");
  const [linkPath, setLinkPath] = useState("");
  const [newSectionTitle, setNewSectionTitle] = useState("");
  /**
   * The section open in the main window, as it is STORED, or null when the main
   * window is showing an article or a link entry.
   *
   * A section is edited in the same place an article is, rather than through a
   * pencil in the list, so the reading order does one job: getting around, and
   * arranging. `sectionTitle` is the draft against this baseline.
   */
  const [sectionEdit, setSectionEdit] = useState<{ slug: string; title: string } | null>(null);
  const [sectionTitle, setSectionTitle] = useState("");
  /** The version as stored, to compare the editor against. */
  const [stored, setStored] = useState<{
    title: string;
    body_md: string;
    visibility: ArticleVisibility;
    annotations_enabled: boolean;
    section: string;
    position: number;
    nav_title: string;
    link_path: string;
  } | null>(null);

  /**
   * An older version being read, shown in the preview panel instead of the
   * editor's text.
   *
   * Kept OUT of the editor on purpose. Loading an old version into the textarea
   * would make "Save as new version" the obvious next click, and that quietly
   * publishes a copy of it under a new number, which is not the same thing as
   * restoring it. Reading it here and restoring it from the version list keeps
   * the two apart.
   */
  const [preview, setPreview] = useState<{
    version: number;
    title: string;
    body_md: string;
  } | null>(null);

  /**
   * The visibility this article is stored with, which is NOT the same thing as
   * `stored?.visibility`.
   *
   * `stored` is the loaded VERSION, and it is null whenever that load failed.
   * Visibility lives on the article, so it is still known then (the sidebar
   * list carries it), and it has to be: `wideningVisibility` consults this, and
   * a null baseline silently skips the prompt. Reading them off the same object
   * meant an article whose version failed to load kept the PREVIOUS article's
   * visibility in the select, and the next save published a managers-only draft
   * to members with nothing asked and nothing shown.
   */
  const [baseVisibility, setBaseVisibility] = useState<ArticleVisibility | null>(null);

  /**
   * What could not be loaded for the article on screen. Panels say so instead
   * of rendering an empty list, which reads as "there is nothing here" — a
   * confident wrong answer on the panel a manager uses to decide whether members'
   * feedback has been dealt with.
   */
  // The article and section lists themselves, as opposed to `failed` below,
  // which is about one opened article's version and comment panels.
  const [listError, setListError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ article: boolean; versions: boolean; feedback: boolean }>({
    article: false,
    versions: false,
    feedback: false,
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The last failed save, kept on screen rather than left to a toast.
   *
   * `SaveFailure`, for the reason written at the top of that component: a toast
   * fades in four seconds and leaves an editor that looks exactly like one that
   * saved. A manager who glanced away walks off believing a correction is live.
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * The fields "New article" / "New link" just seeded, so a draft of an entry
   * that does not exist yet has something to be measured against.
   *
   * `stored` is the baseline for an entry that HAS been saved, and it is null
   * while creating one — which is exactly the case that loses the most work, so
   * it cannot simply be left unprotected. Measuring against a bare empty shape
   * instead would not do: `startNew` presets a section and a position, so a
   * form nobody has typed into yet would read as unsaved work.
   */
  const [newBaseline, setNewBaseline] = useState<KbDraftFields | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  // Called after every write here. The reader side caches articles and the
  // sidebar for minutes at a time, and this screen is the only thing that
  // changes what they hold.
  const invalidateKbReader = useInvalidateKbReader();

  /**
   * The arrangement a drag is producing, held while it is in flight and until
   * the refreshed lists come back.
   *
   * Kept apart from `busy` on purpose. `busy` disables every entry in the list,
   * which is right for a load the manager is waiting on and wrong for a drop:
   * it would make the second drag of two dead on arrival, and the list snap
   * back under the cursor between them.
   */
  const [dragGroups, setDragGroups] = useState<NavGroup[] | null>(null);
  const [dragging, setDragging] = useState<{ id: string; label: string } | null>(null);
  /**
   * A drop's writes are in flight, so nothing can be picked up.
   *
   * Short-lived, and it has to exist: a second drag started mid-commit would
   * take its "before" from a list the first drop has not been saved into yet,
   * and the two would compute positions against different pictures of the same
   * section.
   */
  const [ordering, setOrdering] = useState(false);

  /**
   * Which request is allowed to write to state.
   *
   * Every load, save and publish takes a token before it starts and drops its
   * results if a newer one has started since. Without this, a slow save landing
   * after a fast article open writes the SAVED article's title, body and
   * baseline over the one now on screen: `slug` says one article, the editor
   * shows another, and the next save publishes the wrong text. The requests are
   * several sequential round trips server-side, so the overtaking is ordinary,
   * not a stress case.
   */
  const seq = useRef(0);
  /**
   * Take the token, and with it the screen.
   *
   * Clearing `busy` HERE is what makes the contract safe rather than merely
   * documented. An overtaken load deliberately does not clear it on the way out
   * (`if (!stale(token)) setBusy(false)`), because it cannot know whether the
   * request that displaced it wants a spinner of its own — so the duty falls on
   * the new claimer, and a claimer that forgets leaves every button on the
   * screen disabled until the page is reloaded. Doing it in `claim` itself
   * means no caller can forget: the two that do want the list frozen set it
   * again on the next line.
   */
  const claim = () => {
    setBusy(false);
    return ++seq.current;
  };
  const stale = (token: number) => seq.current !== token;

  const draft = {
    title,
    body_md: body,
    visibility,
    annotations_enabled: annotationsEnabled,
    section,
    position,
    nav_title: navTitle,
    link_path: linkPath,
  };
  const dirty = isArticleDirty(draft, stored);

  /**
   * The on-device safety net for whichever entry is open.
   *
   * An article is Markdown a manager can sit with for a long time, and until now
   * it lived only in React state — so the installed app being reclaimed in the
   * background took the lot, exactly as it did for a blog post. Flattened to
   * strings and booleans because a draft has to survive being read back by a
   * later build of the site (see `src/lib/editor-draft.ts`).
   *
   * Scoped by slug, so two entries never overwrite each other's draft, and held
   * back until `stored` has loaded: comparing against a baseline that has not
   * arrived would offer back a draft identical to the saved version.
   */
  const kbDraftFields = useMemo<KbDraftFields>(
    () => ({
      title,
      body,
      visibility,
      annotationsEnabled,
      section,
      position: String(position),
      navTitle,
      linkPath,
      changeNote,
    }),
    [
      title,
      body,
      visibility,
      annotationsEnabled,
      section,
      position,
      navTitle,
      linkPath,
      changeNote,
    ],
  );
  const kbDraftBaseline = useMemo<KbDraftFields>(
    () =>
      !stored
        ? (newBaseline ?? KB_DRAFT_SHAPE)
        : {
            title: stored.title,
            body: stored.body_md,
            visibility: stored.visibility,
            annotationsEnabled: stored.annotations_enabled,
            section: stored.section,
            position: String(stored.position),
            navTitle: stored.nav_title,
            linkPath: stored.link_path,
            // Never part of the saved version — it describes the save that is
            // about to happen — so its baseline is always empty and a note
            // somebody typed counts as unsaved work on its own.
            changeNote: "",
          },
    [stored, newBaseline],
  );
  const kbDraft = useEditorDraft<KbDraftFields>({
    kind: "kb-entry",
    // A new entry has no slug yet, so it gets its own slot. Once it is saved
    // the screen moves onto the real slug and this one is cleared.
    scope: creating ? "new" : slug,
    owner: user?.id ?? null,
    value: kbDraftFields,
    baseline: kbDraftBaseline,
    shape: KB_DRAFT_SHAPE,
    // Held back until there is a baseline to measure against: an offer weighed
    // against nothing is an offer to restore a draft identical to what is
    // already on screen.
    enabled: creating ? newBaseline !== null : Boolean(slug) && stored !== null,
  });

  // Editing anything clears the last failure: the panel is about the save that
  // was attempted, and leaving it up over changed text claims something about
  // work it never saw.
  useEffect(() => {
    setSaveError(null);
  }, [title, body, visibility, annotationsEnabled, section, navTitle, linkPath]);

  function restoreKbDraft() {
    const d = kbDraft.offered;
    if (!d) return;
    setTitle(d.title);
    setBody(d.body);
    setVisibility(d.visibility === "managers" ? "managers" : "members");
    setAnnotationsEnabled(d.annotationsEnabled);
    setSection(d.section);
    setPosition(Number.isFinite(Number(d.position)) ? Number(d.position) : 0);
    setNavTitle(d.navTitle);
    setLinkPath(d.linkPath);
    setChangeNote(d.changeNote);
    kbDraft.restore();
  }
  /**
   * The work the VISIBLE editor would lose, which is what every "discard your
   * unsaved changes?" prompt is really asking about.
   *
   * There are two editors sharing the main window now, so consulting the
   * article's `dirty` alone would let a half-renamed section be thrown away
   * without a word, and would warn about an article the manager cannot see.
   */
  const unsaved = sectionEdit ? isSectionDirty({ title: sectionTitle }, sectionEdit) : dirty;
  const liveVersion = versions.find((v) => v.is_current)?.version ?? null;

  /**
   * The sections this article offers other articles a link to.
   *
   * Read off the text in the editor rather than the saved version, so a heading
   * just typed can be linked to straight away and a manager can see what
   * renaming one did to its link before publishing it.
   */
  const sectionAnchors = useMemo(() => extractHeadings(body), [body]);

  /**
   * The knowledge base as a member will read it, built from the manager's own
   * lists.
   *
   * `buildKbNav` rather than a second grouping written here: the panel a manager
   * reorders in has to be the order members walk, and two implementations of
   * "which section does this land in, and in what order" is exactly how the
   * arrows start moving something other than what they point at. Drafts are
   * included, because this is the screen that writes them.
   */
  const structure: NavGroup[] = useMemo(() => {
    const nav = buildKbNav(
      sections,
      articles.map((a) => ({
        slug: a.slug,
        title: entryLabel(a),
        link_path: a.link_path,
        section_slug: a.section || null,
        position: a.position,
        visibility: a.visibility,
      })),
      // Empty sections stay visible HERE and nowhere else: this is the screen
      // that fills them, and one that vanished the moment it was created
      // would be a button with no result.
      { keepEmpty: true },
    );
    const groups: NavGroup[] = nav.map((group) => ({
      slug: group.slug ?? "",
      title: group.title,
      entries: group.entries,
    }));
    // "Everything else" is always here, empty or not, because on this screen it
    // is somewhere you can DROP something. The reader's sidebar hides it when
    // empty (a heading with nothing under it is noise), but a manager dragging
    // an article out of every section needs a target to drag it to.
    if (!groups.some((group) => group.slug === "")) {
      groups.push({ slug: "", title: UNSECTIONED_TITLE, entries: [] });
    }
    return groups;
  }, [sections, articles]);

  /** What the list shows: the arrangement a drag is producing, or the stored one. */
  const groups = dragGroups ?? structure;

  /**
   * Everything already filed in a section, for working out where a NEW entry
   * goes.
   *
   * Only creation needs this now. Moving an existing entry is a drag, and
   * `moveEntry` works out the whole affected section rather than one number.
   */
  const siblingsOf = (sectionSlug: string) =>
    articles
      .filter((a) => (a.section || "") === sectionSlug)
      .map((a) => ({ slug: a.slug, position: a.position }));

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  /** Load the lists, and open the first article so the screen is never empty. */
  const loadLists = useCallback(() => {
    setLoading(true);
    return Promise.all([fetchArticles(), fetchSections()])
      .then(([rows, sectionRows]) => {
        setArticles(rows);
        setSections(sectionRows);
        const firstArticle = rows.find((r) => !r.link_path) ?? rows[0];
        // Passed explicitly rather than left to the `articles` state this sets
        // above: this effect runs once, with an `openDocument` closure fixed to
        // the render where the effect was created, whose `articles` was still
        // `[]`. `setArticles` schedules a re-render, it does not reach back into
        // that closure — so an autoload reading `articles` off the closure
        // always found nothing, and every field `applyPlacement` sets from it
        // (section, position, sidebar label) silently reset to blank the moment
        // this article was next saved.
        if (firstArticle) void openDocument(firstArticle.slug, { articles: rows });
      })
      .then(() => setListError(null))
      .catch((e) => {
        // A non-manager is redirected by the effect above; anything else stays
        // on screen. "Nothing here yet. Create the first article." over a
        // failed read invites a manager to write one that already exists.
        if (!(e instanceof Error) || !e.message.includes("Forbidden")) {
          const message = describeLoadError(e, "Could not load articles");
          setListError(message);
          toast.error(message);
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchArticles, fetchSections]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  /** Put the placement fields on screen from a list row. */
  function applyPlacement(summary: ArticleSummary | undefined) {
    setSection(summary?.section ?? "");
    setPosition(summary?.position ?? 0);
    setNavTitle(summary?.nav_title ?? "");
    setLinkPath(summary?.link_path ?? "");
    setKind(summary?.link_path ? "link" : "article");
  }

  async function openDocument(
    next: string,
    opts: { force?: boolean; articles?: ArticleSummary[] } = {},
  ) {
    // Clicking the article already open is a no-op, UNLESS its last load
    // failed: then the click is a retry, and swallowing it leaves the only
    // way out of that state a page reload.
    const retrying = next === slug && !creating && (failed.article || failed.versions);
    // A section open in the main window means this click is a real navigation
    // even when `slug` already names this article, so the early return above
    // would leave the click doing nothing.
    if (!opts.force && !retrying && next === slug && !creating && !sectionEdit) return;
    if (unsaved && !(await confirm(discardUnsavedChanges("Opening this")))) {
      return;
    }
    setSectionEdit(null);

    // `opts.articles` overrides the state for the one caller (the mount
    // effect) that cannot trust its own closure's `articles` to be current —
    // see the comment there. Every other caller is a click handler created on
    // the render that is on screen, where the state has already settled.
    const list = opts.articles ?? articles;
    const summary = list.find((d) => d.slug === next);
    // A LINK ENTRY has no version, no comments and nothing to render, so the
    // three reads below would all come back empty and the article read would
    // report "no published version" — which is true of every link entry and
    // says nothing. Everything it has is already in the list row.
    if (summary?.link_path) {
      claim();
      setCreating(false);
      setNewBaseline(null);
      setSlug(next);
      setKind("link");
      setTitle("");
      setBody("");
      setChangeNote("");
      setPreview(null);
      setVersions([]);
      setFeedback([]);
      setFailed({ article: false, versions: false, feedback: false });
      setVisibility(summary.visibility);
      setAnnotationsEnabled(summary.annotations_enabled);
      setBaseVisibility(summary.visibility);
      applyPlacement(summary);
      setStored({
        title: "",
        body_md: "",
        visibility: summary.visibility,
        annotations_enabled: summary.annotations_enabled,
        section: summary.section,
        position: summary.position,
        nav_title: summary.nav_title ?? "",
        link_path: summary.link_path,
      });
      return;
    }

    const token = claim();
    setBusy(true);
    try {
      // `allSettled`, not `all`: an article left with no published version makes
      // the article read throw, and `all` would then discard the version list
      // too — leaving the one screen that could repair it with nothing to show.
      const [docRes, vsRes, fbRes] = await Promise.allSettled([
        fetchDocument({ data: { slug: next } }),
        fetchVersions({ data: { slug: next } }),
        fetchFeedback({ data: { slug: next } }),
      ]);
      // A newer click won while these were in flight. Dropping the results is
      // the whole point: applying them would leave `slug` pointing at one
      // article and the editor showing another, and the next save would write
      // this article's text into that one.
      if (stale(token)) return;

      setCreating(false);
      setNewBaseline(null);
      setSlug(next);
      setChangeNote("");
      setPreview(null);
      setVersions(vsRes.status === "fulfilled" ? vsRes.value : []);
      setFeedback(fbRes.status === "fulfilled" ? fbRes.value : []);
      setFailed({
        article: docRes.status === "rejected",
        versions: vsRes.status === "rejected",
        feedback: fbRes.status === "rejected",
      });

      const placement = list.find((d) => d.slug === next);
      setKind("article");
      applyPlacement(placement);

      if (docRes.status === "fulfilled") {
        const doc = docRes.value;
        setTitle(doc.title);
        setBody(doc.body_md);
        setVisibility(doc.visibility);
        setAnnotationsEnabled(doc.annotations_enabled);
        setBaseVisibility(doc.visibility);
        setStored({
          title: doc.title,
          body_md: doc.body_md,
          visibility: doc.visibility,
          annotations_enabled: doc.annotations_enabled,
          section: placement?.section ?? "",
          position: placement?.position ?? 0,
          nav_title: placement?.nav_title ?? "",
          link_path: "",
        });
      } else {
        // The version could not be read. Show an empty editor over the real
        // version list so the manager can publish one of them.
        //
        // Visibility comes from the SIDEBAR row, not from the failed read, and
        // never from whatever was on screen a moment ago. Leaving the previous
        // article's setting here is how a managers-only draft got republished
        // to members by a manager who did exactly what the toast told them to.
        const summary = articles.find((d) => d.slug === next);
        setTitle("");
        setBody("");
        setStored(null);
        // Nothing is known about this article's settings, so refuse to guess.
        // A null baseline makes `onSave` stop rather than send one.
        setBaseVisibility(summary?.visibility ?? null);
        if (summary) {
          setVisibility(summary.visibility);
          setAnnotationsEnabled(summary.annotations_enabled);
        }
        // The reason matters: "no published version" invites the manager to
        // write one, and saying it about a transient failure invites them to
        // retype an article that is perfectly fine.
        const why = docRes.reason;
        toast.warning(
          why instanceof Error && !/no such article/i.test(why.message)
            ? `"${next}" could not be opened: ${why.message}`
            : `"${next}" has no published version. Publish one from the version list, or write a new one.`,
        );
      }
    } finally {
      if (!stale(token)) setBusy(false);
    }
  }

  async function startNew(nextKind: EntryKind) {
    const what = nextKind === "link" ? "Adding a link" : "Starting a new article";
    if (unsaved && !(await confirm(discardUnsavedChanges(what)))) return;
    claim();
    setSectionEdit(null);
    setCreating(true);
    setKind(nextKind);
    setSlug("");
    setTitle("");
    setBody("");
    setVisibility("members");
    setAnnotationsEnabled(true);
    setChangeNote("");
    setStored(null);
    setBaseVisibility(null);
    setVersions([]);
    setFeedback([]);
    setPreview(null);
    setNavTitle("");
    setLinkPath("");
    // Into the first section, at the END of it. Position 0 would put a brand-new
    // article ahead of the one a manager deliberately made the first thing a
    // member reads, which is the single thing the reading order is for.
    const into = sections[0]?.slug ?? "";
    setSection(into);
    setPosition(nextPosition(siblingsOf(into)));
    setNewBaseline({
      ...KB_DRAFT_SHAPE,
      section: into,
      position: String(nextPosition(siblingsOf(into))),
    });
    setFailed({ article: false, versions: false, feedback: false });
  }

  /** Open a section in the main window, where it is renamed and deleted. */
  async function openSection(row: SectionRow) {
    if (sectionEdit?.slug === row.slug) return;
    if (unsaved && !(await confirm(discardUnsavedChanges("Opening this section")))) {
      return;
    }
    claim();
    setPreview(null);
    setSectionEdit({ slug: row.slug, title: row.title });
    setSectionTitle(row.title);
  }

  /**
   * Read an older version before deciding whether to restore it.
   *
   * Without this the Restore button is a blind click: the editor only ever holds
   * the live version, so a manager undoing an edit has to publish a version they
   * cannot see in order to find out what is in it, and members read it in the
   * meantime.
   */
  async function onView(version: VersionRow) {
    const token = claim();
    setBusy(true);
    try {
      const doc = await fetchDocument({ data: { slug, version: version.version } });
      if (stale(token)) return;
      setPreview({ version: version.version, title: doc.title, body_md: doc.body_md });
    } catch (e) {
      if (!stale(token)) {
        toast.error(e instanceof Error ? e.message : "Could not read that version");
      }
    } finally {
      if (!stale(token)) setBusy(false);
    }
  }

  async function onSave() {
    setSaveError(null);
    const isLink = kind === "link";
    const targetSlug = (creating ? slug || slugFromTitle(isLink ? navTitle : title) : slug).trim();
    if (!targetSlug) {
      toast.error("Give the article a URL key, e.g. house-rules.");
      return;
    }
    // Check the key here rather than letting the server reject it: a hand-typed
    // "House Rules" would otherwise come back as a raw validation dump.
    if (!SLUG_PATTERN.test(targetSlug) || targetSlug.length > 100) {
      toast.error("A URL key can only use lowercase letters, numbers and single hyphens.");
      return;
    }

    // Creating an article whose slug already exists is not a create — the
    // server treats a known slug as "add a version to it". Left unchecked, a
    // manager typing the title of an existing managers-only draft would replace
    // its live text AND, because the form always sends a visibility, publish it
    // to everyone. Refuse here for a message that points at the list; the save
    // also carries `expect_new`, so the database refuses it too when this list
    // is a stale snapshot and somebody else took the key in the meantime.
    if (creating && articles.some((d) => d.slug === targetSlug)) {
      toast.error(
        `An article already exists at /kb/${targetSlug}. Open it from the list to add a version.`,
      );
      return;
    }

    // A link entry's two required fields, checked here so the manager gets a
    // sentence rather than the server's schema dump. The path rules are a
    // security boundary, not tidiness: an absolute URL would put any
    // destination into the club's own navigation, and a link back into /kb is a
    // redirect loop with no way out of the tab.
    if (isLink) {
      if (!navTitle.trim()) {
        toast.error("A link needs a name to show in the sidebar.");
        return;
      }
      if (!/^\/[a-z0-9][a-z0-9/-]*$/.test(linkPath.trim()) || linkPath.includes("//")) {
        toast.error("Point the link at a path on this site, e.g. /first-class.");
        return;
      }
      if (/^\/kb($|\/)/.test(linkPath.trim())) {
        toast.error(
          "A link cannot point back into the knowledge base. Drag articles in the list to order them.",
        );
        return;
      }
    }

    // Saving an existing article whose settings never loaded would send a
    // visibility that was never read off it. Stop instead of guessing: the
    // widening prompt below cannot fire without a baseline, so this would be the
    // one save that changes who can read an article with nothing asked.
    if (!creating && baseVisibility === null) {
      toast.error(
        `Who can read "${targetSlug}" is not known yet, so saving could change it. Open it again from the list first.`,
      );
      return;
    }

    // Widening is the one save worth stopping for: it publishes text to people
    // who could not read it a moment ago. Narrowing is recoverable, so it goes
    // through without a prompt.
    const widening = wideningVisibility(baseVisibility, visibility);
    if (
      widening &&
      !(await confirm({
        title: `Let ${visibilityAudience[widening.to].toLowerCase()} read "${title}"?`,
        description: `Only ${visibilityAudience[widening.from].toLowerCase()} can read it right now. Saving opens it to everyone in the wider group, including any earlier wording still in the current version.`,
        confirmLabel: "Save and open it up",
      }))
    ) {
      return;
    }

    const token = claim();
    setSaving(true);
    try {
      // The placement travels with every save, of either kind. `nav_title` is
      // sent even when empty, because "" is how the sidebar label is CLEARED and
      // an omitted field means "leave it alone" — a manager who deletes the
      // label expects the title back, not nothing to happen.
      const placement = {
        section,
        position,
        nav_title: navTitle.trim(),
      };
      const res = await save({
        data: isLink
          ? { slug: targetSlug, link_path: linkPath.trim(), ...placement, expect_new: creating }
          : {
              slug: targetSlug,
              title,
              body_md: body,
              visibility,
              annotations_enabled: annotationsEnabled,
              change_note: changeNote,
              ...placement,
              // Only when this save is converting a link entry into an article.
              // Sending it otherwise would be a no-op on an article and a
              // schema error the moment the text fields are empty.
              ...(stored?.link_path ? { link_path: "" } : {}),
              expect_new: creating,
            },
      });
      // Report the save the moment it succeeds. Refreshing the lists is a second
      // round trip, and reporting after it announced a successful save as a
      // failure — whereupon the obvious response, saving again, files a
      // duplicate version. (Same trap as the waiver template editor.)
      toast.success(
        isLink
          ? res.created
            ? `Added the link "${navTitle.trim()}"`
            : "Link saved"
          : res.created
            ? `Created "${targetSlug}" and published version ${res.version}`
            : `Saved version ${res.version}, now live`,
      );
      // What members are reading has just changed, so drop the reader side's
      // cached copies. This screen keeps its own state and never goes through
      // those queries, so nothing else would: the manager who opens
      // `/kb/<slug>` to check their correction would otherwise read the version
      // they have just replaced.
      invalidateKbReader();
      // The save landed either way, so it is reported. But if the manager has
      // since opened a different article, writing this one's text back into the
      // editor would put the screen out of step with itself.
      if (stale(token)) return;
      setCreating(false);
      setNewBaseline(null);
      setSlug(targetSlug);
      setChangeNote("");
      setBaseVisibility(visibility);
      setNavTitle(placement.nav_title);
      setFailed({ article: false, versions: false, feedback: false });
      setStored({
        title: isLink ? "" : title,
        body_md: isLink ? "" : body,
        visibility,
        annotations_enabled: annotationsEnabled,
        section,
        position,
        nav_title: placement.nav_title,
        link_path: isLink ? linkPath.trim() : "",
      });
      if (isLink) setLinkPath(linkPath.trim());
      // The version is published, so there is nothing left to recover. `stored`
      // moving to match would clear it anyway; doing it here as well covers the
      // save that also changed the slug, whose draft is filed under the old one.
      kbDraft.clear();
      try {
        const [rows, sectionRows, vs] = await Promise.all([
          fetchArticles(),
          fetchSections(),
          // A link entry never has versions, so that round trip can only ever
          // come back empty.
          isLink ? Promise.resolve([]) : fetchVersions({ data: { slug: targetSlug } }),
        ]);
        if (stale(token)) return;
        setArticles(rows);
        setSections(sectionRows);
        setVersions(vs);
      } catch {
        toast.warning("Saved. The version list could not be refreshed, so reload to see it.");
      }
    } catch (e) {
      if (stale(token)) return;
      setSaveError(e instanceof Error && e.message ? e.message : "Save failed.");
    } finally {
      setSaving(false);
      // Clears a `busy` a load abandoned when this save overtook it. That load
      // deliberately leaves it to whoever claimed next, and that is here.
      setBusy(false);
    }
  }

  async function onPromote(version: VersionRow) {
    if (version.is_current) return;
    // Promoting publishes the STORED row, not what is on screen. Saying so
    // matters most to the manager who has just rewritten a passage: without it
    // they read "now live", see their own edit still in the box, and believe it
    // is what members are reading.
    const ok = await confirm({
      title: `Publish version ${version.version}?`,
      description: `${visibilityAudience[baseVisibility ?? visibility]} read it from now on. Comments stay attached to the version they were written against.`,
      footnote: dirty
        ? `Your unsaved edits are discarded by this, and they are not part of version ${version.version} so they will not go live either. Save them as a new version first if you want to keep them.`
        : undefined,
      confirmLabel: "Publish it",
    });
    if (!ok) return;
    const token = claim();
    const target = slug;
    setPromoting(true);
    try {
      await promote({ data: { id: version.id } });
      toast.success(`Version ${version.version} is now live`);
      // A different version is what members read now. See `onSave`.
      invalidateKbReader();
      // The publish has already committed. Reporting a failed REFRESH as a
      // failed publish would tell the manager the club's live article is
      // something it is not, so the refresh gets its own try. (`onSave` learned
      // this first.)
      try {
        const [vs, doc, rows] = await Promise.all([
          fetchVersions({ data: { slug: target } }),
          fetchDocument({ data: { slug: target } }),
          fetchArticles(),
        ]);
        if (stale(token)) return;
        setVersions(vs);
        setArticles(rows);
        setChangeNote("");
        setPreview(null);
        setTitle(doc.title);
        setBody(doc.body_md);
        setVisibility(doc.visibility);
        setAnnotationsEnabled(doc.annotations_enabled);
        setBaseVisibility(doc.visibility);
        setFailed({ article: false, versions: false, feedback: false });
        const placement = rows.find((d) => d.slug === target);
        applyPlacement(placement);
        setStored({
          title: doc.title,
          body_md: doc.body_md,
          visibility: doc.visibility,
          annotations_enabled: doc.annotations_enabled,
          section: placement?.section ?? "",
          position: placement?.position ?? 0,
          nav_title: placement?.nav_title ?? "",
          link_path: "",
        });
      } catch {
        toast.warning("Published. The screen could not be refreshed, so reload to see it.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the live version");
    } finally {
      setPromoting(false);
      // See `onSave`: this claim owns clearing a `busy` an overtaken load left.
      setBusy(false);
    }
  }

  /**
   * Refresh both lists after a structure change, in one place.
   *
   * The reorder and section handlers all end the same way, and a failed refresh
   * is reported as itself: the write has already committed, so telling the
   * manager the MOVE failed would have them do it again and move it twice.
   */
  async function refreshStructure(token: number) {
    // The reading order a member sees is what just moved. See `onSave`.
    invalidateKbReader();
    try {
      const [rows, sectionRows] = await Promise.all([fetchArticles(), fetchSections()]);
      if (stale(token)) return;
      setArticles(rows);
      setSections(sectionRows);
    } catch {
      toast.warning("Done, but the list could not be refreshed. Reload to see it.");
    }
  }

  /**
   * Write the rows a drop moved.
   *
   * Placement saves write no VERSION, which is the whole reason dragging is the
   * only way to move an article: it means rearranging the reading order never
   * tells a member their article was updated, and never bumps the number their
   * comments are pinned against.
   *
   * The writes are sequential rather than parallel: they are rows of the same
   * list, and a half-applied set is much easier to reason about (and to repeat)
   * than several overlapping saves whose order decided the result.
   */
  async function commitPlacements(moves: Placement[]) {
    if (!moves.length) {
      setDragGroups(null);
      return;
    }
    const token = claim();
    setOrdering(true);
    try {
      for (const move of moves) {
        await save({ data: { slug: move.slug, section: move.section, position: move.position } });
      }
      // The entry on screen may be one of the rows that just moved, so its
      // baseline has to move with it or the editor reads as having unsaved
      // changes it cannot show.
      const mine = moves.find((m) => m.slug === slug);
      if (mine && !stale(token)) {
        setSection(mine.section);
        setPosition(mine.position);
        setStored((prev) =>
          prev ? { ...prev, section: mine.section, position: mine.position } : prev,
        );
      }
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move that");
    } finally {
      setOrdering(false);
      // Cleared only now, so the list holds the dropped arrangement until the
      // refreshed rows land. Clearing it any earlier snaps everything back to
      // the old order for the length of a round trip, which reads as the drag
      // having failed.
      setDragGroups(null);
    }
  }

  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    const label =
      (event.active.data.current?.label as string | undefined) ?? id.replace(/^[^:]+:/, "");
    setDragGroups(structure);
    setDragging({ id, label });
  }

  /**
   * Carry an entry into the section it is currently over, so the list shows
   * where it would land.
   *
   * Without this a cross-section drag looks like nothing until the drop, and a
   * manager cannot see whether they are about to file the article into "Belts"
   * or the section under it.
   */
  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || active.data.current?.type !== "entry") return;
    const current = dragGroups ?? structure;
    const from = containerOf(current, String(active.id));
    const to = containerOf(current, String(over.id));
    if (from === null || to === null || from === to) return;

    const slugMoved = String(active.id).slice("entry:".length);
    const entry = current
      .find((group) => group.slug === from)
      ?.entries.find((e) => e.slug === slugMoved);
    if (!entry) return;

    const target = current.find((group) => group.slug === to);
    const overIndex = target?.entries.findIndex((e) => entryId(e.slug) === String(over.id)) ?? -1;
    const at = overIndex === -1 ? (target?.entries.length ?? 0) : overIndex;

    // The updater form, not `current`: `pointermove` is a continuous-priority
    // event, so two drag-overs can be handled before React commits the first,
    // and the second would otherwise compute from the pre-move arrangement.
    setDragGroups((prev) =>
      (prev ?? current).map((group) => {
        if (group.slug === from) {
          return { ...group, entries: group.entries.filter((e) => e.slug !== slugMoved) };
        }
        if (group.slug === to) {
          const entries = group.entries.filter((e) => e.slug !== slugMoved);
          entries.splice(Math.min(at, entries.length), 0, entry);
          return { ...group, entries };
        }
        return group;
      }),
    );
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDragging(null);
    if (!over) {
      setDragGroups(null);
      return;
    }

    if (active.data.current?.type === "section") {
      const named = structure.filter((group) => group.slug !== "");
      const target = String(active.id).slice("section:".length);
      const from = named.findIndex((group) => group.slug === target);
      // The drop may have landed on another heading, on a section's body, or on
      // one of the entries inside it. All three mean the same thing: that
      // section's place in the sidebar.
      const overSection = containerOf(structure, String(over.id));
      // "Everything else" is always rendered last and is not a section anyone
      // made, so it is not in `named` and cannot be a destination. Dragging a
      // section onto it means "put this last", which is the natural gesture for
      // moving a section to the bottom. Reading it as "no match" made that drag
      // silently do nothing.
      const to =
        overSection === ""
          ? named.length - 1
          : named.findIndex((group) => group.slug === overSection);
      if (from === -1 || to === -1) {
        setDragGroups(null);
        return;
      }
      const moves = moveSection(
        named.map((group) => ({
          slug: group.slug,
          position: sections.find((row) => row.slug === group.slug)?.position ?? 0,
        })),
        target,
        to,
      );
      if (!moves.length) {
        setDragGroups(null);
        return;
      }
      // "Everything else" is not in `named` and is always last, so it is put
      // back on the end rather than reordered with the rest.
      setDragGroups([
        ...arrayMove(named, from, to),
        ...structure.filter((group) => group.slug === ""),
      ]);
      void commitSectionOrder(moves);
      return;
    }

    const current = dragGroups ?? structure;
    const slugMoved = String(active.id).slice("entry:".length);
    const into = containerOf(current, String(over.id));
    if (into === null) {
      setDragGroups(null);
      return;
    }

    // The arrangement `onDragOver` has been building already has the entry in
    // its new section, so the final index is read off THAT rather than
    // recomputed from the drop coordinates.
    const target = current.find((group) => group.slug === into);
    const entries = target?.entries ?? [];
    const oldIndex = entries.findIndex((e) => e.slug === slugMoved);
    const overIndex = entries.findIndex((e) => entryId(e.slug) === String(over.id));
    const settled =
      oldIndex === -1 || overIndex === -1 ? entries : arrayMove(entries, oldIndex, overIndex);
    const found = settled.findIndex((e) => e.slug === slugMoved);
    // The entry is missing from the section it was dropped on when the last
    // drag-over and the drop disagreed about what was under the cursor. Landing
    // it at the end of that section is a guess, but it is the RIGHT section, and
    // it beats the alternative: a drop that silently does nothing, which is the
    // failure this screen was reported for.
    const at = found === -1 ? settled.length : found;

    setDragGroups(
      current.map((group) =>
        group.slug === into
          ? {
              ...group,
              entries: found === -1 ? [...settled, ...entriesNamed(current, slugMoved)] : settled,
            }
          : found === -1
            ? { ...group, entries: group.entries.filter((e) => e.slug !== slugMoved) }
            : group,
      ),
    );
    void commitPlacements(
      moveEntry(
        structure.map((group) => ({
          slug: group.slug,
          entries: group.entries.map((e) => ({ slug: e.slug, position: e.position })),
        })),
        slugMoved,
        into,
        at,
      ),
    );
  }

  /** Write the sections a section drag moved. */
  async function commitSectionOrder(moves: { slug: string; position: number }[]) {
    const token = claim();
    setOrdering(true);
    try {
      for (const move of moves) {
        await saveSection({ data: { slug: move.slug, position: move.position } });
      }
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move that section");
    } finally {
      setOrdering(false);
      // See `commitPlacements`: the dropped arrangement stays on screen until
      // the refreshed rows land, so the list does not snap back for the length
      // of a round trip.
      setDragGroups(null);
    }
  }

  async function onAddSection() {
    const name = newSectionTitle.trim();
    if (!name) return;
    const sectionSlug = slugFromTitle(name);
    if (!sectionSlug) {
      toast.error("Give the section a name that can make a URL key, e.g. Belts and grading.");
      return;
    }
    if (sections.some((s) => s.slug === sectionSlug)) {
      toast.error(`There is already a section at "${sectionSlug}".`);
      return;
    }
    const token = claim();
    setBusy(true);
    try {
      await saveSection({
        data: { slug: sectionSlug, title: name, position: nextPosition(sections) },
      });
      toast.success(`Added the section "${name}"`);
      setNewSectionTitle("");
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add that section");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSection() {
    if (!sectionEdit) return;
    const name = sectionTitle.trim();
    if (!name) {
      toast.error("Give the section a name.");
      return;
    }
    const token = claim();
    setSaving(true);
    try {
      // The slug is NOT changed with the title. It is the handle the agent API
      // and every article's `section` refer to, so renaming a heading must not
      // silently unfile everything in it.
      await saveSection({ data: { slug: sectionEdit.slug, title: name } });
      toast.success(`Renamed the section to "${name}"`);
      if (!stale(token)) {
        setSectionEdit({ slug: sectionEdit.slug, title: name });
        setSectionTitle(name);
      }
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename that section");
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteSection(target: SectionRow) {
    const inside = articles.filter((a) => a.section === target.slug).length;
    const ok = await confirm({
      title: `Delete the section "${target.title}"?`,
      description: inside
        ? `The ${inside} entr${inside === 1 ? "y" : "ies"} in it are kept, and drop to the "Everything else" group at the bottom of the sidebar until you file them somewhere.`
        : "It is empty, so nothing members read changes.",
      footnote: "The section itself goes for good.",
      confirmLabel: "Delete section",
      destructive: true,
    });
    if (!ok) return;
    const token = claim();
    setBusy(true);
    try {
      const res = await removeSection({ data: { slug: target.slug } });
      toast.success(
        res.displaced
          ? `Deleted "${target.title}". ${res.displaced} entr${res.displaced === 1 ? "y" : "ies"} moved to "${UNSECTIONED_TITLE}".`
          : `Deleted "${target.title}"`,
      );
      // The open article may have been in it, so its own placement is stale.
      if (!stale(token) && section === target.slug) {
        setSection("");
        setStored((prev) => (prev ? { ...prev, section: "" } : prev));
      }
      // The main window was showing the section that no longer exists, so it
      // goes back to whatever article was last open rather than sitting on a
      // form that can only fail.
      if (!stale(token) && sectionEdit?.slug === target.slug) setSectionEdit(null);
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete that section");
    } finally {
      setBusy(false);
    }
  }

  const proposedSlug = useMemo(
    () => slugFromTitle(kind === "link" ? navTitle : title),
    [kind, navTitle, title],
  );

  /** The address this article will have, which is what a link to it must use. */
  const articleSlug = slug || proposedSlug;

  /**
   * The worked example above the anchor list, built from THIS article's first
   * heading.
   *
   * A fixed label ("how grading works") pointed at whatever the real first
   * heading happened to be, so on most articles the words and the target
   * disagreed ("[how grading works](/kb/about-us#our-mission)") — an example of
   * the syntax that contradicts itself.
   */
  const anchorExample = sectionAnchors[0]
    ? `[${sectionAnchors[0].text}](${anchorPath(articleSlug, sectionAnchors[0].id)})`
    : "[how grading works](/kb/belts#grading)";

  /**
   * How the reading order can be dragged.
   *
   * The keyboard sensor is not a nicety: it is the ONLY way to reorder without a
   * mouse now that the up/down arrows are gone, so a grab handle that could not
   * be tabbed to and driven with the arrow keys would have taken the feature
   * away from anyone who used them. The pointer sensor waits for 4px of travel
   * so a plain click on a handle is still a click.
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (loading) return <Loading className="p-8" />;

  // The same `isSectionDirty` the discard prompt consults, so "there is nothing
  // to save" and "there is nothing to lose" can never disagree.
  const sectionSaveDisabled =
    saving ||
    promoting ||
    busy ||
    ordering ||
    !sectionTitle.trim() ||
    !isSectionDirty({ title: sectionTitle }, sectionEdit);

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Knowledge base</h1>
          <p className="text-sm text-muted-foreground">
            Articles members read and comment on at /kb. Saving creates a new version and publishes
            it. Past versions stay, and comments stay attached to the version they were written
            against.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={saving || promoting || busy || ordering}
            onClick={() => void startNew("article")}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New article
          </Button>
          {/* A sidebar entry pointing at a page the club already has. Its own
              button rather than a mode buried in the form, because it is the
              answer to a question a manager asks out loud ("can I just link the
              FAQ?") and it was previously agent-only. */}
          <Button
            type="button"
            variant="outline"
            disabled={saving || promoting || busy || ordering}
            onClick={() => void startNew("link")}
          >
            <Link2 className="mr-1.5 h-4 w-4" />
            New link
          </Button>
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>
      </div>

      {/* The reading order goes FIRST, and on the left, because it is the
          navigation for this screen: it is how a manager picks what to edit, and
          it is the order members walk. Stacked on a narrow screen it stays
          first, rather than being buried under a 22-row textarea. */}
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] lg:self-start lg:overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reading order</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                What a new member reads, top to bottom. Click an entry to edit it, or drag one by
                its handle to move it up, down, or into another section. Moving something never
                tells members it was updated.
              </p>

              {listError ? (
                <LoadFailure
                  what="The knowledge base"
                  message={listError}
                  hint="This is not the same as it being empty, so do not write an article from here: it may already exist."
                  onRetry={() => void loadLists()}
                />
              ) : (
                articles.length === 0 &&
                sections.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Nothing here yet. Create the first article.
                  </p>
                )
              )}

              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                modifiers={[restrictToVerticalAxis]}
                accessibility={{ announcements }}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
                onDragCancel={() => {
                  setDragging(null);
                  setDragGroups(null);
                }}
              >
                <SortableContext
                  items={groups.filter((g) => g.slug !== "").map((g) => sectionId(g.slug))}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-4">
                    {groups.map((group, groupIndex) => (
                      <SectionGroup
                        key={group.slug || "unsectioned"}
                        group={group}
                        open={sectionEdit?.slug === group.slug}
                        disabled={saving || promoting || busy || ordering}
                        dragDisabled={ordering}
                        sectionIndex={groupIndex + 1}
                        sectionCount={groups.filter((g) => g.slug !== "").length}
                        onOpen={() => {
                          const row = sections.find((s) => s.slug === group.slug);
                          if (row) void openSection(row);
                        }}
                      >
                        {group.entries.map((entry, entryIndex) => (
                          <EntryRow
                            key={entry.slug}
                            entry={entry}
                            row={articles.find((a) => a.slug === entry.slug)}
                            index={entryIndex + 1}
                            count={group.entries.length}
                            sectionTitle={group.title}
                            open={entry.slug === slug && !creating && !sectionEdit}
                            // `ordering` is in here too: opening an article
                            // mid-drop claims a newer request token, which
                            // cancels the refresh the drop was waiting on and
                            // leaves the list showing the old order over rows
                            // that were already written.
                            disabled={saving || promoting || busy || ordering}
                            dragDisabled={ordering}
                            onOpen={() => void openDocument(entry.slug)}
                          />
                        ))}
                      </SectionGroup>
                    ))}
                  </div>
                </SortableContext>
                <DragOverlay>
                  {dragging && (
                    <div className="rounded-md border border-primary bg-background px-2.5 py-1.5 text-sm font-medium shadow-lg">
                      {dragging.label}
                    </div>
                  )}
                </DragOverlay>
              </DndContext>

              <div className="border-t pt-3">
                <Label htmlFor="new-section" className="text-xs">
                  New section
                </Label>
                <div className="mt-1.5 flex gap-1.5">
                  <Input
                    id="new-section"
                    value={newSectionTitle}
                    onChange={(e) => setNewSectionTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void onAddSection();
                      }
                    }}
                    maxLength={100}
                    placeholder="Belts and grading"
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving || promoting || busy || ordering || !newSectionTitle.trim()}
                    onClick={() => void onAddSection()}
                  >
                    Add
                  </Button>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  A section with nothing in it is not shown to members. Click a section name to
                  rename or delete it.
                </p>
              </div>
            </CardContent>
          </Card>
        </aside>

        <div className="space-y-4">
          {/* Above both editors rather than inside the article one: the offer is
              about this slug, and it should be the first thing a manager sees on
              a screen they have just come back to. */}
          {kbDraft.offered && (
            <DraftRestoreBanner
              what={kbDraft.offered.linkPath ? "link" : "article"}
              savedAt={kbDraft.offeredAt}
              onRestore={restoreKbDraft}
              onDiscard={kbDraft.discard}
            />
          )}
          {saveError && (
            <SaveFailure
              what={kind === "link" ? "link" : "article"}
              message={saveError}
              retrying={saving}
              onRetry={() => void onSave()}
            />
          )}
          {sectionEdit ? (
            /* A section, edited in the same window an article is, so titles,
               settings and deletion all live in one place and the list on the
               left does nothing but navigate and arrange. */
            <div className="space-y-4">
              <div>
                <h2 className="text-xl font-bold">Section</h2>
                <p className="text-sm text-muted-foreground">
                  A heading in the sidebar. Drag it in the list to move the whole section, and drag
                  entries into it to fill it.
                </p>
              </div>
              <div>
                <Label htmlFor="section-title">Name</Label>
                <Input
                  id="section-title"
                  value={sectionTitle}
                  onChange={(e) => setSectionTitle(e.target.value)}
                  maxLength={100}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="section-slug">URL key</Label>
                <Input
                  id="section-slug"
                  value={sectionEdit.slug}
                  readOnly
                  disabled
                  className="mt-1.5 font-mono text-sm"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Fixed. Every article in this section refers to it by this key, so changing it
                  would unfile all of them.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void onSaveSection()} disabled={sectionSaveDisabled}>
                  {saving ? "Saving..." : "Save the name"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving || promoting || busy || ordering}
                  onClick={() => {
                    const row = sections.find((s) => s.slug === sectionEdit.slug);
                    if (row) void onDeleteSection(row);
                  }}
                >
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  Delete this section
                </Button>
                {unsaved && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              </div>
            </div>
          ) : (
            <>
              {/* Also shown when there is no slug yet, not only in `creating` mode.
                  On an empty club the screen opens with `creating` false and no
                  slug, and without this the manager types a title and body, hits
                  Save, and is told to give it a URL key with no field to type one
                  into. */}
              {(creating || !slug) && (
                <div>
                  <Label htmlFor="slug">URL key</Label>
                  <Input
                    id="slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder={proposedSlug || "house-rules"}
                    maxLength={100}
                    className="mt-1.5 font-mono text-sm"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    The permanent address: /kb/{slug || proposedSlug || "house-rules"}. Lowercase
                    letters, numbers and single hyphens. Leave it blank to use the{" "}
                    {kind === "link" ? "name" : "title"}.
                  </p>
                </div>
              )}

              {kind === "link" ? (
                <div className="space-y-4 rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">
                    A sidebar entry pointing at a page this site already has, so the club keeps one
                    copy of it rather than two. It reads in order with everything else, it holds no
                    text of its own, and it takes no comments.
                  </p>
                  <div>
                    <Label htmlFor="link-label">Name in the sidebar</Label>
                    <Input
                      id="link-label"
                      value={navTitle}
                      onChange={(e) => setNavTitle(e.target.value)}
                      maxLength={100}
                      placeholder="Your first session"
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="link-path">Where it goes</Label>
                    <Input
                      id="link-path"
                      value={linkPath}
                      onChange={(e) => setLinkPath(e.target.value)}
                      maxLength={200}
                      placeholder="/first-class"
                      className="mt-1.5 font-mono text-sm"
                    />
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      A path on this site, e.g. /first-class or /faq. Not a full web address, and
                      not another /kb page: drag those into place in the list instead.
                    </p>
                  </div>
                  {stored?.link_path && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={saving || busy}
                      // No confirm: this only swaps what the editor is
                      // showing. Nothing members read changes until a save, and
                      // leaving without saving puts the link back.
                      onClick={() => {
                        setKind("article");
                        setLinkPath("");
                      }}
                    >
                      Turn this into an article
                    </Button>
                  )}
                  {stored?.link_path && (
                    <p className="text-xs text-muted-foreground">
                      It keeps its place in the reading order, and you write its text here. The link
                      is only replaced when you save.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div>
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={200}
                      className="mt-1.5"
                    />
                  </div>

                  <div>
                    <Label htmlFor="body">Body (Markdown)</Label>
                    <MarkdownEditor
                      id="body"
                      value={body}
                      onChange={setBody}
                      rows={22}
                      aria-describedby="body-hint"
                    />
                    <p id="body-hint" className="mt-1.5 text-xs text-muted-foreground">
                      Members comment paragraph by paragraph. Editing the words of a paragraph
                      detaches its comments, which are then shown as being about earlier wording.
                      Adding or moving paragraphs elsewhere leaves other comments where they are.
                    </p>
                  </div>
                </>
              )}

              {/* No section picker here. Where an entry sits in the reading order
                  is shown by where it sits in the list on the left, and changed by
                  dragging it there — one place, and the same one members see.
                  Choosing a section here used to take effect only on Save, which
                  published a new VERSION for what was really just a move and told
                  every member the article had been updated. */}
              <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                {kind === "article" && (
                  <>
                    <div>
                      <Label htmlFor="visibility">Who can read it</Label>
                      <Select
                        value={visibility}
                        onValueChange={(v) => setVisibility(v as ArticleVisibility)}
                      >
                        <SelectTrigger id="visibility" className="mt-1.5">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {articleVisibilities.map((v) => (
                            <SelectItem key={v} value={v}>
                              {VISIBILITY_LABEL[v]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={annotationsEnabled}
                          onCheckedChange={(v) => setAnnotationsEnabled(v === true)}
                        />
                        Accept comments
                      </label>
                    </div>
                    <div>
                      <Label htmlFor="nav-title">Sidebar label (optional)</Label>
                      <Input
                        id="nav-title"
                        value={navTitle}
                        onChange={(e) => setNavTitle(e.target.value)}
                        maxLength={100}
                        placeholder={title || "Shorter than the title"}
                        className="mt-1.5"
                      />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        For when the title is long: "Syllabus" in the sidebar, the full heading on
                        the page. Blank uses the title.
                      </p>
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="change-note">What changed (optional)</Label>
                      <Input
                        id="change-note"
                        value={changeNote}
                        onChange={(e) => setChangeNote(e.target.value)}
                        maxLength={500}
                        placeholder="Added the hygiene section"
                        className="mt-1.5"
                      />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Shown to readers whose comments were written against an earlier version.
                      </p>
                    </div>
                  </>
                )}
                {kind === "link" && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    A link entry has no text of its own, so there is nothing else to set. Drag it in
                    the list to place it.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={onSave}
                  // `!dirty` is the point of this: without it, opening an
                  // article and pressing Save published an identical version,
                  // bumped the number every member's comments are pinned
                  // against, and told them the article had changed.
                  // `ordering` matters here beyond tidiness: a save sends
                  // `section` and `position` straight from component state, and
                  // a drop's writes have not landed in that state yet. Saving
                  // mid-drop would publish a version carrying the OLD placement
                  // and silently undo the move the manager just made.
                  disabled={
                    saving ||
                    promoting ||
                    busy ||
                    ordering ||
                    !dirty ||
                    (kind === "link"
                      ? !navTitle.trim() || !linkPath.trim()
                      : !title.trim() || !body.trim())
                  }
                >
                  {saving
                    ? "Saving..."
                    : kind === "link"
                      ? creating
                        ? "Add the link"
                        : "Save the link"
                      : creating
                        ? "Create and publish"
                        : "Save as new version"}
                </Button>
                {busy && <Loading className="text-xs" />}
                {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              </div>
            </>
          )}

          {!sectionEdit && !creating && failed.versions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Versions</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Not "no versions". An empty list here would say this
                    article has no history, which is a confident wrong answer
                    about the one panel that can undo an edit. */}
                <p className="text-sm text-muted-foreground">
                  The version list could not be loaded. Click this article in the list to try again.
                </p>
              </CardContent>
            </Card>
          )}

          {!sectionEdit && !creating && !failed.versions && versions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  One version is live at a time. Publishing an older one is how you undo an edit.
                </p>
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span>
                      <span className="font-medium">Version {v.version}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDate(v.created_at)}
                        {v.change_note ? ` · ${v.change_note}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {v.is_current ? (
                        <Badge>Live</Badge>
                      ) : (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Read version ${v.version}`}
                            disabled={promoting || saving || busy}
                            onClick={() => void onView(v)}
                          >
                            Read
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            // Every one of these reads "Publish" or "Restore", so
                            // without a label a screen reader announces a column of
                            // identical buttons.
                            aria-label={`${
                              versionLabel(v, liveVersion) === "Previous" ? "Restore" : "Publish"
                            } version ${v.version}`}
                            disabled={promoting || saving || busy}
                            onClick={() => void onPromote(v)}
                          >
                            {versionLabel(v, liveVersion) === "Previous" ? "Restore" : "Publish"}
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {!sectionEdit && !creating && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Feedback</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Precise on purpose. Private notes ARE shown, to the person
                    who wrote them. "Never shown anywhere" would have a manager
                    repeat something untrue to a member who asked. */}
                <p className="text-xs text-muted-foreground">
                  Open comment threads members left. Private notes are never shown to the club, only
                  to the person who wrote them.
                </p>
                {failed.feedback ? (
                  // "No open comments" would tell a manager members had nothing
                  // to say, on the panel they use to decide whether feedback has
                  // been dealt with.
                  <p className="text-sm text-muted-foreground">
                    The comments could not be loaded, so this is not the full picture. Click this
                    article in the list to try again.
                  </p>
                ) : feedback.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open comments.</p>
                ) : (
                  feedback.map((f) => (
                    <div key={f.id} className="rounded-md bg-muted/50 p-3 text-sm">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          <UserLink
                            userId={f.user_id}
                            name={f.author}
                            fallback="Someone at the club"
                          />
                        </span>
                        <span>v{f.article_version}</span>
                        <span>{formatDate(f.created_at)}</span>
                        {f.parent_id && <Badge variant="outline">Reply</Badge>}
                      </div>
                      {f.quote && (
                        <blockquote className="mb-1 border-l-2 pl-2 text-xs italic text-muted-foreground">
                          {f.quote.replace(/\s+/g, " ").slice(0, 120)}
                        </blockquote>
                      )}
                      <p className="whitespace-pre-wrap">{f.body}</p>
                    </div>
                  ))
                )}
                {slug && (
                  <Button asChild variant="outline" size="sm" className="w-full">
                    <Link to="/kb/$slug" params={{ slug }}>
                      Open the article to reply
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* How one article points at a section of another. Managers asked for
              cross-references, and the fragment is the part they cannot guess:
              it comes from the wording of the heading, so this is where they
              find out what it currently is and copy it. */}
          {!sectionEdit && kind === "article" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Link to a section</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Paste one of these into another article as an ordinary Markdown link, for example{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">{anchorExample}</code>.
                  Add{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">{"{#your-anchor}"}</code>{" "}
                  to the end of a heading to pin its link, and it will keep working even if you
                  reword the heading later.
                </p>
                {sectionAnchors.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This article has no headings yet, so there is nothing to link to inside it.
                    Start a line with ## to make one.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {sectionAnchors.map((heading) => (
                      <li
                        key={heading.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                        style={{ marginLeft: `${(heading.depth - 1) * 0.75}rem` }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{heading.text}</span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {anchorPath(articleSlug, heading.id)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {/* Says which links survive a rewrite and which do not,
                              which is the whole reason to pin one. */}
                          {heading.pinned && <Badge variant="outline">Pinned</Badge>}
                          <CopyButton
                            text={anchorPath(articleSlug, heading.id)}
                            label="Copy"
                            ariaLabel={`Copy the link to ${heading.text}`}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {!sectionEdit && (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">
                  {preview ? `Version ${preview.version}: ${preview.title}` : "Preview"}
                </CardTitle>
                {preview && (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Said plainly, because the panel now shows text that is NOT
                        what members are reading, and nothing else on the page says
                        so. */}
                    <span className="text-xs text-muted-foreground">
                      Not live. Members are reading version {liveVersion ?? "none"}.
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPreview(null)}
                    >
                      Back to the editor
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                {/* The same component map and plugins the reader uses, so the preview
                    is what a member will see rather than an approximation of it. It
                    used to carry `prose` classes instead, which this repo has no
                    Tailwind typography plugin for, so the preview was unstyled and a
                    table in it rendered as pipes. */}
                <div className="max-w-none text-sm">
                  <ReactMarkdown components={kbMarkdownComponents} remarkPlugins={kbRemarkPlugins}>
                    {(preview ? preview.body_md : body) || "_Nothing to preview yet._"}
                  </ReactMarkdown>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}

/**
 * The link that points at one section of an article.
 *
 * Falls back to the bare fragment while an article is being composed and has no
 * slug yet, which is honest: a `/kb/#grading` with the slug missing is a link
 * that goes to the wrong place, and half a link a manager can see is unfinished
 * is better than a whole one that is wrong.
 */
function anchorPath(slug: string, id: string): string {
  return slug ? `/kb/${slug}#${id}` : `#${id}`;
}

/**
 * What a screen reader is told while something is being dragged.
 *
 * Spelled out rather than left to dnd-kit's defaults, which announce raw ids
 * ("entry:house-rules was moved over droppable area container:belts"). Somebody
 * driving this from the keyboard is getting the whole picture from these
 * sentences, so they say the same things the visible list does.
 */
const announcements = {
  onDragStart: ({ active }: { active: { data: { current?: Record<string, unknown> } } }) =>
    `Picked up ${String(active.data.current?.label ?? "item")}. Use the arrow keys to move it, space to drop it, escape to cancel.`,
  onDragOver: ({
    active,
    over,
  }: {
    active: { data: { current?: Record<string, unknown> } };
    over: { data: { current?: Record<string, unknown> } } | null;
  }) =>
    over
      ? `${String(active.data.current?.label ?? "Item")} is over ${String(over.data.current?.label ?? "another position")}.`
      : `${String(active.data.current?.label ?? "Item")} is not over a droppable position.`,
  onDragEnd: ({
    active,
    over,
  }: {
    active: { data: { current?: Record<string, unknown> } };
    over: { data: { current?: Record<string, unknown> } } | null;
  }) =>
    over
      ? `Dropped ${String(active.data.current?.label ?? "item")} onto ${String(over.data.current?.label ?? "the new position")}.`
      : `Dropped ${String(active.data.current?.label ?? "item")} back where it was.`,
  onDragCancel: ({ active }: { active: { data: { current?: Record<string, unknown> } } }) =>
    `Cancelled. ${String(active.data.current?.label ?? "Item")} is back where it was.`,
};

/**
 * The three-line handle that picks something up.
 *
 * A real focusable button rather than a decorative icon on a draggable row: it
 * is the keyboard's way in, and it keeps the rest of the row a plain click that
 * opens the thing.
 */
function DragHandle({
  label,
  where,
  disabled,
  attributes,
  listeners,
  className,
}: {
  label: string;
  /** "item 2 of 5 in Start here", so the label says where it currently is. */
  where: string;
  disabled: boolean;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  className?: string;
}) {
  return (
    <button
      type="button"
      // The position is part of the label because a screen reader user has no
      // other way to know where the thing they are about to pick up currently
      // sits, and dnd-kit's own instructions assume the app supplies it.
      aria-label={`Reorder ${label}, ${where}`}
      // Held back while a drop's writes are in flight, or space does nothing
      // and says nothing.
      disabled={disabled}
      className={cn(
        "shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40",
        className,
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );
}

/**
 * One section in the reading order: a draggable heading, and a droppable body.
 *
 * The body is a drop target in its own right so an EMPTY section is somewhere an
 * article can be dragged to. Without it a manager can create a section and then
 * have no way to put the first thing in it, which is the same dead end the old
 * "file it with the picker on the left" note was papering over.
 */
function SectionGroup({
  group,
  open,
  disabled,
  dragDisabled,
  sectionIndex,
  sectionCount,
  onOpen,
  children,
}: {
  group: NavGroup;
  open: boolean;
  disabled: boolean;
  dragDisabled: boolean;
  /** 1-based place among the real sections, for the handle's label. */
  sectionIndex: number;
  sectionCount: number;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sectionId(group.slug),
    // "Everything else" is not a section anyone made, so there is nothing to
    // rename, delete, or move: it is always last, holding whatever is filed
    // nowhere.
    disabled: group.slug === "" || dragDisabled,
    data: { type: "section", label: group.title },
  });
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: containerId(group.slug),
    data: { type: "container", label: group.title },
  });

  return (
    <div
      ref={setSortableRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("space-y-1.5", isDragging && "opacity-50")}
    >
      <div className="flex items-center gap-1">
        {group.slug !== "" && (
          <DragHandle
            label={group.title}
            where={`section ${sectionIndex} of ${sectionCount}`}
            disabled={dragDisabled}
            attributes={attributes}
            listeners={listeners}
          />
        )}
        {group.slug === "" ? (
          <span className="flex-1 truncate px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.title}
          </span>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            // Opening a section claims a request token, so it is held back
            // while a load or a drop's writes are in flight, exactly like every
            // entry in the list.
            disabled={disabled}
            aria-current={open}
            className={cn(
              "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60 disabled:hover:bg-transparent",
              open && "bg-muted text-foreground",
            )}
          >
            {group.title}
          </button>
        )}
      </div>

      <div ref={setDroppableRef} className="space-y-1.5">
        {group.entries.length === 0 && (
          <p className="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
            {group.slug === ""
              ? "Anything filed in no section lands here. Drag something in to take it out of every section."
              : "Empty, so members do not see it. Drag an entry in here to fill it."}
          </p>
        )}
        <SortableContext
          items={group.entries.map((entry) => entryId(entry.slug))}
          strategy={verticalListSortingStrategy}
        >
          {children}
        </SortableContext>
      </div>
    </div>
  );
}

/** One entry in the reading order: drag it by the handle, click it to edit it. */
function EntryRow({
  entry,
  row,
  open,
  disabled,
  dragDisabled,
  index,
  count,
  sectionTitle,
  onOpen,
}: {
  entry: KbNavEntry;
  row: ArticleSummary | undefined;
  open: boolean;
  disabled: boolean;
  dragDisabled: boolean;
  /** 1-based place in its section, for the handle's label. */
  index: number;
  count: number;
  sectionTitle: string;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entryId(entry.slug),
    disabled: dragDisabled,
    data: { type: "entry", label: entry.title },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-start gap-1", isDragging && "opacity-50")}
    >
      <DragHandle
        label={entry.title}
        where={`item ${index} of ${count} in ${sectionTitle}`}
        disabled={dragDisabled}
        attributes={attributes}
        listeners={listeners}
        className="mt-1.5"
      />
      <button
        type="button"
        // Disabled while a write is in flight. The request token already makes a
        // late result harmless, but letting the manager switch articles mid-save
        // invites them to watch the screen change under a save they thought
        // applied here. Dragging is deliberately NOT covered by this: a drop
        // commits on its own and does not take the screen away.
        disabled={disabled}
        onClick={onOpen}
        aria-current={open}
        className={cn(
          "disabled:opacity-60",
          "flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-muted",
          open && "border-primary bg-muted",
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-medium">{entry.title}</span>
          {entry.link_path && <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />}
          {row?.visibility === "managers" && (
            <Badge variant="outline" className="shrink-0 px-1 text-[10px]">
              Draft
            </Badge>
          )}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {entry.link_path ?? `/kb/${entry.slug}`}
        </span>
        {!entry.link_path && (
          <span className="text-[11px] text-muted-foreground">
            {row?.version == null
              ? "No published version"
              : `Version ${row.version} of ${row.versions}`}
          </span>
        )}
      </button>
    </div>
  );
}
