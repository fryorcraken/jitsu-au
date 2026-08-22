import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { describeLoadError } from "@/lib/load-error";
import { Trash2 } from "lucide-react";
import {
  listWaiverTemplates,
  saveWaiverTemplate,
  setCurrentWaiverTemplate,
} from "@/lib/waiver.functions";
import type { AcknowledgementDef } from "@/lib/validation";
import { buildHealthPlaceholders, healthQuestions } from "@/lib/waiver-health";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { discardUnsavedChanges, useConfirm } from "@/hooks/use-confirm";
import { cn } from "@/lib/utils";
import {
  hasMediaAcknowledgement,
  isDirty,
  meaningfulAcks,
  versionLabel,
} from "@/lib/waiver-template-editor";
import { MEDIA_ACK_ID } from "@/lib/waiver-acknowledgements";

function applyPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => values[k] ?? `{{${k}}}`);
}

const PLACEHOLDERS = [
  "full_name",
  "preferred_name",
  "date_of_birth",
  "address",
  "phone",
  "email",
  "adult_checkbox",
  "minor_checkbox",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
  ...healthQuestions.map((q) => `health_${q.id}`),
  "medical_notes",
  "guardian_name",
  "guardian_relationship",
  "guardian_address",
  "guardian_phone",
  "guardian_email",
  "signature_name",
  "signed_date",
  "club_name",
];

const SAMPLE: Record<string, string> = {
  full_name: "Jane Sample",
  preferred_name: "Janey",
  date_of_birth: "1995-06-12",
  address: "123 Broadway, Ultimo NSW 2007",
  phone: "0400 000 000",
  email: "jane@example.com",
  adult_checkbox: "[X]",
  minor_checkbox: "[  ]",
  emergency_contact_name: "John Sample",
  emergency_contact_relationship: "Partner",
  emergency_contact_phone: "0400 111 222",
  ...buildHealthPlaceholders({
    drugs: false,
    blackouts: false,
    device: false,
    impairments: true,
    other: false,
  }),
  medical_notes: "Weak left ankle, taped for training.",
  guardian_name: "N/A",
  guardian_relationship: "N/A",
  guardian_address: "N/A",
  guardian_phone: "N/A",
  guardian_email: "N/A",
  signature_name: "Jane Sample",
  signed_date: new Date().toLocaleDateString("en-AU"),
  club_name: "UTS Jitsu",
};

