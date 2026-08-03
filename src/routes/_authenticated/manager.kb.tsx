// Manager screen for club articles: pick one, edit it, publish it, and read
// the feedback members left on it.
//
// Deliberately the same shape as `/manager/waiver-template` — versions listed
// down the side, "Save as new version" writing a new one, a preview underneath —
// so a manager learns one editor and not two. The differences are the ones the
// feature actually has: several articles rather than one, a visibility setting,
// and a feedback panel.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { ChevronDown, ChevronUp, ExternalLink, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { articleVisibilities, visibilityAudience } from "@/lib/kb";
import type { ArticleVisibility } from "@/lib/kb";
import { buildKbNav, UNSECTIONED_TITLE } from "@/lib/kb-nav";
import type { KbNavSection } from "@/lib/kb-nav";
import {
  isArticleDirty,
  nextPosition,
  reorder,
  slugFromTitle,
  wideningVisibility,
} from "@/lib/kb-editor";
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
 * "In no section", as a Select value.
 *
 * A sentinel rather than "", because the underlying Radix select treats an
 * empty value as "nothing is chosen" and refuses to render an item with one.
 * The wire format is still "", which is what `save_kb_article` reads as "take
 * this out of every section".
 */
const NO_SECTION = "__none__";

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
  const claim = () => ++seq.current;
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
  const liveVersion = versions.find((v) => v.is_current)?.version ?? null;

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
  const structure: KbNavSection[] = useMemo(
    () =>
      buildKbNav(
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
      ),
    [sections, articles],
  );

  /** Everything already filed in a section, for working out where a new entry goes. */
  /**
   * Everything already filed in a section, for working out where a new entry
   * goes.
   *
   * `exclude` leaves an entry out, and which entry that is matters: an article
   * being MOVED must not count its own position among its new neighbours, but
   * an article being CREATED has no position yet and must not knock the open
   * article out of the count — that would propose a position already taken and
   * leave the two tied, resolved by whichever title sorts first.
   */
  const siblingsOf = (sectionSlug: string, exclude?: string) =>
    articles
      .filter((a) => (a.section || "") === sectionSlug && a.slug !== exclude)
      .map((a) => ({ slug: a.slug, position: a.position }));

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  /** Load the lists, and open the first article so the screen is never empty. */
  useEffect(() => {
    Promise.all([fetchArticles(), fetchSections()])
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
      .catch((e) => {
        // A non-manager is redirected by the effect above; anything else is
        // worth saying out loud rather than leaving a blank screen.
        if (!(e instanceof Error) || !e.message.includes("Forbidden")) {
          toast.error(e instanceof Error ? e.message : "Could not load articles");
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchArticles, fetchSections]);

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
    if (!opts.force && !retrying && next === slug && !creating) return;
    if (dirty && !window.confirm("Discard your unsaved changes and open this?")) {
      return;
    }

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

  function startNew(nextKind: EntryKind) {
    const what = nextKind === "link" ? "add a link" : "start a new article";
    if (dirty && !window.confirm(`Discard your unsaved changes and ${what}?`)) return;
    claim();
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
    setFailed({ article: false, versions: false, feedback: false });
  }

  /**
   * Move an entry into a section, and to the end of it.
   *
   * Carrying its old position across would drop it wherever that number happens
   * to land among its new neighbours, which from the manager's side looks like
   * the section select also shuffling the order. The end is the one position
   * that is predictable, and the arrows are two clicks away.
   */
  function onSectionChange(value: string) {
    const nextSection = value === NO_SECTION ? "" : value;
    setSection(nextSection);
    setPosition(nextPosition(siblingsOf(nextSection, creating ? undefined : slug)));
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
          "A link cannot point back into the knowledge base. Use the section and the arrows to order articles.",
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
      !window.confirm(
        `This will change who can read "${title}" from ${widening.from} to ${widening.to}. Everyone in the wider group will be able to read every word of it, including any earlier wording still in the current version. Continue?`,
      )
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
      // The save landed either way, so it is reported. But if the manager has
      // since opened a different article, writing this one's text back into the
      // editor would put the screen out of step with itself.
      if (stale(token)) return;
      setCreating(false);
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
      toast.error(e instanceof Error ? e.message : "Save failed");
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
    if (
      dirty &&
      !window.confirm(
        `Your unsaved changes will be discarded, and they are not part of version ${version.version} so they will not go live. Save them as a new version first, or continue to publish the stored version ${version.version} and lose them?`,
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        `Publish version ${version.version}? ${visibilityAudience[baseVisibility ?? visibility]} will read it from now on. Comments stay attached to the version they were written against.`,
      )
    ) {
      return;
    }
    const token = claim();
    const target = slug;
    setPromoting(true);
    try {
      await promote({ data: { id: version.id } });
      toast.success(`Version ${version.version} is now live`);
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
   * Move an entry up or down inside its section.
   *
   * `reorder` renumbers the section and returns only the rows that moved, so
   * this is normally two placement saves. Placement saves write no version, so
   * reordering the knowledge base never tells a reader an article was updated.
   *
   * The writes are sequential rather than parallel: they are two rows of the
   * same list, and a half-applied pair is much easier to reason about (and to
   * repeat) than two overlapping saves whose order decided the result.
   */
  async function onMoveEntry(
    entries: { slug: string; position: number }[],
    target: string,
    direction: -1 | 1,
  ) {
    const moves = reorder(entries, target, direction);
    if (!moves.length) return;
    const token = claim();
    setBusy(true);
    try {
      for (const move of moves) {
        await save({ data: { slug: move.slug, position: move.position } });
      }
      // The entry on screen is one of the rows that just moved, so its baseline
      // has to move with it or the screen reads as having unsaved changes.
      const mine = moves.find((m) => m.slug === slug);
      if (mine && !stale(token)) {
        setPosition(mine.position);
        setStored((prev) => (prev ? { ...prev, position: mine.position } : prev));
      }
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move that");
    } finally {
      setBusy(false);
    }
  }

  /** Move a whole section up or down the sidebar. */
  async function onMoveSection(target: string, direction: -1 | 1) {
    const moves = reorder(
      structure
        .filter((s) => s.slug !== null)
        .map((s) => ({
          slug: s.slug as string,
          position: sections.find((row) => row.slug === s.slug)?.position ?? 0,
        })),
      target,
      direction,
    );
    if (!moves.length) return;
    const token = claim();
    setBusy(true);
    try {
      for (const move of moves) {
        await saveSection({ data: { slug: move.slug, position: move.position } });
      }
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move that section");
    } finally {
      setBusy(false);
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

  async function onRenameSection(target: SectionRow) {
    const name = window.prompt("What should this section be called?", target.title)?.trim();
    if (!name || name === target.title) return;
    const token = claim();
    setBusy(true);
    try {
      // The slug is NOT changed with the title. It is the handle the agent API
      // and every article's `section` refer to, so renaming a heading must not
      // silently unfile everything in it.
      await saveSection({ data: { slug: target.slug, title: name } });
      await refreshStructure(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename that section");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSection(target: SectionRow) {
    const inside = articles.filter((a) => a.section === target.slug).length;
    if (
      !window.confirm(
        inside
          ? `Delete the section "${target.title}"? The ${inside} entr${inside === 1 ? "y" : "ies"} in it are kept, and drop to the "Everything else" group at the bottom of the sidebar until you file them somewhere.`
          : `Delete the section "${target.title}"?`,
      )
    ) {
      return;
    }
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

  if (loading) return <div className="p-8">Loading...</div>;

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
            disabled={saving || promoting || busy}
            onClick={() => startNew("article")}
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
            disabled={saving || promoting || busy}
            onClick={() => startNew("link")}
          >
            <Link2 className="mr-1.5 h-4 w-4" />
            New link
          </Button>
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
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
                A sidebar entry pointing at a page this site already has, so the club keeps one copy
                of it rather than two. It reads in order with everything else, it holds no text of
                its own, and it takes no comments.
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
                  A path on this site, e.g. /first-class or /faq. Not a full web address, and not
                  another /kb page: order those with the section and the arrows instead.
                </p>
              </div>
              {stored?.link_path && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving || busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Turn this link into an article? It keeps its place in the reading order, and you write its text here. The link is only replaced when you save.",
                      )
                    ) {
                      return;
                    }
                    setKind("article");
                    setLinkPath("");
                  }}
                >
                  Turn this into an article
                </Button>
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
                <Textarea
                  id="body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={22}
                  className="mt-1.5 font-mono text-sm"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Members comment paragraph by paragraph. Editing the words of a paragraph detaches
                  its comments, which are then shown as being about earlier wording. Adding or
                  moving paragraphs elsewhere leaves other comments where they are.
                </p>
              </div>
            </>
          )}

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
              </>
            )}

            {/* Where it sits in the reading order. This is the part members
                actually experience: the sidebar, the index page and the
                previous/next links all come from the section and the position,
                so it is one thing to maintain rather than three. */}
            <div>
              <Label htmlFor="section">Section</Label>
              <Select value={section || NO_SECTION} onValueChange={onSectionChange}>
                <SelectTrigger id="section" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sections.map((s) => (
                    <SelectItem key={s.slug} value={s.slug}>
                      {s.title}
                    </SelectItem>
                  ))}
                  <SelectItem value={NO_SECTION}>{UNSECTIONED_TITLE}</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Moving it puts it at the end of that section. Use the arrows in the list to place
                it.
              </p>
            </div>

            {kind === "article" && (
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
                  For when the title is long: "Syllabus" in the sidebar, the full heading on the
                  page. Blank uses the title.
                </p>
              </div>
            )}
            {kind === "article" && (
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
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={onSave}
              disabled={
                saving ||
                promoting ||
                busy ||
                (kind === "link" ? !navTitle || !linkPath : !title || !body)
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
            {busy && <span className="text-xs text-muted-foreground">Loading...</span>}
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
        </div>

        <aside className="space-y-4">
          {/* The sidebar a member sees, editable in place.
              Deliberately NOT a flat alphabetical list beside a separate
              "order" panel: the order IS the product, so the list a manager
              picks an article from should be the one they can see is wrong. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reading order</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                What a new member reads, top to bottom. The arrows move an entry within its section;
                the section select on the left moves it between them.
              </p>

              {articles.length === 0 && sections.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing here yet. Create the first article.
                </p>
              )}

              {structure.map((group) => {
                const sectionRow = sections.find((s) => s.slug === group.slug) ?? null;
                const orderableSections = structure.filter((s) => s.slug !== null);
                const sectionIndex = orderableSections.findIndex((s) => s.slug === group.slug);
                return (
                  <div key={group.slug ?? "unsectioned"} className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <span className="flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.title}
                      </span>
                      {sectionRow && (
                        <>
                          <MoveButtons
                            label={group.title}
                            disabled={saving || promoting || busy}
                            canUp={sectionIndex > 0}
                            canDown={sectionIndex < orderableSections.length - 1}
                            onMove={(direction) => void onMoveSection(sectionRow.slug, direction)}
                          />
                          <button
                            type="button"
                            aria-label={`Rename ${group.title}`}
                            disabled={saving || promoting || busy}
                            onClick={() => void onRenameSection(sectionRow)}
                            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${group.title}`}
                            disabled={saving || promoting || busy}
                            onClick={() => void onDeleteSection(sectionRow)}
                            className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-40"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>

                    {group.entries.length === 0 && (
                      <p className="px-2.5 text-xs text-muted-foreground">
                        Empty, so members do not see it. File something into it with the section
                        picker on the left.
                      </p>
                    )}

                    {group.entries.map((entry, index) => {
                      const row = articles.find((a) => a.slug === entry.slug);
                      const open = entry.slug === slug && !creating;
                      return (
                        <div key={entry.slug} className="flex items-start gap-1">
                          <button
                            type="button"
                            // Disabled while a write is in flight. The request
                            // token already makes a late result harmless, but
                            // letting the manager switch articles mid-save
                            // invites them to watch the screen change under a
                            // save they thought applied here.
                            disabled={saving || promoting || busy}
                            onClick={() => void openDocument(entry.slug)}
                            aria-current={open}
                            className={cn(
                              "disabled:opacity-60",
                              "flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-muted",
                              open && "border-primary bg-muted",
                            )}
                          >
                            <span className="flex items-center gap-1.5">
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {entry.title}
                              </span>
                              {entry.link_path && (
                                <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                              )}
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
                          <MoveButtons
                            label={entry.title}
                            disabled={saving || promoting || busy}
                            canUp={index > 0}
                            canDown={index < group.entries.length - 1}
                            onMove={(direction) =>
                              void onMoveEntry(group.entries, entry.slug, direction)
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}

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
                    disabled={saving || promoting || busy || !newSectionTitle.trim()}
                    onClick={() => void onAddSection()}
                  >
                    Add
                  </Button>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  A section with nothing in it is not shown to members.
                </p>
              </div>
            </CardContent>
          </Card>

          {!creating && failed.versions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Versions</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Not "no versions". An empty list here would say this
                    article has no history, which is a confident wrong answer
                    about the one panel that can undo an edit. */}
                <p className="text-sm text-muted-foreground">
                  The version list could not be loaded. Click this article in the list above to try
                  again.
                </p>
              </CardContent>
            </Card>
          )}

          {!creating && !failed.versions && versions.length > 0 && (
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

          {!creating && (
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
                    article in the list above to try again.
                  </p>
                ) : feedback.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open comments.</p>
                ) : (
                  feedback.map((f) => (
                    <div key={f.id} className="rounded-md bg-muted/50 p-3 text-sm">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {f.author ?? "Someone at the club"}
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
        </aside>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {preview ? `Version ${preview.version}: ${preview.title}` : "Preview"}
          </CardTitle>
          {preview && (
            <div className="flex items-center gap-2">
              {/* Said plainly, because the panel now shows text that is NOT
                  what members are reading, and nothing else on the page says
                  so. */}
              <span className="text-xs text-muted-foreground">
                Not live. Members are reading version {liveVersion ?? "none"}.
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => setPreview(null)}>
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
    </section>
  );
}

/**
 * The up/down pair, next to a section or an entry.
 *
 * One component for both so the two never drift apart, and because the end of a
 * list is the case worth getting right: an arrow that is disabled says "this is
 * already the first thing a member reads", where one that silently does nothing
 * leaves a manager clicking it.
 */
function MoveButtons({
  label,
  disabled,
  canUp,
  canDown,
  onMove,
}: {
  label: string;
  disabled: boolean;
  canUp: boolean;
  canDown: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <span className="flex shrink-0 flex-col">
      <button
        type="button"
        aria-label={`Move ${label} up`}
        disabled={disabled || !canUp}
        onClick={() => onMove(-1)}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Move ${label} down`}
        disabled={disabled || !canDown}
        onClick={() => onMove(1)}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
