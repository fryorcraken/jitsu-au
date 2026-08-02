// Manager screen for club documents: pick one, edit it, publish it, and read
// the feedback members left on it.
//
// Deliberately the same shape as `/manager/waiver-template` — versions listed
// down the side, "Save as new version" writing a new one, a preview underneath —
// so a manager learns one editor and not two. The differences are the ones the
// feature actually has: several documents rather than one, a visibility setting,
// and a feedback panel.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { documentVisibilities } from "@/lib/documents";
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

const VISIBILITY_LABEL: Record<DocumentVisibility, string> = {
  public: "Public — anyone, signed in or not",
  members: "Members — any signed-in person",
  managers: "Managers only — drafts and internal notes",
};

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

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);

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

  async function openDocument(next: string) {
    if (next === slug && !creating) return;
    if ((dirty || creating) && !window.confirm("Discard your unsaved changes and open this?")) {
      return;
    }
    try {
      const [doc, vs, fb] = await Promise.all([
        fetchDocument({ data: { slug: next } }),
        fetchVersions({ data: { slug: next } }),
        fetchFeedback({ data: { slug: next } }),
      ]);
      setCreating(false);
      setSlug(next);
      setTitle(doc.title);
      setBody(doc.body_md);
      setVisibility(doc.visibility);
      setAnnotationsEnabled(doc.annotations_enabled);
      setChangeNote("");
      setStored({
        title: doc.title,
        body_md: doc.body_md,
        visibility: doc.visibility,
        annotations_enabled: doc.annotations_enabled,
      });
      setVersions(vs);
      setFeedback(fb);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open that document");
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
    setVersions([]);
    setFeedback([]);
  }

  async function onSave() {
    const targetSlug = (creating ? slug || slugFromTitle(title) : slug).trim();
    if (!targetSlug) {
      toast.error("Give the document a URL key, e.g. house-rules.");
      return;
    }

    // Widening is the one save worth stopping for: it publishes text to people
    // who could not read it a moment ago. Narrowing is recoverable, so it goes
    // through without a prompt.
    const widening = wideningVisibility(stored?.visibility ?? null, visibility);
    if (
      widening &&
      !window.confirm(
        `This will change who can read "${title}" from ${widening.from} to ${widening.to}. Everyone in the wider group will be able to read every word of it, including any earlier wording still in the current version. Continue?`,
      )
    ) {
      return;
    }

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
      setCreating(false);
      setSlug(targetSlug);
      setChangeNote("");
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
        setDocuments(rows);
        setVersions(vs);
      } catch {
        toast.warning("Saved. The version list could not be refreshed, so reload to see it.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
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
        `Your unsaved changes are not part of version ${version.version} and will not go live. Save them as a new version first, or continue to publish the stored version ${version.version}?`,
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        `Publish version ${version.version}? Members will read it from now on. Comments stay attached to the version they were written against.`,
      )
    ) {
      return;
    }
    setPromoting(true);
    try {
      await promote({ data: { id: version.id } });
      toast.success(`Version ${version.version} is now live`);
      const [vs, doc] = await Promise.all([
        fetchVersions({ data: { slug } }),
        fetchDocument({ data: { slug } }),
      ]);
      setVersions(vs);
      setTitle(doc.title);
      setBody(doc.body_md);
      setStored({
        title: doc.title,
        body_md: doc.body_md,
        visibility: doc.visibility,
        annotations_enabled: doc.annotations_enabled,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the live version");
    } finally {
      setPromoting(false);
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
          <Button type="button" variant="outline" onClick={startNew}>
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
          {creating && (
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
            <Button onClick={onSave} disabled={saving || !title || !body}>
              {saving ? "Saving..." : creating ? "Create and publish" : "Save as new version"}
            </Button>
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
                    onClick={() => void openDocument(d.slug)}
                    aria-current={d.slug === slug && !creating}
                    className={cn(
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

          {!creating && versions.length > 0 && (
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
                    {v.is_current ? (
                      <Badge>Live</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={promoting}
                        onClick={() => void onPromote(v)}
                      >
                        {versionLabel(v, liveVersion) === "Previous" ? "Restore" : "Publish"}
                      </Button>
                    )}
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
                <p className="text-xs text-muted-foreground">
                  Open comment threads members left. Private notes are never shown here, or anywhere
                  else.
                </p>
                {feedback.length === 0 ? (
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
        <CardHeader>
          <CardTitle className="text-base">Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-bold prose-headings:text-foreground prose-p:leading-relaxed prose-strong:text-foreground">
            <ReactMarkdown>{body || "_Nothing to preview yet._"}</ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
