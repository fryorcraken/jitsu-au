import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2 } from "lucide-react";
import { getCurrentWaiverTemplate, saveWaiverTemplate } from "@/lib/waiver.functions";
import type { AcknowledgementDef } from "@/lib/validation";
import { useAuth, useRoles } from "@/hooks/useAuth";

function applyPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => values[k] ?? `{{${k}}}`);
}

const PLACEHOLDERS = [
  "full_name",
  "date_of_birth",
  "address",
  "phone",
  "email",
  "emergency_contact_name",
  "emergency_contact_phone",
  "medical_notes",
  "signature_name",
  "signed_date",
  "club_name",
];

const SAMPLE: Record<string, string> = {
  full_name: "Jane Sample",
  date_of_birth: "1995-06-12",
  address: "123 Broadway, Ultimo NSW 2007",
  phone: "0400 000 000",
  email: "jane@example.com",
  emergency_contact_name: "John Sample",
  emergency_contact_phone: "0400 111 222",
  medical_notes: "None",
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

function EditorPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchCurrent = useServerFn(getCurrentWaiverTemplate);
  const save = useServerFn(saveWaiverTemplate);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [acks, setAcks] = useState<AcknowledgementDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchCurrent().then((t) => {
      if (t) {
        setTitle(t.title);
        setBody(t.body_md);
        setAcks(t.acknowledgements ?? []);
      }
      setLoading(false);
    });
  }, [fetchCurrent]);

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
    setSaving(true);
    try {
      const cleanAcks = acks
        .map((a) => ({ ...a, label: a.label.trim() }))
        .filter((a) => a.label.length > 0);
      const res = await save({ data: { title, body_md: body, acknowledgements: cleanAcks } });
      toast.success(`Saved version ${res.version}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function insertPlaceholder(name: string) {
    setBody((b) => `${b}${b.endsWith(" ") || b === "" ? "" : " "}{{${name}}}`);
  }

  if (loading)
    return (
      <SiteLayout>
        <div className="p-8">Loading...</div>
      </SiteLayout>
    );

  return (
    <SiteLayout>
      <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Waiver template</h1>
            <p className="text-sm text-muted-foreground">
              Edit the waiver text. Saving creates a new version. Past versions stay linked to their
              signed waivers.
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
              {acks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No acknowledgements.</p>
              ) : (
                acks.map((ack) => (
                  <div key={ack.id} className="flex items-start gap-2">
                    <Textarea
                      value={ack.label}
                      onChange={(e) => updateAck(ack.id, { label: e.target.value })}
                      rows={2}
                      maxLength={500}
                      placeholder="I understand that…"
                      className="text-sm"
                    />
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
                        onClick={() => removeAck(ack.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <Button onClick={onSave} disabled={saving || !title || !body}>
              {saving ? "Saving..." : "Save as new version"}
            </Button>
          </div>

          <aside className="space-y-4">
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
    </SiteLayout>
  );
}
