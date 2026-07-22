import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getClubSettings, saveClubSettings } from "@/lib/membership.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/settings")({
  head: () => ({
    meta: [{ title: "Club settings | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchSettings = useServerFn(getClubSettings);
  const save = useServerFn(saveClubSettings);

  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchSettings()
      .then((s) => setInstructions(s.invoice_payment_instructions))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load settings"))
      .finally(() => setLoading(false));
  }, [isManager, fetchSettings]);

  async function onSave() {
    setSaving(true);
    try {
      await save({ data: { invoice_payment_instructions: instructions } });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SiteLayout>
        <div className="p-8">Loading...</div>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-4xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Club settings</h1>
            <p className="text-sm text-muted-foreground">
              Text shown to members on their membership invoice.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/manager/memberships">Back to memberships</Link>
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <Label htmlFor="instructions">Invoice payment instructions (Markdown)</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Add your bank transfer details (account name, BSB, account number), PayID, or any
                note. The amount and payment reference are added automatically.
              </p>
              <Textarea
                id="instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={16}
                maxLength={5000}
                className="mt-2 font-mono text-sm"
              />
            </div>
            <Button onClick={onSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Preview</CardTitle>
              <CardDescription>How the instructions appear on the invoice.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-foreground prose-p:leading-relaxed prose-strong:text-foreground">
                <ReactMarkdown>
                  {instructions || "_Nothing yet. Add your instructions._"}
                </ReactMarkdown>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
    </SiteLayout>
  );
}
