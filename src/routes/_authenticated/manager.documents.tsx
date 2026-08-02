// Manager screen for club documents: pick one, edit it, publish it, and read
// the feedback members left on it.
//
// Deliberately the same shape as `/manager/waiver-template` — versions listed
// down the side, "Save as new version" writing a new one, a preview underneath —
// so a manager learns one editor and not two. The differences are the ones the
// feature actually has: several documents rather than one, a visibility setting,
// and a feedback panel.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { Plus } from "lucide-react";
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
  getManagerDocument,
  listDocumentVersions,
  listManagerAnnotations,
  listManagerDocuments,
  saveManagerDocument,
  setCurrentDocumentVersion,
} from "@/lib/documents.functions";
import { documentVisibilities, visibilityAudience } from "@/lib/documents";
import type { DocumentVisibility } from "@/lib/documents";
import { isDocumentDirty, slugFromTitle, wideningVisibility } from "@/lib/document-editor";
import { versionLabel } from "@/lib/waiver-template-editor";
import { formatDate } from "@/lib/dates";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/manager/documents")({
  head: () => ({
    meta: [{ title: "Documents | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: DocumentsManager,
});

type DocumentSummary = Awaited<ReturnType<typeof listManagerDocuments>>[number];
type VersionRow = Awaited<ReturnType<typeof listDocumentVersions>>[number];
type Feedback = Awaited<ReturnType<typeof listManagerAnnotations>>[number];

// No em dashes: AGENTS.md bans them in user-facing copy, and that covers the
// manager pages, not just the public site.
const VISIBILITY_LABEL: Record<DocumentVisibility, string> = {
  public: "Public (anyone, signed in or not)",
  members: "Members (any signed-in person)",
  managers: "Managers only (drafts and internal notes)",
};

/** Mirrors the `documents.slug` CHECK, so a bad key is caught before the server. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function DocumentsManager() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  const fetchDocuments = useServerFn(listManagerDocuments);
  const fetchDocument = useServerFn(getManagerDocument);
  const fetchVersions = useServerFn(listDocumentVersions);
  const fetchFeedback = useServerFn(listManagerAnnotations);
  const save = useServerFn(saveManagerDocument);
  const promote = useServerFn(setCurrentDocumentVersion);

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);

  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<DocumentVisibility>("members");
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true);
  const [changeNote, setChangeNote] = useState("");
  /** The version as stored, to compare the editor against. */
  const [stored, setStored] = useState<{
    title: string;
    body_md: string;
    visibility: DocumentVisibility;
    annotations_enabled: boolean;
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
   * The visibility this document is stored with, which is NOT the same thing as
   * `stored?.visibility`.
   *
   * `stored` is the loaded VERSION, and it is null whenever that load failed.
   * Visibility lives on the document, so it is still known then (the sidebar
   * list carries it), and it has to be: `wideningVisibility` consults this, and
   * a null baseline silently skips the prompt. Reading them off the same object
   * meant a document whose version failed to load kept the PREVIOUS document's
   * visibility in the select, and the next save published a managers-only draft
   * to members with nothing asked and nothing shown.
   */
  const [baseVisibility, setBaseVisibility] = useState<DocumentVisibility | null>(null);

  /**
   * What could not be loaded for the document on screen. Panels say so instead
   * of rendering an empty list, which reads as "there is nothing here" — a
   * confident wrong answer on the panel a manager uses to decide whether members'
   * feedback has been dealt with.
   */
  const [failed, setFailed] = useState<{ document: boolean; versions: boolean; feedback: boolean }>(
    { document: false, versions: false, feedback: false },
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * Which request is allowed to write to state.
   *
   * Every load, save and publish takes a token before it starts and drops its
   * results if a newer one has started since. Without this, a slow save landing
   * after a fast document open writes the SAVED document's title, body and
   * baseline over the one now on screen: `slug` says one document, the editor
   * shows another, and the next save publishes the wrong text. The requests are
   * several sequential round trips server-side, so the overtaking is ordinary,
   * not a stress case.
   */
  const seq = useRef(0);
  const claim = () => ++seq.current;
  const stale = (token: number) => seq.current !== token;

  const dirty = isDocumentDirty(
    { title, body_md: body, visibility, annotations_enabled: annotationsEnabled },
    stored,
  );
  const liveVersion = versions.find((v) => v.is_current)?.version ?? null;

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  /** Load the list, and open the first document so the screen is never empty. */
  useEffect(() => {
    fetchDocuments()
      .then((rows) => {
        setDocuments(rows);
        if (rows[0]) void openDocument(rows[0].slug);
      })
      .catch((e) => {
        // A non-manager is redirected by the effect above; anything else is
        // worth saying out loud rather than leaving a blank screen.
        if (!(e instanceof Error) || !e.message.includes("Forbidden")) {
          toast.error(e instanceof Error ? e.message : "Could not load documents");
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchDocuments]);

  async function openDocument(next: string, opts: { force?: boolean } = {}) {
    // Clicking the document already open is a no-op, UNLESS its last load
    // failed: then the click is a retry, and swallowing it leaves the only
    // way out of that state a page reload.
    const retrying = next === slug && !creating && (failed.document || failed.versions);
    if (!opts.force && !retrying && next === slug && !creating) return;
    if (dirty && !window.confirm("Discard your unsaved changes and open this?")) {
      return;
    }
    const token = claim();
    setBusy(true);
    try {
      // `allSettled`, not `all`: a document left with no published version makes
      // the document read throw, and `all` would then discard the version list
      // too — leaving the one screen that could repair it with nothing to show.
      const [docRes, vsRes, fbRes] = await Promise.allSettled([
        fetchDocument({ data: { slug: next } }),
        fetchVersions({ data: { slug: next } }),
        fetchFeedback({ data: { slug: next } }),
      ]);
      // A newer click won while these were in flight. Dropping the results is
      // the whole point: applying them would leave `slug` pointing at one
      // document and the editor showing another, and the next save would write
      // this document's text into that one.
      if (stale(token)) return;

      setCreating(false);
      setSlug(next);
      setChangeNote("");
      setPreview(null);
      setVersions(vsRes.status === "fulfilled" ? vsRes.value : []);
      setFeedback(fbRes.status === "fulfilled" ? fbRes.value : []);
      setFailed({
        document: docRes.status === "rejected",
        versions: vsRes.status === "rejected",
        feedback: fbRes.status === "rejected",
      });

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
        });
      } else {
        // The version could not be read. Show an empty editor over the real
        // version list so the manager can publish one of them.
        //
        // Visibility comes from the SIDEBAR row, not from the failed read, and
        // never from whatever was on screen a moment ago. Leaving the previous
        // document's setting here is how a managers-only draft got republished
        // to members by a manager who did exactly what the toast told them to.
        const summary = documents.find((d) => d.slug === next);
        setTitle("");
        setBody("");
        setStored(null);
        // Nothing is known about this document's settings, so refuse to guess.
        // A null baseline makes `onSave` stop rather than send one.
        setBaseVisibility(summary?.visibility ?? null);
        if (summary) {
          setVisibility(summary.visibility);
          setAnnotationsEnabled(summary.annotations_enabled);
        }
        // The reason matters: "no published version" invites the manager to
        // write one, and saying it about a transient failure invites them to
        // retype a document that is perfectly fine.
        const why = docRes.reason;
        toast.warning(
          why instanceof Error && !/no such document/i.test(why.message)
            ? `"${next}" could not be opened: ${why.message}`
            : `"${next}" has no published version. Publish one from the version list, or write a new one.`,
        );
      }
    } finally {
      if (!stale(token)) setBusy(false);
    }
  }

  function startNew() {
    if (dirty && !window.confirm("Discard your unsaved changes and start a new document?")) return;
    setCreating(true);
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
    setFailed({ document: false, versions: false, feedback: false });
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
    const targetSlug = (creating ? slug || slugFromTitle(title) : slug).trim();
    if (!targetSlug) {
      toast.error("Give the document a URL key, e.g. house-rules.");
      return;
    }
    // Check the key here rather than letting the server reject it: a hand-typed
    // "House Rules" would otherwise come back as a raw validation dump.
    if (!SLUG_PATTERN.test(targetSlug) || targetSlug.length > 100) {
      toast.error("A URL key can only use lowercase letters, numbers and single hyphens.");
      return;
    }

    // Creating a document whose slug already exists is not a create — the
    // server treats a known slug as "add a version to it". Left unchecked, a
    // manager typing the title of an existing managers-only draft would replace
    // its live text AND, because the form always sends a visibility, publish it
    // to everyone. Refuse here for a message that points at the list; the save
    // also carries `expect_new`, so the database refuses it too when this list
    // is a stale snapshot and somebody else took the key in the meantime.
    if (creating && documents.some((d) => d.slug === targetSlug)) {
      toast.error(
        `A document already exists at /docs/${targetSlug}. Open it from the list to add a version.`,
      );
      return;
    }

    // Saving an existing document whose settings never loaded would send a
    // visibility that was never read off it. Stop instead of guessing: the
    // widening prompt below cannot fire without a baseline, so this would be the
    // one save that changes who can read a document with nothing asked.
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
      const res = await save({
        data: {
          slug: targetSlug,
          title,
          body_md: body,
          visibility,
          annotations_enabled: annotationsEnabled,
          change_note: changeNote,
          expect_new: creating,
        },
      });
      // Report the save the moment it succeeds. Refreshing the lists is a second
      // round trip, and reporting after it announced a successful save as a
      // failure — whereupon the obvious response, saving again, files a
      // duplicate version. (Same trap as the waiver template editor.)
      toast.success(
        res.created
          ? `Created "${targetSlug}" and published version ${res.version}`
          : `Saved version ${res.version}, now live`,
      );
      // The save landed either way, so it is reported. But if the manager has
      // since opened a different document, writing this one's text back into the
      // editor would put the screen out of step with itself.
      if (stale(token)) return;
      setCreating(false);
      setSlug(targetSlug);
      setChangeNote("");
      setBaseVisibility(visibility);
      setFailed({ document: false, versions: false, feedback: false });
      setStored({
        title,
        body_md: body,
        visibility,
        annotations_enabled: annotationsEnabled,
      });
      try {
        const [rows, vs] = await Promise.all([
          fetchDocuments(),
          fetchVersions({ data: { slug: targetSlug } }),
        ]);
        if (stale(token)) return;
        setDocuments(rows);
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
      // failed publish would tell the manager the club's live document is
      // something it is not, so the refresh gets its own try. (`onSave` learned
      // this first.)
      try {
        const [vs, doc, rows] = await Promise.all([
          fetchVersions({ data: { slug: target } }),
          fetchDocument({ data: { slug: target } }),
          fetchDocuments(),
        ]);
        if (stale(token)) return;
        setVersions(vs);
        setDocuments(rows);
        setChangeNote("");
        setPreview(null);
        setTitle(doc.title);
        setBody(doc.body_md);
        setVisibility(doc.visibility);
        setAnnotationsEnabled(doc.annotations_enabled);
        setBaseVisibility(doc.visibility);
        setFailed({ document: false, versions: false, feedback: false });
        setStored({
          title: doc.title,
          body_md: doc.body_md,
          visibility: doc.visibility,
          annotations_enabled: doc.annotations_enabled,
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

  const proposedSlug = useMemo(() => slugFromTitle(title), [title]);

  if (loading) return <div className="p-8">Loading...</div>;

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Pages members read and comment on at /docs. Saving creates a new version and publishes
            it. Past versions stay, and comments stay attached to the version they were written
            against.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={saving || promoting || busy}
            onClick={startNew}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New document
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
                The permanent address: /docs/{slug || proposedSlug || "house-rules"}. Lowercase
                letters, numbers and single hyphens. Leave it blank to use the title.
              </p>
            </div>
          )}

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
              Members comment paragraph by paragraph. Editing the words of a paragraph detaches its
              comments, which are then shown as being about earlier wording. Adding or moving
              paragraphs elsewhere leaves other comments where they are.
            </p>
          </div>

          <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="visibility">Who can read it</Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as DocumentVisibility)}
              >
                <SelectTrigger id="visibility" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {documentVisibilities.map((v) => (
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
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={onSave} disabled={saving || promoting || busy || !title || !body}>
              {saving ? "Saving..." : creating ? "Create and publish" : "Save as new version"}
            </Button>
            {busy && <span className="text-xs text-muted-foreground">Loading...</span>}
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No documents yet. Create the first one.
                </p>
              ) : (
                documents.map((d) => (
                  <button
                    key={d.slug}
                    type="button"
                    // Disabled while a write is in flight. The request token
                    // already makes a late result harmless, but letting the
                    // manager switch documents mid-save invites them to watch
                    // the screen change under a save they thought applied here.
                    disabled={saving || promoting || busy}
                    onClick={() => void openDocument(d.slug)}
                    aria-current={d.slug === slug && !creating}
                    className={cn(
                      "disabled:opacity-60",
                      "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted",
                      d.slug === slug && !creating && "border-primary bg-muted",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{d.title ?? d.slug}</span>
                      <Badge variant="outline">{d.visibility}</Badge>
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">/docs/{d.slug}</span>
                    <span className="text-xs text-muted-foreground">
                      {d.version === null
                        ? "No published version"
                        : `Version ${d.version} of ${d.versions}`}
                    </span>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          {!creating && failed.versions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Versions</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Not "no versions". An empty list here would say this
                    document has no history, which is a confident wrong answer
                    about the one panel that can undo an edit. */}
                <p className="text-sm text-muted-foreground">
                  The version list could not be loaded. Click this document in the list above to try
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
                    document in the list above to try again.
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
                        <span>v{f.document_version}</span>
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
                    <Link to="/docs/$slug" params={{ slug }}>
                      Open the document to reply
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
          <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-bold prose-headings:text-foreground prose-p:leading-relaxed prose-strong:text-foreground">
            <ReactMarkdown>
              {(preview ? preview.body_md : body) || "_Nothing to preview yet._"}
            </ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
