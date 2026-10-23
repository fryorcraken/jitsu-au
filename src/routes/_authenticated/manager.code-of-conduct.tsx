import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { SaveFailure } from "@/components/site/SaveFailure";
import { DraftRestoreBanner } from "@/components/site/DraftRestoreBanner";
import { CodeOfConductDocument } from "@/components/site/CodeOfConductDocument";
import { describeLoadError } from "@/lib/load-error";
import {
  listCodeOfConductVersions,
  saveCodeOfConduct,
  setCurrentCodeOfConduct,
} from "@/lib/code-of-conduct.functions";
import {
  CODE_OF_CONDUCT_SYNTAX,
  codeOfConductStandard,
  countReprompted,
  standardAfterPublishing,
  standardAfterSaving,
} from "@/lib/code-of-conduct";
import { versionLabel } from "@/lib/document-versions";
import { CODE_OF_CONDUCT_BODY_MAX } from "@/lib/validation";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { useEditorDraft } from "@/hooks/use-editor-draft";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { discardUnsavedChanges, useConfirm } from "@/hooks/use-confirm";
import { cn } from "@/lib/utils";

// The code of conduct editor: the waiver template editor's counterpart, for
// the house rules members agree to. Saving writes a new numbered version and
// makes it the one on /code-of-conduct; any version can be made live again.
//
// The one thing the waiver editor does not have is the re-agreement choice.
// Every save is a new version, so an acceptance's number always names the text
// that person read, but only a save that ASKS puts everybody who agreed to an
// older one out of date. Off by default, because the commonest save is a
// correction, and the screen says how many people a save will ask before the
// click. docs/code-of-conduct.md has the rule.

