import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { ActionFailure } from "@/components/site/ActionFailure";
import { DraftRestoreBanner } from "@/components/site/DraftRestoreBanner";
import { LoadFailure } from "@/components/site/LoadFailure";
import { Loading } from "@/components/site/Loading";
import { MarkdownEditor } from "@/components/site/MarkdownEditor";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { UserLink } from "@/components/site/UserLink";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, useRoles } from "@/hooks/useAuth";
import { useConfirm } from "@/hooks/use-confirm";
import { useEditorDraft } from "@/hooks/use-editor-draft";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import {
  CLUB_MESSAGE_GROUP_HINTS,
  CLUB_MESSAGE_GROUP_LABELS,
  LEAD_PRESELECT_DAYS,
  clubMessageGroups,
  peopleCount,
  sendConfirmTitle,
  type ClubMessageGroup,
  type LeadCandidate,
} from "@/lib/club-message";
import {
  countClubMessageAudience,
  listClubMessages,
  listMessageLeads,
  sendClubMessage,
  sendClubMessageTest,
} from "@/lib/club-message.functions";
import { formatDate, formatDateTime } from "@/lib/dates";
import { describeLoadError } from "@/lib/load-error";
import { ANNOUNCE_SUBMIT, newSubmissionId } from "@/lib/submit-resilience";

