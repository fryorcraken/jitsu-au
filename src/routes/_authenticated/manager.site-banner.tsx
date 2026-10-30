import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { SiteBannerBar } from "@/components/site/SiteBanner";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { discardUnsavedChanges, useConfirm } from "@/hooks/use-confirm";
import { getSiteBannerSettings, saveClubSettings } from "@/lib/club-settings.functions";
import { describeLoadError } from "@/lib/load-error";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import {
  SITE_BANNER_LINK_LABEL_MAX,
  SITE_BANNER_MESSAGE_MAX,
  siteBannerSchema,
} from "@/lib/validation";
import type { SiteBanner } from "@/lib/validation";

export const Route = createFileRoute("/_authenticated/manager/site-banner")({
  head: () => ({
    meta: [{ title: "Site banner | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SiteBannerPage,
});

type TextField = "message" | "link_label" | "link_href";

/** The message as a save stores it (`siteBannerSchema`): one line, trimmed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function SiteBannerPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchBanner = useServerFn(getSiteBannerSettings);

  const [saved, setSaved] = useState<SiteBanner | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether the form holds edits not yet saved, for the Back button below.
  const [dirty, setDirty] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchBanner()
      .then(setSaved)
      .catch((e) => setLoadError(describeLoadError(e, "Could not load the site banner")))
      .finally(() => setLoading(false));
  }, [fetchBanner]);

  useEffect(() => {
    if (isManager) load();
  }, [isManager, load]);

  async function goBack() {
    if (dirty && !(await confirm(discardUnsavedChanges("Going back")))) return;
    navigate({ to: "/manager" });
  }

  if (loading && !saved) return <Loading className="p-8" />;

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Site banner</h1>
          <p className="text-sm text-muted-foreground">
            A one-line notice across the top of every public page, for news visitors should see
            before anything else.
          </p>
        </div>
        <Button variant="outline" onClick={() => void goBack()}>
          Back to dashboard
        </Button>
      </div>

      {/* In place of the form, not beside it: an empty form here would invite
          saving a blank, switched-off banner over a notice that may be live. */}
      {loadError || !saved ? (
        <LoadFailure
          what="The site banner"
          message={loadError}
          hint="This is not the same as having no banner. Visitors are unaffected, and we have not shown the form so nothing can be saved over a notice we could not read."
          onRetry={load}
        />
      ) : (
        <BannerForm initial={saved} onDirtyChange={setDirty} />
      )}
      {confirmDialog}
    </section>
  );
}

/**
 * The form. One Save for the whole banner: switching it on, rewording it and
 * changing its link all go live together, so a visitor never sees half an
 * edit. No confirm, because it is undone the same way it is done, and the
 * preview already shows exactly what visitors will get.
 */
function BannerForm({
  initial,
  onDirtyChange,
}: {
  initial: SiteBanner;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const save = useServerFn(saveClubSettings);
  const router = useRouter();
  const send = useResilientSubmit<{ ok: true }>(INTAKE_SUBMIT);
  const [form, setForm] = useState<SiteBanner>(initial);
  const [saved, setSaved] = useState<SiteBanner>(initial);
  const [touched, setTouched] = useState(false);

  const parsed = siteBannerSchema.safeParse(form);
  const errors: Partial<Record<TextField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as TextField;
      if (key && !errors[key]) errors[key] = issue.message;
    }
  }
  const unchanged = parsed.success && JSON.stringify(parsed.data) === JSON.stringify(saved);
  // Compared raw, not parsed: an edit that does not yet pass the rules is
  // still somebody's typing, and the most likely kind to be thrown away.
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  function update(next: Partial<SiteBanner>) {
    setForm((f) => ({ ...f, ...next }));
    // The failure panel is about what failed to save, not about this edit.
    if (send.status === "failed") send.reset();
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    const banner = parsed.data;
    const outcome = await send.submit({
      run: (signal) => save({ signal, data: { key: "site_banner", value: banner } }),
    });
    if (outcome.ok) {
      setSaved(banner);
      setForm(banner);
      setTouched(false);
      send.reset();
      // The root loader keeps the banner for a few minutes between pages, so
      // refresh it now: the manager's own next page shows what they saved.
      // Every other visitor gets it on their next page load.
      void router.invalidate({ filter: (match) => match.routeId === "__root__" });
      toast.success(banner.enabled ? "Saved. The banner is live." : "Saved. The banner is off.");
    }
  }

  const showError = (key: TextField) => (touched ? errors[key] : undefined);
  // What a save would store, so the preview never shows what visitors won't
  // get (a message of only spaces, say). Shown on a page no link points at, so
  // a link to "/" is previewed as the link it is everywhere else.
  const preview = parsed.success ? parsed.data : { ...form, message: oneLine(form.message) };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-6" noValidate>
      <p className="text-sm" role="status">
        {saved.enabled ? (
          <>
            <strong>On.</strong> Visitors see it at the top of every public page until they close
            it.
          </>
        ) : (
          <>
            <strong>Off.</strong> Visitors see no banner.
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        <Switch
          id="banner-enabled"
          checked={form.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
          disabled={send.busy}
        />
        <Label htmlFor="banner-enabled">Show the banner</Label>
      </div>

      <TextInput
        id="message"
        label="Message"
        // Counted as it will be saved: line breaks and doubled spaces collapse.
        // No maxLength on the box, because it would cut a pasted notice off
        // before that tidying, mid-word.
        hint={`One line, up to ${SITE_BANNER_MESSAGE_MAX} characters (${oneLine(form.message).length} so far). Line breaks become spaces. Short reads best on a phone.`}
        placeholder="We're training at a temporary location, so free trials are paused for now."
        value={form.message}
        error={showError("message")}
        disabled={send.busy}
        onChange={(message) => update({ message })}
      />

      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Link (optional)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Shown underlined after the message, and the whole line becomes the link. Leave both
            empty for a notice with no link.
          </p>
        </div>
        <TextInput
          id="link_label"
          label="Link text"
          hint={`Up to ${SITE_BANNER_LINK_LABEL_MAX} characters.`}
          placeholder="Register your interest"
          value={form.link_label}
          error={showError("link_label")}
          disabled={send.busy}
          onChange={(link_label) => update({ link_label })}
        />
        <TextInput
          id="link_href"
          label="Where it goes"
          hint="A page on this site, like /register-interest, or a full https:// address."
          placeholder="/register-interest"
          value={form.link_href}
          error={showError("link_href")}
          disabled={send.busy}
          onChange={(link_href) => update({ link_href })}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What visitors see</CardTitle>
          <CardDescription>
            {form.enabled
              ? "The banner as it will look, updating as you type."
              : "Nothing, while the banner is off. This is how it would look switched on."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preview.message ? (
            <div className={form.enabled ? undefined : "opacity-50"}>
              <SiteBannerBar banner={preview} pathname="/manager/site-banner" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Write a message to see it here.</p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <Button type="submit" disabled={send.busy || unchanged}>
          {send.busy ? "Saving..." : "Save"}
        </Button>
        <SubmitStatus
          status={send.status}
          attempt={send.attempt}
          attempts={send.attempts}
          error={send.error}
          failureKind={send.failureKind}
          onRetry={() => void submit()}
        />
      </div>
    </form>
  );
}

function TextInput({
  id,
  label,
  hint,
  placeholder,
  value,
  error,
  disabled,
  onChange,
}: {
  id: TextField;
  label: string;
  hint?: string;
  placeholder: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
