// The manager's syllabus: what each belt asks of each topic, the belts, and
// the topics.
//
// Written for a manager between classes, often on a phone, so the writing tab
// is one column of boxes: one belt's every topic, or one topic across every
// belt (the second is how a progression, breakfalling from yellow to brown, is
// kept coherent). A save sends only the boxes that changed, and each belt page
// they touch is republished once, so a session of edits is one new version of
// a page rather than one per box. See docs/syllabus.md.
//
// The same functions as the agent API (`syllabus-admin.ts`), so a manager's
// save and an agent's are the same write.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loading } from "@/components/site/Loading";
import { LoadFailure } from "@/components/site/LoadFailure";
import { SaveFailure } from "@/components/site/SaveFailure";
import { ActionFailure } from "@/components/site/ActionFailure";
import { DraftRestoreBanner } from "@/components/site/DraftRestoreBanner";
import { MarkdownEditor } from "@/components/site/MarkdownEditor";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { useEditorDraft } from "@/hooks/use-editor-draft";
import { discardUnsavedChanges, useConfirm } from "@/hooks/use-confirm";
import { useInvalidateKbReader } from "@/hooks/useKbArticle";
import { describeLoadError } from "@/lib/load-error";
import { slugFromTitle } from "@/lib/kb-editor";
import { saveManagerArticle } from "@/lib/kb.functions";
import {
  beltPageTitle,
  flattenTopics,
  orderBelts,
  tidyBlock,
  topicTree,
  type SyllabusBelt,
  type SyllabusData,
} from "@/lib/syllabus";
import {
  cellProblems,
  changedEntries,
  editorCells,
  movedPosition,
  type EditorMode,
} from "@/lib/syllabus-editor";
import {
  deleteManagerBelt,
  deleteManagerSyllabusTopic,
  getManagerSyllabus,
  saveManagerBelt,
  saveManagerSyllabusEntries,
  saveManagerSyllabusTopic,
} from "@/lib/syllabus.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/manager/syllabus")({
  head: () => ({
    meta: [{ title: "Syllabus | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SyllabusManager,
});

const errorText = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

function SyllabusManager() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchSyllabus = useServerFn(getManagerSyllabus);
  const invalidateKbReader = useInvalidateKbReader();
  const { confirm, confirmDialog } = useConfirm();

  const [data, setData] = useState<SyllabusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) void navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchSyllabus());
      setLoadError(null);
    } catch (e) {
      setLoadError(describeLoadError(e, "Could not load the syllabus"));
    } finally {
      setLoading(false);
    }
  }, [fetchSyllabus]);

  useEffect(() => {
    if (isManager) void load();
  }, [isManager, load]);

  /** After any write: what members read has changed, and so has this screen. */
  const afterWrite = useCallback(async () => {
    invalidateKbReader();
    await load();
  }, [invalidateKbReader, load]);

  return (
    <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-black">Syllabus</h1>
        <p className="text-muted-foreground">
          What each belt asks of each topic. Every belt&apos;s page in the knowledge base is put
          together from this, and members can read it{" "}
          <Link to="/kb/syllabus" className="underline underline-offset-4">
            by topic, up to any belt
          </Link>
          .
        </p>
      </header>

      {loading && !data ? (
        <Loading label="Loading the syllabus" />
      ) : !data ? (
        // In place of the whole screen, not beside it: an empty editor over a
        // failed load invites typing a belt's syllabus in from scratch over
        // text that is really there.
        <LoadFailure
          what="The syllabus"
          message={loadError ?? undefined}
          hint="This is not the same as it being empty, so do not start writing it again from here."
          onRetry={() => void load()}
        />
      ) : (
        <Tabs defaultValue="write">
          <TabsList>
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="belts">Belts</TabsTrigger>
            <TabsTrigger value="topics">Topics</TabsTrigger>
          </TabsList>
          {/* Kept mounted while another tab is open: Radix unmounts inactive
              tabs, which threw away whatever was typed in the boxes the
              moment a manager glanced at the Belts tab. */}
          <TabsContent value="write" forceMount className="pt-4 data-[state=inactive]:hidden">
            <WriteTab data={data} confirm={confirm} onSaved={afterWrite} />
          </TabsContent>
          <TabsContent value="belts" className="pt-4">
            <BeltsTab data={data} confirm={confirm} onSaved={afterWrite} />
          </TabsContent>
          <TabsContent value="topics" className="pt-4">
            <TopicsTab data={data} confirm={confirm} onSaved={afterWrite} />
          </TabsContent>
        </Tabs>
      )}
      {confirmDialog}
    </section>
  );
}