export const Route = createFileRoute("/_authenticated/manager/waiver-template")({
  head: () => ({
    meta: [{ title: "Waiver template | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: EditorPage,
});

type TemplateVersion = Awaited<ReturnType<typeof listWaiverTemplates>>[number];

function EditorPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchTemplates = useServerFn(listWaiverTemplates);
  const save = useServerFn(saveWaiverTemplate);
  const promote = useServerFn(setCurrentWaiverTemplate);

  const [templates, setTemplates] = useState<TemplateVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [acks, setAcks] = useState<AcknowledgementDef[]>([]);
  const [loading, setLoading] = useState(true);
  // The editor must never open blank over a live legal document. An empty body
  // here looks like a template nobody has written yet, and saving from that
  // state publishes an empty waiver as the thing people sign.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  function load(template: TemplateVersion) {
    setSelectedId(template.id);
    setTitle(template.title);
    setBody(template.body_md);
    setAcks(template.acknowledgements ?? []);
  }

  // Named so the failure panel's "Try again" repeats exactly what mount does.
  const loadTemplates = useCallback(() => {
    setLoading(true);
    return fetchTemplates()
      .then((rows) => {
        setLoadError(null);
        setTemplates(rows);
        // Open on the live version when there is one, otherwise the newest
        // draft, so a template seeded outside the editor is never invisible.
        const opening = rows.find((t) => t.is_current) ?? rows[0];
        if (opening) load(opening);
      })
      .catch((e) => {
        // A non-manager is redirected by the effect below; anything else stops
        // the editor rendering at all, rather than leaving a blank body that
        // saves over the live waiver.
        if (!(e instanceof Error) || !e.message.includes("Forbidden")) {
          const message = describeLoadError(e, "Could not load waiver versions");
          setLoadError(message);
          toast.error(message);
        }
      })
      .finally(() => setLoading(false));
  }, [fetchTemplates]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // Editing a version and saving writes a NEW version, so an unsaved edit is
  // lost by switching away from it. Warn rather than discard silently.
  const dirty = isDirty(
    { title, body_md: body, acknowledgements: acks },
    selected && {
      title: selected.title,
      body_md: selected.body_md,
      acknowledgements: selected.acknowledgements ?? [],
    },
  );

  const liveVersion = templates.find((t) => t.is_current)?.version ?? null;

  // Checked against the raw acks so clearing the media row's label trips this
  // immediately, before `meaningfulAcks` would silently drop the row on save.
  const mediaAckMissing = !hasMediaAcknowledgement(acks);

  async function selectVersion(template: TemplateVersion) {
    if (template.id === selectedId) return;
    if (dirty && !(await confirm(discardUnsavedChanges("Opening another version")))) return;
    load(template);
  }

  async function onPromote() {
    if (!selected || selected.is_current) return;
    // Promoting publishes the STORED row, not what is in the editor. Saying so
    // matters most to the manager who has just rewritten a clause: without this
    // they read "now live", see their own edit still on screen, and believe it
    // is what people are signing.
    const ok = await confirm({
      title: `Make version ${selected.version} the waiver people sign?`,
      description: `Everyone who signs from now on signs version ${selected.version}. Waivers already signed keep the version they were signed against.`,
      footnote: dirty
        ? `Your unsaved edits are not part of version ${selected.version}, so they will not go live. Save them as a new version first if you want them.`
        : undefined,
      confirmLabel: "Make it live",
    });
    if (!ok) return;
    setPromoting(true);
    try {
      await promote({ data: { id: selected.id } });
      setTemplates((prev) => prev.map((t) => ({ ...t, is_current: t.id === selected.id })));
      toast.success(`Version ${selected.version} is now live`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the live version");
    } finally {
      setPromoting(false);
    }
  }

  function addAck() {
    setAcks((prev) => [...prev, { id: crypto.randomUUID(), label: "", required: true }]);
  }
  function updateAck(id: string, patch: Partial<AcknowledgementDef>) {
    setAcks((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  function removeAck(id: string) {
    setAcks((prev) => prev.filter((a) => a.id !== id));
  }

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const preview = useMemo(() => applyPlaceholders(body, SAMPLE), [body]);

  async function onSave() {
    // Belt and braces: the Save button is already disabled for this, but a
    // rejected server call after the fact is a worse experience than catching
    // it here, and the server-side guard in `promoteWaiverTemplate` is what
    // actually protects the data either way.
    if (mediaAckMissing) {
      toast.error(
        "The media consent acknowledgement needs wording before this can be saved. Add it back or restore its label.",
      );
      return;
    }
    setSaving(true);
    try {
      const cleanAcks = meaningfulAcks(acks);
      const res = await save({ data: { title, body_md: body, acknowledgements: cleanAcks } });
      setAcks(cleanAcks);
      // Report the save the moment it succeeds. Refreshing the list is a second
      // round trip, and reporting after it meant a failure THERE was announced
      // as "Save failed" for a version that had been written and made live —
      // whereupon the obvious response, saving again, files a duplicate.
      toast.success(`Saved version ${res.version}, now live`);
      try {
        const rows = await fetchTemplates();
        setTemplates(rows);
        const created = rows.find((t) => t.version === res.version);
        if (created) load(created);
      } catch {
        toast.warning("Saved. The version list could not be refreshed, so reload to see it.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function insertPlaceholder(name: string) {
    setBody((b) => `${b}${b.endsWith(" ") || b === "" ? "" : " "}{{${name}}}`);
  }

  if (loading) return <Loading className="p-8" />;

  // Deliberately in place of the whole editor, not beside it. Saving writes a
  // new live version out of whatever is in these fields, so an editor rendered
  // over a failed load is a loaded gun: the body would be empty and the save
  // would publish that.
  if (loadError)
    return (
      <section className="mx-auto max-w-2xl px-4 py-10">
        <LoadFailure
          what="The waiver template"
          message={loadError}
          hint="Nothing has changed, and the version people sign is still live. Do not edit from here until it loads: saving would publish an empty waiver over it."
          onRetry={() => void loadTemplates()}
        />
      </section>
    );

  return (
    <>
      <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Waiver template</h1>
            <p className="text-sm text-muted-foreground">
              Edit the waiver text. Saving creates a new version and makes it the one people sign.
              Past versions stay linked to the waivers signed against them.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
          <div className="space-y-4">
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
              <Label htmlFor="body">Body (Markdown, use {"{{placeholder}}"} tokens)</Label>
              <Textarea
                id="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={22}
                className="mt-1.5 font-mono text-sm"
              />
            </div>
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <Label>Acknowledgements</Label>
                <Button type="button" variant="outline" size="sm" onClick={addAck}>
                  Add acknowledgement
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Statements the signer ticks. Labels support {"{{placeholder}}"} tokens. Required
                ones block submission until accepted.
              </p>
              {mediaAckMissing ? (
                <p className="text-sm font-medium text-destructive">
                  This template needs a media consent acknowledgement with real wording before it
                  can be saved. Add one back, or restore the wording on the existing one.
                </p>
              ) : null}
              {acks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No acknowledgements.</p>
              ) : (
                acks.map((ack) => {
                  // Media consent is the one acknowledgement the rest of the
                  // app reads by name: its tick is what fills in a person's
                  // media consent on their manager page. Rewording it is fine
                  // and expected; deleting it is not, because a template
                  // without it silently stops recording the answer and every
                  // waiver signed afterwards reads as "not asked".
                  const isMedia = ack.id === MEDIA_ACK_ID;
                  return (
                    <div key={ack.id} className="flex items-start gap-2">
                      <div className="flex-1 space-y-1">
                        <Textarea
                          value={ack.label}
                          onChange={(e) => updateAck(ack.id, { label: e.target.value })}
                          rows={2}
                          maxLength={500}
                          placeholder="I understand that…"
                          className="text-sm"
                        />
                        {isMedia ? (
                          <p className="text-xs text-muted-foreground">
                            This one also fills in each person's media consent on their manager
                            page. Reword it freely, but leave it on the form or the club stops
                            recording who agreed to photos.
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-center gap-1 pt-1">
                        <label className="flex items-center gap-1 text-xs">
                          <Checkbox
                            checked={ack.required}
                            onCheckedChange={(v) => updateAck(ack.id, { required: v === true })}
                          />
                          Required
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove acknowledgement"
                          disabled={isMedia}
                          title={
                            isMedia
                              ? "Media consent feeds each person's record, so it cannot be removed here."
                              : undefined
                          }
                          onClick={() => removeAck(ack.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <Button onClick={onSave} disabled={saving || !title || !body || mediaAckMissing}>
              {saving ? "Saving..." : "Save as new version"}
            </Button>
          </div>

          <aside className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Only one version is live at a time. Pick one to read or edit it.
                </p>
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void selectVersion(t)}
                    aria-current={t.id === selectedId}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted",
                      t.id === selectedId && "border-primary bg-muted",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">Version {t.version}</span>
                      {t.is_current ? (
                        <Badge>Live</Badge>
                      ) : (
                        <Badge variant="outline">{versionLabel(t, liveVersion)}</Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{t.title}</span>
                  </button>
                ))}
                {selected && !selected.is_current && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    disabled={promoting}
                    onClick={onPromote}
                  >
                    {promoting ? "Making live..." : `Make version ${selected.version} live`}
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Placeholders</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {PLACEHOLDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => insertPlaceholder(p)}
                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  >{`{{${p}}}`}</button>
                ))}
              </CardContent>
            </Card>
          </aside>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview (with sample values)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-foreground prose-p:leading-relaxed prose-strong:text-foreground">
              <ReactMarkdown>{preview}</ReactMarkdown>
            </div>
            {acks.some((a) => a.label.trim()) && (
              <div className="mt-6">
                <p className="text-sm font-semibold">Acknowledgements</p>
                <ul className="mt-2 space-y-2">
                  {acks
                    .filter((a) => a.label.trim())
                    .map((ack) => (
                      <li key={ack.id} className="flex items-start gap-2 text-sm">
                        <Checkbox checked disabled className="mt-0.5" />
                        <span>
                          {applyPlaceholders(ack.label, SAMPLE)}
                          {!ack.required && (
                            <span className="text-muted-foreground"> (optional)</span>
                          )}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
      {confirmDialog}
    </>
  );
}