export const Route = createFileRoute("/_authenticated/manager/messages")({
  head: () => ({
    meta: [{ title: "Messages | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: MessagesPage,
});

type SendResult = Awaited<ReturnType<typeof sendClubMessage>>;
type History = Awaited<ReturnType<typeof listClubMessages>>;
type Count = Awaited<ReturnType<typeof countClubMessageAudience>>;

type DraftFields = { subject: string; body: string };
const DRAFT_SHAPE: DraftFields = { subject: "", body: "" };

/**
 * Write one club notice and send it to the people a manager ticks.
 *
 * Product rules: docs/club-messages.md. The screen does three things that are
 * easy to get wrong, so they are worth naming:
 *
 * - **The count is the server's.** It is the number of emails, households
 *   folded, asked again whenever a box changes, and it is the number the
 *   confirm repeats. Nothing here works it out on its own.
 * - **One send keeps one id.** A timeout, "Try again" and "Send the rest now"
 *   all reuse it, so nobody is emailed twice. Editing the words afterwards
 *   starts a new message with a new id.
 * - **The writing is kept on the device** until it has gone, because a phone
 *   that closes the app mid-sentence would otherwise lose it.
 */
function MessagesPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  if (rolesLoading || !isManager) return <Loading label="Checking your access..." />;
  return <Composer userId={user?.id ?? null} />;
}

function Composer({ userId }: { userId: string | null }) {
  const fetchLeads = useServerFn(listMessageLeads);
  const fetchCount = useServerFn(countClubMessageAudience);
  const fetchHistory = useServerFn(listClubMessages);
  const send = useServerFn(sendClubMessage);
  const sendTest = useServerFn(sendClubMessageTest);
  const { confirm, confirmDialog } = useConfirm();
  const submit = useResilientSubmit<SendResult>(ANNOUNCE_SUBMIT);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [groups, setGroups] = useState<Set<ClubMessageGroup>>(new Set(clubMessageGroups));
  const [leads, setLeads] = useState<LeadCandidate[] | null>(null);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [count, setCount] = useState<Count | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; to: string }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Exactly what the manager confirmed. A retry and "Send the rest now" send
  // this, never whatever is in the boxes by then, so the words cannot change
  // under one message id.
  const confirmed = useRef<{
    subject: string;
    body: string;
    groups: ClubMessageGroup[];
    leadIds: string[];
  } | null>(null);

  const draftValue = useMemo<DraftFields>(() => ({ subject, body }), [subject, body]);
  const draft = useEditorDraft<DraftFields>({
    kind: "club-message",
    scope: "new",
    owner: userId,
    value: draftValue,
    baseline: DRAFT_SHAPE,
    shape: DRAFT_SHAPE,
  });

  const loadLeads = useCallback(() => {
    setLeadsError(null);
    setLeads(null);
    fetchLeads()
      .then((rows) => {
        setLeads(rows);
        setPicked(new Set(rows.filter((l) => l.preselected).map((l) => l.registration_id)));
      })
      .catch((e) => setLeadsError(describeLoadError(e, "Could not load the leads")));
  }, [fetchLeads]);

  const loadHistory = useCallback(() => {
    setHistoryError(null);
    fetchHistory()
      .then(setHistory)
      .catch((e) => setHistoryError(describeLoadError(e, "Could not load past messages")));
  }, [fetchHistory]);

  useEffect(() => {
    loadLeads();
    loadHistory();
  }, [loadLeads, loadHistory]);

  // The count follows every tick, a moment after the last one, so a manager
  // going down the lead list is not firing a request per box.
  const groupList = useMemo(() => [...groups], [groups]);
  const leadList = useMemo(() => [...picked], [picked]);
  const countSeq = useRef(0);
  useEffect(() => {
    if (leads === null) return;
    const seq = ++countSeq.current;
    const t = setTimeout(() => {
      setCountError(null);
      fetchCount({ data: { groups: groupList, lead_ids: leadList } })
        .then((c) => {
          if (seq === countSeq.current) setCount(c);
        })
        .catch((e) => {
          if (seq === countSeq.current)
            setCountError(describeLoadError(e, "Could not count who this goes to"));
        });
    }, 300);
    return () => clearTimeout(t);
  }, [fetchCount, groupList, leadList, leads]);

  // Changing the words or the people after a send started is a new message.
  const { reset } = submit;
  function edited() {
    // Part-sent: the rest still belongs to the confirmed message, so leave it.
    if (result && result.pending > 0) return;
    confirmed.current = null;
    setResult(null);
    setFormError(null);
    reset();
  }

  function toggleGroup(g: ClubMessageGroup, on: boolean) {
    edited();
    setGroups((prev) => {
      const next = new Set(prev);
      if (on) next.add(g);
      else next.delete(g);
      return next;
    });
  }

  function toggleLead(id: string, on: boolean) {
    edited();
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function problem(): string | null {
    if (!subject.trim()) return "Give the message a subject.";
    if (/[\r\n]/.test(subject)) return "The subject has to fit on one line.";
    if (!body.trim()) return "Write the message.";
    return null;
  }

  async function onTest() {
    const p = problem();
    if (p) return setFormError(p);
    setFormError(null);
    setTestState({ kind: "sending" });
    try {
      const res = await sendTest({
        data: { kind: "notice", subject, body, client_submission_id: newSubmissionId() },
      });
      setTestState({ kind: "sent", to: res.to });
    } catch (e) {
      setTestState({ kind: "failed", message: describeLoadError(e, "The test did not send") });
    }
  }

  async function deliver() {
    const what = confirmed.current;
    // Edited since the last attempt, so there is nothing confirmed to retry:
    // ask again, with the new words and the new count.
    if (!what) return onSend();
    const outcome = await submit.submit({
      run: async (signal, messageId) => {
        const res = await send({
          signal,
          data: {
            message_id: messageId,
            kind: "notice",
            subject: what.subject,
            body: what.body,
            groups: what.groups,
            lead_ids: what.leadIds,
          },
        });
        if (!res?.message_id) throw new Error("The message did not go out.");
        return res;
      },
    });
    if (!outcome.ok) return;
    setResult(outcome.value);
    loadHistory();
    if (outcome.value.pending === 0) draft.clear();
  }

  async function onSend() {
    const p = problem();
    if (p) return setFormError(p);
    if (!count || count.emails === 0) return setFormError("Tick at least one group or one lead.");
    setFormError(null);
    const ok = await confirm({
      title: sendConfirmTitle(subject.trim(), count.emails),
      description:
        "Everyone ticked gets this email from the club, and members also see it on their Notifications page.",
      details: [
        ...clubMessageGroups
          .filter((g) => groups.has(g))
          .map((g) => `${CLUB_MESSAGE_GROUP_LABELS[g]}: ${peopleCount(count.by_group[g])}`),
        ...(count.leads > 0 ? [`Leads: ${peopleCount(count.leads)}`] : []),
      ],
      footnote: "This can't be undone.",
      confirmLabel: `Email ${peopleCount(count.emails)}`,
    });
    if (!ok) return;
    confirmed.current = { subject, body, groups: groupList, leadIds: leadList };
    await deliver();
  }

  function startAnother() {
    confirmed.current = null;
    setSubject("");
    setBody("");
    setResult(null);
    setTestState({ kind: "idle" });
    reset();
  }

  function restoreDraft() {
    const d = draft.offered;
    if (!d) return;
    setSubject(d.subject);
    setBody(d.body);
    draft.restore();
  }

  const finished = result !== null && result.pending === 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-black">Messages</h1>
        <p className="text-sm text-muted-foreground">
          Email the club about training: a closure, a time change, a venue move. It comes from the
          club, and replies go to the club's reply-to address.
        </p>
      </div>

      <section className="space-y-5 rounded-lg border p-4 md:p-6" aria-labelledby="compose-heading">
        <div>
          <h2 id="compose-heading" className="text-lg font-bold">
            Club notice
          </h2>
          <p className="text-sm text-muted-foreground">
            Facts only. A notice can't ask anyone to buy or join anything: promotions are not
            available yet.
          </p>
        </div>

        {draft.offered && (
          <DraftRestoreBanner
            what="message"
            savedAt={draft.offeredAt}
            onRestore={restoreDraft}
            onDiscard={draft.discard}
          />
        )}

        {finished ? (
          <div role="status" className="rounded-lg border border-primary/40 bg-primary/5 p-4">
            <p className="font-medium">Sent to {peopleCount(result.emailed)}.</p>
            <Button className="mt-3" variant="outline" onClick={startAnother}>
              Write another message
            </Button>
          </div>
        ) : (
          <>
            <div>
              <Label htmlFor="message-subject">Subject</Label>
              <Input
                id="message-subject"
                value={subject}
                maxLength={200}
                className="mt-1.5"
                placeholder="Dojo closed on 24 December"
                onChange={(e) => {
                  edited();
                  setSubject(e.target.value);
                }}
              />
            </div>
            <div>
              <Label htmlFor="message-body">Message</Label>
              <div className="mt-1.5">
                <MarkdownEditor
                  id="message-body"
                  rows={10}
                  value={body}
                  onChange={(next) => {
                    edited();
                    setBody(next);
                  }}
                />
              </div>
            </div>

            <fieldset className="space-y-3">
              <legend className="font-medium">Who gets it</legend>
              {clubMessageGroups.map((g) => (
                <div key={g} className="flex items-start gap-3">
                  <Checkbox
                    id={`group-${g}`}
                    checked={groups.has(g)}
                    onCheckedChange={(v) => toggleGroup(g, v === true)}
                    className="mt-0.5"
                  />
                  <div>
                    <Label htmlFor={`group-${g}`}>
                      {CLUB_MESSAGE_GROUP_LABELS[g]}
                      {count ? ` (${count.by_group[g]})` : ""}
                    </Label>
                    <p className="text-xs text-muted-foreground">{CLUB_MESSAGE_GROUP_HINTS[g]}</p>
                  </div>
                </div>
              ))}
            </fieldset>

            <LeadPicker
              leads={leads}
              error={leadsError}
              picked={picked}
              onToggle={toggleLead}
              onRetry={loadLeads}
            />

            <div aria-live="polite" className="text-sm">
              {countError ? (
                <p className="text-destructive">{countError}</p>
              ) : count ? (
                <p>
                  This will send <strong>{count.emails}</strong>{" "}
                  {count.emails === 1 ? "email" : "emails"}. A family gets one email, to the parent.
                </p>
              ) : leads !== null ? (
                <p className="text-muted-foreground">Counting...</p>
              ) : null}
            </div>

            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={() => void onTest()}
                disabled={testState.kind === "sending" || submit.busy}
              >
                {testState.kind === "sending" ? "Sending test..." : "Send me a test"}
              </Button>
              <Button
                onClick={() => void onSend()}
                disabled={submit.busy || leads === null || !count || result !== null}
              >
                {submit.busy ? "Sending..." : "Send"}
              </Button>
            </div>

            <div aria-live="polite">
              {testState.kind === "sent" && (
                <p className="text-sm text-muted-foreground">
                  Test sent to {testState.to}. Check it there before sending.
                </p>
              )}
            </div>
            {testState.kind === "failed" && (
              <ActionFailure
                title="The test did not send"
                message={testState.message}
                onDismiss={() => setTestState({ kind: "idle" })}
              />
            )}

            <SubmitStatus
              status={submit.status}
              attempt={submit.attempt}
              attempts={submit.attempts}
              error={submit.error}
              failureKind={submit.failureKind}
              onRetry={() => void deliver()}
            />

            {result && result.pending > 0 && (
              <div
                role="status"
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
              >
                <p className="font-medium">
                  Sent to {result.emailed} of {result.recipients}. {result.pending} still to go.
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Anything not sent now goes out with tomorrow morning's summary email. Nobody gets
                  it twice.
                </p>
                <Button className="mt-3" onClick={() => void deliver()} disabled={submit.busy}>
                  Send the rest now
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <HistoryList history={history} error={historyError} onRetry={loadHistory} />
      {confirmDialog}
    </div>
  );
}

function LeadPicker({
  leads,
  error,
  picked,
  onToggle,
  onRetry,
}: {
  leads: LeadCandidate[] | null;
  error: string | null;
  picked: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onRetry: () => void;
}) {
  if (error)
    return (
      <LoadFailure
        what="The leads"
        message={error}
        hint="Sending is off until they load, so nobody is left out by mistake."
        onRetry={onRetry}
      />
    );
  if (leads === null) return <Loading label="Loading leads..." />;

  return (
    <details className="rounded-lg border p-3" open={leads.some((l) => l.preselected)}>
      <summary className="font-medium">
        Leads ({picked.size} of {leads.length} ticked)
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        People who filled in the interest form and have not signed a waiver. Those from the last{" "}
        {LEAD_PRESELECT_DAYS} days start ticked. Untick anyone you have already been in touch with.
      </p>
      {leads.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No leads right now.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {leads.map((l) => (
            <li key={l.registration_id} className="flex items-start gap-3">
              <Checkbox
                id={`lead-${l.registration_id}`}
                checked={picked.has(l.registration_id)}
                onCheckedChange={(v) => onToggle(l.registration_id, v === true)}
                className="mt-0.5"
                aria-label={`Send to ${l.name}`}
              />
              <div className="text-sm">
                <UserLink userId={null} name={l.name} />
                <span className="text-muted-foreground">
                  {" "}
                  · {l.email} · registered {formatDate(l.registered_at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function HistoryList({
  history,
  error,
  onRetry,
}: {
  history: History | null;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <h2 id="history-heading" className="text-lg font-bold">
        Sent messages
      </h2>
      {error ? (
        <LoadFailure
          what="Past messages"
          message={error}
          hint="This is not the same as having sent none."
          onRetry={onRetry}
        />
      ) : history === null ? (
        <Loading label="Loading past messages..." />
      ) : history.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {history.map((m) => (
            <li key={m.id} className="p-3">
              <Link
                to="/manager/messages/$id"
                params={{ id: m.id }}
                className="font-medium underline underline-offset-2"
              >
                {m.subject}
              </Link>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(m.sent_at)}
                {m.sent_by_name ? ` by ${m.sent_by_name}` : ""} · sent to {peopleCount(m.emailed)}
                {m.pending > 0 ? `, ${m.pending} still to go` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