type Confirm = ReturnType<typeof useConfirm>["confirm"];
type TabProps = { data: SyllabusData; confirm: Confirm; onSaved: () => Promise<void> };

// ---- Write ----

function WriteTab({ data, confirm, onSaved }: TabProps) {
  const { user } = useAuth();
  const save = useServerFn(saveManagerSyllabusEntries);
  const belts = useMemo(() => orderBelts(data.belts), [data.belts]);
  const tree = useMemo(() => topicTree(data.topics), [data.topics]);
  const topics = useMemo(() => flattenTopics(tree), [tree]);

  const [mode, setMode] = useState<EditorMode>("belt");
  // The first belt that has a page, which is the one most likely to be edited;
  // white has none.
  const [selection, setSelection] = useState(
    () => belts.find((b) => b.page_slug)?.slug ?? belts[0]?.slug ?? "",
  );
  const cells = useMemo(() => editorCells(data, mode, selection), [data, mode, selection]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [changeNote, setChangeNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // What is saved, per box. The editor holds edits on top of it, so a reload
  // after somebody else's save shows their text in every box not being edited.
  const baseline = useMemo(() => Object.fromEntries(cells.map((c) => [c.key, c.stored])), [cells]);
  const current = useMemo(() => ({ ...baseline, ...values }), [baseline, values]);
  const changed = useMemo(() => changedEntries(cells, current), [cells, current]);
  const problems = useMemo(() => cellProblems(cells, current), [cells, current]);

  // Compared the way a save compares (`tidyBlock`), so a stray trailing
  // newline is not unsaved work here when Save says there is nothing to save.
  const tidy = (fields: Record<string, string>) =>
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, tidyBlock(v)]));
  const draftValue = useMemo(() => tidy(current), [current]);
  const draftBaseline = useMemo(() => tidy(baseline), [baseline]);
  const draft = useEditorDraft<Record<string, string>>({
    kind: "syllabus",
    scope: `${mode}:${selection}`,
    owner: user?.id ?? null,
    value: draftValue,
    baseline: draftBaseline,
    shape: Object.fromEntries(cells.map((c) => [c.key, ""])),
    enabled: cells.length > 0,
  });

  useEffect(() => setSaveError(null), [values]);

  async function choose(nextMode: EditorMode, nextSelection: string) {
    if (changed.length && !(await confirm(discardUnsavedChanges("Switching to another one")))) {
      return;
    }
    setMode(nextMode);
    setSelection(nextSelection);
    setValues({});
    setChangeNote("");
    setSaveError(null);
  }

  async function onSave() {
    if (!changed.length || problems.size) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await save({ data: { entries: changed, change_note: changeNote.trim() } });
      const published = res.pages.filter((p) => p.version !== null);
      toast.success(
        published.length
          ? `Saved. Updated ${published.map((p) => p.page).join(", ")}.`
          : "Saved. The belt pages already said this.",
      );
      if (res.pages.some((p) => p.created)) {
        toast.info(
          "A new belt page was made as a draft, for managers only. Open it to members on the Belts tab when it is ready.",
        );
      }
      draft.clear();
      // Reload BEFORE letting go of the edits: cleared first, every box showed
      // the old stored text until the reload landed, and stayed that way if it
      // failed, as if the save had not happened.
      await onSaved();
      setValues({});
      setChangeNote("");
    } catch (e) {
      // Not a toast: the boxes look exactly as they would after a save, and a
      // manager who glanced away would walk off believing it was filed.
      setSaveError(errorText(e, "Could not save the syllabus."));
    } finally {
      setSaving(false);
    }
  }

  const selectionLabel =
    mode === "belt"
      ? (belts.find((b) => b.slug === selection) ?? null)
      : (topics.find((t) => t.slug === selection) ?? null);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-[auto_1fr]">
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Edit</legend>
          <div className="flex gap-1" role="radiogroup" aria-label="Edit by">
            {(["belt", "topic"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                role="radio"
                aria-checked={mode === m}
                variant={mode === m ? "default" : "outline"}
                onClick={() =>
                  mode !== m &&
                  void choose(
                    m,
                    m === "belt"
                      ? (belts.find((b) => b.page_slug)?.slug ?? belts[0]?.slug ?? "")
                      : (topics[0]?.slug ?? ""),
                  )
                }
              >
                {m === "belt" ? "One belt" : "One topic"}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="syllabus-selection">{mode === "belt" ? "Belt" : "Topic"}</Label>
          <select
            id="syllabus-selection"
            value={selection}
            onChange={(e) => void choose(mode, e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-base"
          >
            {mode === "belt"
              ? belts.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {beltPageTitle(b)}
                  </option>
                ))
              : topics.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.parent
                      ? `${tree.find((r) => r.slug === t.parent)?.title}: ${t.title}`
                      : t.title}
                  </option>
                ))}
          </select>
        </div>
      </div>

      {mode === "belt" && selectionLabel && "page_slug" in selectionLabel && (
        <BeltPageStatus belt={selectionLabel} />
      )}

      {draft.offered && (
        <DraftRestoreBanner
          what="syllabus"
          savedAt={draft.offeredAt}
          onRestore={() => {
            const offered = draft.offered;
            if (!offered) return;
            setValues(Object.fromEntries(Object.entries(offered).filter(([k]) => k in baseline)));
            draft.restore();
          }}
          onDiscard={draft.discard}
        />
      )}

      {cells.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          {mode === "belt"
            ? "There are no belts yet. Add one on the Belts tab."
            : "There are no topics yet. Add one on the Topics tab."}
        </p>
      ) : (
        <div className="space-y-4">
          {cells.map((cell) => {
            const value = current[cell.key] ?? "";
            const isChanged = tidyBlock(value) !== tidyBlock(cell.stored);
            const problem = problems.get(cell.key);
            return (
              <div key={cell.key} className={cn("space-y-1.5", cell.depth === 3 && "pl-4 sm:pl-8")}>
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor={`cell-${cell.key}`}
                    className={cell.depth === 2 ? "text-base font-semibold" : "font-medium"}
                  >
                    {cell.label}
                  </Label>
                  {isChanged && <Badge variant="outline">Changed</Badge>}
                  {!value.trim() && !isChanged && (
                    <span className="text-xs text-muted-foreground">Nothing yet, so not shown</span>
                  )}
                </div>
                <MarkdownEditor
                  id={`cell-${cell.key}`}
                  value={value}
                  onChange={(next) => setValues((prev) => ({ ...prev, [cell.key]: next }))}
                  rows={Math.min(12, Math.max(3, value.split("\n").length + 1))}
                  aria-describedby={problem ? `cell-${cell.key}-problem` : undefined}
                />
                {problem && (
                  <p id={`cell-${cell.key}-problem`} className="text-sm text-destructive">
                    {problem}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {saveError && (
        <SaveFailure
          what="syllabus"
          message={saveError}
          retrying={saving}
          onRetry={() => void onSave()}
        />
      )}

      {/* Pinned to the bottom of the screen only once there is something to
          save: on a phone it is a fair slice of the screen, and while nothing
          has changed it would only cover the boxes being read. */}
      <div
        className={cn(
          "-mx-4 space-y-2 border-t bg-background/95 px-4 py-3 backdrop-blur",
          changed.length > 0 && "sticky bottom-0",
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="syllabus-change-note" className="text-xs">
              What changed (optional, shown on the belt pages)
            </Label>
            <Input
              id="syllabus-change-note"
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              maxLength={500}
            />
          </div>
          <Button
            type="button"
            disabled={!changed.length || problems.size > 0 || saving}
            onClick={() => void onSave()}
          >
            {saving
              ? "Saving..."
              : changed.length
                ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}`
                : "Nothing to save"}
          </Button>
        </div>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Saving updates each belt page that changed, straight away. Members who read a page are
          told it was updated.
        </p>
      </div>
    </div>
  );
}

/** Where a belt's page stands: none yet, a draft, or open to members. */
function BeltPageStatus({ belt }: { belt: SyllabusBelt }) {
  if (!belt.page_slug) {
    return (
      <p className="text-sm text-muted-foreground">
        {belt.name} has no page yet. Saving its first block makes one, for managers only until you
        open it to members on the Belts tab.
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Link
        to="/kb/$slug"
        params={{ slug: belt.page_slug }}
        className="inline-flex items-center gap-1 underline underline-offset-4"
      >
        /kb/{belt.page_slug}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </Link>
      {belt.visibility === "managers" ? (
        <Badge variant="secondary">Draft, managers only</Badge>
      ) : (
        <Badge variant="outline">Members can read it</Badge>
      )}
    </p>
  );
}

// ---- Belts ----

function BeltsTab({ data, confirm, onSaved }: TabProps) {
  const saveBelt = useServerFn(saveManagerBelt);
  const removeBelt = useServerFn(deleteManagerBelt);
  const saveArticle = useServerFn(saveManagerArticle);
  const belts = useMemo(() => orderBelts(data.belts), [data.belts]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<unknown>, done: string) {
    setBusy(key);
    setFailure(null);
    try {
      await action();
      toast.success(done);
      await onSaved();
      return true;
    } catch (e) {
      setFailure(errorText(e, "That did not go through."));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function openToMembers(belt: SyllabusBelt) {
    if (!belt.page_slug) return;
    const ok = await confirm({
      title: `Open ${beltPageTitle(belt)} to members?`,
      description: `Every member will be able to read this belt's syllabus, on its page and in the syllabus by topic.`,
      confirmLabel: "Open to members",
    });
    if (!ok) return;
    await run(
      belt.slug,
      () => saveArticle({ data: { slug: belt.page_slug!, visibility: "members" } }),
      `${beltPageTitle(belt)} is open to members`,
    );
  }

  async function remove(belt: SyllabusBelt) {
    const ok = await confirm({
      title: `Delete the ${belt.name} belt?`,
      description: "It has no page and no syllabus text, so nothing anybody reads changes.",
      confirmLabel: "Delete belt",
      destructive: true,
    });
    if (ok) await run(belt.slug, () => removeBelt({ data: { slug: belt.slug } }), "Belt deleted");
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Junior first. A belt&apos;s page title is built from its name and grade, so changing either
        updates the page. The colour is only a swatch beside the name.
      </p>
      {failure && (
        // Not a retry: a one-press change that failed has nothing typed to
        // keep, and pressing it again is the manager's call once they have
        // read what went wrong.
        <ActionFailure
          title="That change did not go through."
          message={failure}
          onDismiss={() => setFailure(null)}
        />
      )}
      {belts.map((belt) => (
        <BeltRow
          key={belt.slug}
          belt={belt}
          busy={busy === belt.slug}
          onSave={(patch) =>
            run(belt.slug, () => saveBelt({ data: { slug: belt.slug, ...patch } }), "Belt saved")
          }
          onOpen={() => void openToMembers(belt)}
          onDelete={() => void remove(belt)}
        />
      ))}
      <NewBelt
        busy={busy === "new"}
        nextPosition={(belts[belts.length - 1]?.position ?? 0) + 10}
        onCreate={(input) =>
          run("new", () => saveBelt({ data: { ...input, expect_new: true } }), "Belt added")
        }
      />
    </div>
  );
}

type BeltPatch = { name: string; grade: string; colour: string; position: number };

function BeltRow({
  belt,
  busy,
  onSave,
  onOpen,
  onDelete,
}: {
  belt: SyllabusBelt;
  busy: boolean;
  onSave: (patch: BeltPatch) => Promise<boolean>;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [form, setForm] = useState<BeltPatch>({
    name: belt.name,
    grade: belt.grade ?? "",
    colour: belt.colour,
    position: belt.position,
  });
  // Reset to what is stored only when what is stored for THIS belt changes.
  // Keyed on the values, not the object: every save reloads the whole syllabus
  // and hands every belt a new object, which would wipe unsaved edits on the
  // other rows.
  useEffect(
    () =>
      setForm({
        name: belt.name,
        grade: belt.grade ?? "",
        colour: belt.colour,
        position: belt.position,
      }),
    [belt.name, belt.grade, belt.colour, belt.position],
  );
  const dirty =
    form.name !== belt.name ||
    form.grade !== (belt.grade ?? "") ||
    form.colour !== belt.colour ||
    form.position !== belt.position;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-6 rounded-sm border border-foreground/30"
            style={{ backgroundColor: belt.colour }}
          />
          {beltPageTitle(belt)}
          {belt.page_slug ? (
            belt.visibility === "managers" ? (
              <Badge variant="secondary">Draft page</Badge>
            ) : (
              <Badge variant="outline">Page open to members</Badge>
            )
          ) : (
            <Badge variant="outline">No page</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor={`belt-${belt.slug}-name`}>Name</Label>
            <Input
              id={`belt-${belt.slug}-name`}
              value={form.name}
              maxLength={50}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`belt-${belt.slug}-grade`}>Grade</Label>
            <Input
              id={`belt-${belt.slug}-grade`}
              value={form.grade}
              maxLength={50}
              placeholder="None"
              onChange={(e) => setForm({ ...form, grade: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`belt-${belt.slug}-colour`}>Colour</Label>
            <Input
              id={`belt-${belt.slug}-colour`}
              type="color"
              value={form.colour}
              onChange={(e) => setForm({ ...form, colour: e.target.value })}
              className="h-10 p-1"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`belt-${belt.slug}-position`}>Order</Label>
            <Input
              id={`belt-${belt.slug}-position`}
              type="number"
              inputMode="numeric"
              min={0}
              value={form.position}
              onChange={(e) => setForm({ ...form, position: Number(e.target.value) || 0 })}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!dirty || busy || !form.name.trim()}
            onClick={() =>
              void onSave({ ...form, name: form.name.trim(), grade: form.grade.trim() })
            }
          >
            {busy ? "Saving..." : "Save"}
          </Button>
          {belt.page_slug && belt.visibility === "managers" && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onOpen}>
              Open the page to members
            </Button>
          )}
          {!belt.page_slug && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
              <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
              Delete
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NewBelt({
  busy,
  nextPosition,
  onCreate,
}: {
  busy: boolean;
  nextPosition: number;
  onCreate: (input: {
    slug: string;
    name: string;
    grade: string;
    colour: string;
    position: number;
  }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState("");
  const [colour, setColour] = useState("#111827");
  const slug = slugFromTitle(name).slice(0, 50).replace(/-+$/g, "");
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Add a belt</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="new-belt-name">Name</Label>
            <Input
              id="new-belt-name"
              value={name}
              maxLength={50}
              placeholder="Black"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-belt-grade">Grade</Label>
            <Input
              id="new-belt-grade"
              value={grade}
              maxLength={50}
              placeholder="1st Dan"
              onChange={(e) => setGrade(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-belt-colour">Colour</Label>
            <Input
              id="new-belt-colour"
              type="color"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
              className="h-10 p-1"
            />
          </div>
        </div>
        {slug && (
          <p className="text-xs text-muted-foreground">
            Its page will be at /kb/{slug}-belt, and it goes after the most senior belt.
          </p>
        )}
        <Button
          type="button"
          size="sm"
          disabled={!slug || busy}
          onClick={async () => {
            const ok = await onCreate({
              slug,
              name: name.trim(),
              grade: grade.trim(),
              colour,
              position: nextPosition,
            });
            if (ok) {
              setName("");
              setGrade("");
            }
          }}
        >
          {busy ? "Adding..." : "Add belt"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---- Topics ----

function TopicsTab({ data, confirm, onSaved }: TabProps) {
  const saveTopic = useServerFn(saveManagerSyllabusTopic);
  const removeTopic = useServerFn(deleteManagerSyllabusTopic);
  const tree = useMemo(() => topicTree(data.topics), [data.topics]);
  const used = useMemo(() => new Set(data.entries.map((e) => e.topic)), [data.entries]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<unknown>, done: string) {
    setBusy(key);
    setFailure(null);
    try {
      await action();
      toast.success(done);
      await onSaved();
      return true;
    } catch (e) {
      setFailure(errorText(e, "That did not go through."));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function move(
    slug: string,
    siblings: { slug: string; position: number }[],
    direction: "up" | "down",
  ) {
    const plan = movedPosition(siblings, slug, direction);
    if (!plan) return;
    await run(
      slug,
      async () => {
        await saveTopic({ data: { slug, position: plan.position } });
        if (plan.swapWith) {
          await saveTopic({ data: { slug: plan.swapWith.slug, position: plan.swapWith.position } });
        }
      },
      "Moved",
    );
  }

  async function remove(slug: string, title: string) {
    const ok = await confirm({
      title: `Delete the topic "${title}"?`,
      description: "No belt has anything on it, so no page changes.",
      confirmLabel: "Delete topic",
      destructive: true,
    });
    if (ok) await run(slug, () => removeTopic({ data: { slug } }), "Topic deleted");
  }

  const row = (
    topic: { slug: string; title: string; position: number; parent: string | null },
    siblings: { slug: string; position: number }[],
    index: number,
    hasChildren: boolean,
  ) => (
    <TopicRow
      key={topic.slug}
      topic={topic}
      roots={tree.filter((r) => r.slug !== topic.slug)}
      hasChildren={hasChildren}
      busy={busy === topic.slug}
      first={index === 0}
      last={index === siblings.length - 1}
      deletable={!hasChildren && !used.has(topic.slug)}
      onMove={(direction) => void move(topic.slug, siblings, direction)}
      onSave={(patch) =>
        run(
          topic.slug,
          () => saveTopic({ data: { slug: topic.slug, ...patch } }),
          patch.title ? "Topic renamed. The belt pages are updated." : "Topic saved",
        )
      }
      onDelete={() => void remove(topic.slug, topic.title)}
    />
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Topics are the headings on every belt page, in this order. Renaming one keeps every link to
        it working. Sub-topics sit one level under a topic, like Throws under Techniques.
      </p>
      {failure && (
        // Not a retry: a one-press change that failed has nothing typed to
        // keep, and pressing it again is the manager's call once they have
        // read what went wrong.
        <ActionFailure
          title="That change did not go through."
          message={failure}
          onDismiss={() => setFailure(null)}
        />
      )}
      <ul className="space-y-2">
        {tree.map((root, i) => (
          <li key={root.slug} className="space-y-2">
            {row(root, tree, i, root.children.length > 0)}
            {root.children.length > 0 && (
              <ul className="space-y-2 pl-4 sm:pl-8">
                {root.children.map((child, j) => (
                  <li key={child.slug}>{row(child, root.children, j, false)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <NewTopic
        roots={tree}
        busy={busy === "new"}
        onCreate={(input) =>
          run("new", () => saveTopic({ data: { ...input, expect_new: true } }), "Topic added")
        }
      />
    </div>
  );
}

function TopicRow({
  topic,
  roots,
  hasChildren,
  busy,
  first,
  last,
  deletable,
  onMove,
  onSave,
  onDelete,
}: {
  topic: { slug: string; title: string; parent: string | null };
  roots: { slug: string; title: string }[];
  hasChildren: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  deletable: boolean;
  onMove: (direction: "up" | "down") => void;
  onSave: (patch: { title?: string; parent?: string }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(topic.title);
  const [parent, setParent] = useState(topic.parent ?? "");
  useEffect(() => {
    setTitle(topic.title);
    setParent(topic.parent ?? "");
  }, [topic.title, topic.parent]);
  const dirty = title.trim() !== topic.title || parent !== (topic.parent ?? "");

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end">
      <div className="flex-1 space-y-1">
        <Label htmlFor={`topic-${topic.slug}`} className="text-xs">
          Title <span className="font-mono text-muted-foreground">#{topic.slug}</span>
        </Label>
        <Input
          id={`topic-${topic.slug}`}
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {!hasChildren && (
        <div className="space-y-1 sm:w-48">
          <Label htmlFor={`topic-${topic.slug}-parent`} className="text-xs">
            Under
          </Label>
          <select
            id={`topic-${topic.slug}-parent`}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Nothing (a main topic)</option>
            {roots.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.title}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex gap-1">
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Move ${topic.title} up`}
          disabled={first || busy}
          onClick={() => onMove("up")}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Move ${topic.title} down`}
          disabled={last || busy}
          onClick={() => onMove("down")}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || !title.trim() || busy}
          onClick={() =>
            void onSave({
              ...(title.trim() !== topic.title ? { title: title.trim() } : {}),
              ...(parent !== (topic.parent ?? "") ? { parent } : {}),
            })
          }
        >
          {busy ? "Saving..." : "Save"}
        </Button>
        {deletable && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Delete ${topic.title}`}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function NewTopic({
  roots,
  busy,
  onCreate,
}: {
  roots: { slug: string; title: string }[];
  busy: boolean;
  onCreate: (input: { slug: string; title: string; parent: string }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState("");
  const slug = slugFromTitle(title);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Add a topic</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="new-topic-title">Title</Label>
            <Input
              id="new-topic-title"
              value={title}
              maxLength={100}
              placeholder="Weapons"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-topic-parent">Under</Label>
            <select
              id="new-topic-parent"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">Nothing (a main topic)</option>
              {roots.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.title}
                </option>
              ))}
            </select>
          </div>
        </div>
        {slug && (
          <p className="text-xs text-muted-foreground">
            Its heading on the belt pages will answer to #{slug}, for good. It goes last.
          </p>
        )}
        <Button
          type="button"
          size="sm"
          disabled={!slug || busy}
          onClick={async () => {
            if (await onCreate({ slug, title: title.trim(), parent })) {
              setTitle("");
              setParent("");
            }
          }}
        >
          {busy ? "Adding..." : "Add topic"}
        </Button>
      </CardContent>
    </Card>
  );
}