export const Route = createFileRoute("/_authenticated/manager/code-of-conduct")({
  head: () => ({
    meta: [{ title: "Code of conduct | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: EditorPage,
});

type Listing = Awaited<ReturnType<typeof listCodeOfConductVersions>>;
type Version = Listing["versions"][number];
type Saved = Awaited<ReturnType<typeof saveCodeOfConduct>>;

type DraftFields = { title: string; body: string };
const DRAFT_SHAPE: DraftFields = { title: "", body: "" };

/** "1 person" / "12 people", for the sentences that say who a publish asks. */
function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

function EditorPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchVersions = useServerFn(listCodeOfConductVersions);
  const save = useServerFn(saveCodeOfConduct);
  const promote = useServerFn(setCurrentCodeOfConduct);
  const send = useResilientSubmit<Saved>(INTAKE_SUBMIT);
  const { confirm, confirmDialog } = useConfirm();

  const [versions, setVersions] = useState<Version[]>([]);
  const [highestAccepted, setHighestAccepted] = useState<number[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [asksReagreement, setAsksReagreement] = useState(false);
  const [loading, setLoading] = useState(true);
  // The editor must never open blank over the live document: saving from an
  // empty form would publish an empty code of conduct.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  // A failed "make live" stays on screen with its retry. It can be the one
  // message that says the club has no live code of conduct at all, which is
  // not something to leave to a toast that fades in four seconds.
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const selected = versions.find((v) => v.id === selectedId) ?? null;
  const live = versions.find((v) => v.is_current) ?? null;
  const liveVersion = live?.version ?? null;

  function open(version: Version) {
    setSelectedId(version.id);
    setTitle(version.title);
    setBody(version.body_md);
    setAsksReagreement(false);
  }

  const apply = useCallback((listing: Listing, openVersion?: number) => {
    setVersions(listing.versions);
    setHighestAccepted(listing.highest_accepted);
    const target =
      (openVersion !== undefined && listing.versions.find((v) => v.version === openVersion)) ||
      listing.versions.find((v) => v.is_current) ||
      listing.versions[0];
    if (target) open(target);
  }, []);

  // Named so the failure panel's "Try again" repeats exactly what mount does.
  const load = useCallback(() => {
    setLoading(true);
    return fetchVersions()
      .then((listing) => {
        setLoadError(null);
        apply(listing);
      })
      .catch((e) => {
        // A non-manager is redirected by the effect below.
        if (!(e instanceof Error) || !e.message.includes("Forbidden")) {
          setLoadError(describeLoadError(e, "Could not load the code of conduct"));
        }
      })
      .finally(() => setLoading(false));
  }, [fetchVersions, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  // With nothing stored at all there is nothing to compare against, and what
  // is typed is the first version.
  const textChanged = selected
    ? title !== selected.title || body !== selected.body_md
    : Boolean(title.trim() || body.trim());

  // What a save or a rollback would do to people, in numbers, before the click.
  const flags = useMemo(
    () =>
      versions.map((v) => ({
        version: v.version,
        asks_reagreement: v.asks_reagreement,
        required_version: v.required_version,
        is_current: v.is_current,
      })),
    [versions],
  );
  const standardNow = useMemo(() => codeOfConductStandard(flags), [flags]);
  // Counted for the save as it stands, box ticked or not. Leaving it off
  // normally re-prompts nobody, but not always: with nothing live, the new
  // version inherits the newest one's requirement, and that can put people out
  // of date. The screen has to say so rather than promise nobody is affected.
  const repromptedBySave = useMemo(
    () =>
      countReprompted(highestAccepted, standardNow, standardAfterSaving(flags, asksReagreement)),
    [highestAccepted, standardNow, flags, asksReagreement],
  );

  // On-device safety net, the same one the waiver template editor uses: a
  // rewrite of the house rules is a long sitting, and a backgrounded app on a
  // phone is killed without being asked. Scoped to the version being edited.
  const draftValue = useMemo<DraftFields>(() => ({ title, body }), [title, body]);
  const draftBaseline = useMemo<DraftFields>(
    () => (selected ? { title: selected.title, body: selected.body_md } : DRAFT_SHAPE),
    [selected],
  );
  const draft = useEditorDraft<DraftFields>({
    kind: "code-of-conduct",
    scope: selectedId ?? "new",
    owner: user?.id ?? null,
    value: draftValue,
    baseline: draftBaseline,
    shape: DRAFT_SHAPE,
    // Held back until a version is open, so an offer is measured against it,
    // or kept for the first version when there is none to open.
    enabled: Boolean(selected) || (!loading && !loadError && versions.length === 0),
  });

  function restoreDraft() {
    const d = draft.offered;
    if (!d) return;
    setTitle(d.title);
    setBody(d.body);
    draft.restore();
  }

  // Editing anything starts a fresh save: the failure panel described the last
  // attempt, and a new press of Save is a new version, so it gets a new id.
  const { reset } = send;
  useEffect(() => {
    reset();
  }, [title, body, asksReagreement, reset]);

  async function selectVersion(version: Version) {
    if (version.id === selectedId) return;
    setPromoteError(null);
    if (textChanged && !(await confirm(discardUnsavedChanges("Opening another version")))) return;
    open(version);
  }

  const canSave = Boolean(title.trim() && body.trim()) && (textChanged || asksReagreement);

  async function onSave() {
    if (!canSave) return;
    // A save that asks anybody to agree again gets the hard stop; one that asks
    // nobody anything just happens, because a rollback undoes it.
    if (asksReagreement || repromptedBySave > 0) {
      const ok = await confirm({
        title: asksReagreement ? "Ask everyone to agree again?" : "Ask people to agree again?",
        description:
          repromptedBySave === 0
            ? "This publishes the new version and asks everybody to agree to it. Nobody is up to date right now, so nobody new is asked."
            : `This publishes the new version and asks ${people(repromptedBySave)} who agreed to an earlier version to agree again.`,
        details: [
          "They see a prompt on their account and membership pages until they do.",
          "Nothing is blocked: they can still train and buy a membership.",
          "No email is sent.",
        ],
        confirmLabel: "Publish and ask again",
      });
      if (!ok) return;
    }
    const outcome = await send.submit({
      run: (signal, submissionId) =>
        save({
          signal,
          data: {
            title,
            body_md: body,
            asks_reagreement: asksReagreement,
            client_submission_id: submissionId,
          },
        }),
    });
    if (!outcome.ok) return;
    const saved = outcome.value;
    // Always live by now: a version written but not made live comes back as a
    // refusal in SubmitStatus, with its number, never as a success.
    toast.success(`Saved version ${saved.version}, now live`);
    draft.clear();
    try {
      apply(await fetchVersions(), saved.version);
    } catch {
      toast.warning("Saved. The version list could not be refreshed, so reload to see it.");
    }
  }

  async function onPromote() {
    if (!selected || selected.is_current) return;
    const after = standardAfterPublishing(flags, selected.version);
    const reprompted = countReprompted(highestAccepted, standardNow, after);
    const ok = await confirm({
      title: `Make version ${selected.version} the live code of conduct?`,
      description: `Everyone reading /code-of-conduct sees version ${selected.version}, and anyone agreeing from now on agrees to it.`,
      details: [
        reprompted === 0
          ? "Nobody is asked to agree again."
          : `${people(reprompted)} who are up to date now will be asked to agree again.`,
        "Agreements already given keep the version they were given for.",
      ],
      footnote: textChanged
        ? `Your unsaved edits are not part of version ${selected.version}, so they will not go live. Save them as a new version first if you want them.`
        : undefined,
      confirmLabel: "Make it live",
    });
    if (!ok) return;
    await makeLive(selected);
  }

  async function makeLive(version: Version) {
    setPromoting(true);
    setPromoteError(null);
    try {
      await promote({ data: { id: version.id } });
      setVersions((prev) => prev.map((v) => ({ ...v, is_current: v.id === version.id })));
      toast.success(`Version ${version.version} is now live`);
    } catch (e) {
      setPromoteError(
        e instanceof Error && e.message ? e.message : "Could not change the live version.",
      );
    } finally {
      setPromoting(false);
    }
  }

  if (loading) return <Loading className="p-8" />;

  // In place of the whole editor, not beside it: saving writes a new live
  // version out of whatever is in these fields, and over a failed load they
  // would be empty.
  if (loadError)
    return (
      <section className="mx-auto max-w-2xl px-4 py-10">
        <LoadFailure
          what="The code of conduct"
          message={loadError}
          hint="Nothing has changed, and the version members read is still live. Do not edit from here until it loads: saving would publish an empty code of conduct over it."
          onRetry={() => void load()}
        />
      </section>
    );

  return (
    <>
      <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Code of conduct</h1>
            <p className="text-sm text-muted-foreground">
              Edit the rules members agree to. Saving creates a new version and publishes it on the{" "}
              <Link to="/code-of-conduct" className="underline underline-offset-2">
                code of conduct page
              </Link>
              . Agreements already given keep the version they were given for.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/account">Back to account</Link>
          </Button>
        </div>

        {draft.offered && (
          <DraftRestoreBanner
            what="code of conduct"
            savedAt={draft.offeredAt}
            onRestore={restoreDraft}
            onDiscard={draft.discard}
          />
        )}

        {versions.length === 0 && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" role="status">
            There is no version yet, so the code of conduct page has nothing to show. Write one
            below and save it to publish it.
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="min-w-0 space-y-4">
            <div>
              <Label htmlFor="coc-title">Title</Label>
              <Input
                id="coc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="coc-body">Text</Label>
              <p id="coc-syntax" className="mt-1 text-xs text-muted-foreground">
                Formatting: {CODE_OF_CONDUCT_SYNTAX}
              </p>
              <Textarea
                id="coc-body"
                aria-describedby="coc-syntax"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={CODE_OF_CONDUCT_BODY_MAX}
                rows={22}
                className="mt-1.5 font-mono text-sm"
              />
            </div>

            <div className="space-y-2 rounded-lg border p-4">
              <label className="flex items-start gap-3 text-sm font-medium">
                <Checkbox
                  checked={asksReagreement}
                  onCheckedChange={(v) => setAsksReagreement(v === true)}
                  className="mt-0.5"
                  aria-describedby="coc-reagree-effect"
                />
                Ask everyone to agree again
              </label>
              <p
                id="coc-reagree-effect"
                className="text-sm text-muted-foreground"
                aria-live="polite"
              >
                {repromptedBySave > 0
                  ? `${people(repromptedBySave)} who agreed to an earlier version will be asked to agree again.`
                  : asksReagreement
                    ? "Nobody is up to date right now, so nobody new will be asked."
                    : "Leave this off for a correction or a small change: everybody who has agreed stays up to date. Turn it on when the rules themselves change."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void onSave()} disabled={!canSave || send.busy}>
                {send.busy ? "Saving..." : "Save and publish"}
              </Button>
              {!canSave && selected && !send.busy && (
                <p className="text-sm text-muted-foreground">
                  Change the text, or ask everyone to agree again, to save a new version.
                </p>
              )}
            </div>
            <SubmitStatus
              status={send.status}
              attempt={send.attempt}
              attempts={send.attempts}
              error={send.error}
              failureKind={send.failureKind}
              onRetry={() => void onSave()}
            />
          </div>

          <aside className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  One version is live at a time. Pick one to read it, edit it, or make it live
                  again.
                </p>
                {versions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => void selectVersion(v)}
                    aria-current={v.id === selectedId}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted",
                      v.id === selectedId && "border-primary bg-muted",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">Version {v.version}</span>
                      {v.is_current ? (
                        <Badge>Live</Badge>
                      ) : (
                        <Badge variant="outline">
                          {versionLabel(v, liveVersion, v.first_published_at !== null)}
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {v.asks_reagreement
                        ? "Asked everyone to agree"
                        : "Did not ask to agree again"}
                    </span>
                  </button>
                ))}
                {promoteError && selected && (
                  <SaveFailure
                    what={`change to version ${selected.version}`}
                    message={promoteError}
                    retrying={promoting}
                    onRetry={() => void makeLive(selected)}
                    keptOnDevice={false}
                  />
                )}
                {selected && !selected.is_current && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    disabled={promoting}
                    onClick={() => void onPromote()}
                  >
                    {promoting ? "Making live..." : `Make version ${selected.version} live`}
                  </Button>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent>
            {body.trim() ? (
              // The same component the public page renders with, so what is
              // previewed here is what members read.
              <CodeOfConductDocument body={body} />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
            )}
          </CardContent>
        </Card>
      </section>
      {confirmDialog}
    </>
  );
}
