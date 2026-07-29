import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { deriveExpandedWaivers, formatCents, type WaiverApprovalStatus } from "@/lib/validation";
import { emailVerificationLabel, isEmailVerified } from "@/lib/email-verification";
import { isSignedUrlFresh, shouldFetchSignedUrl } from "@/lib/signed-url-cache";
import type { SignedUrlEntry } from "@/lib/signed-url-cache";
import {
  getClubUser,
  resendClubUserVerification,
  setClubUserEmail,
} from "@/lib/club-user.functions";
import { getWaiverPdfUrl, setWaiverApproval } from "@/lib/waiver.functions";
import { runApproval } from "@/lib/waiver-approval";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/users_/$userId")({
  head: () => ({
    meta: [{ title: "User | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  // Remount on a different person. Without this the router reuses one component
  // instance across /manager/users/A -> /manager/users/B, so an approval's
  // refetch issued for A (its closure holds A's id) could land after B's load
  // and paint A's record, Approve buttons and all, under B's URL.
  remountDeps: ({ params }) => params.userId,
  component: ManagerUserPage,
});

type Detail = Awaited<ReturnType<typeof getClubUser>>;
type Waiver = Detail["waivers"][number];

const LIFECYCLE_CLASS: Record<string, string> = {
  lead: "bg-slate-100 text-slate-800",
  applicant: "bg-amber-100 text-amber-800",
  visitor: "bg-sky-100 text-sky-800",
  member: "bg-green-100 text-green-800",
  lapsed: "bg-red-100 text-red-800",
};

const MEMBERSHIP_CLASS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  expired: "bg-red-100 text-red-800",
  cancelled: "bg-slate-100 text-slate-800",
};

// Keep in step with manager.users.tsx: a manager moves between both screens.
const VERIFICATION_CLASS: Record<string, string> = {
  verified: "bg-green-100 text-green-800",
  unverified: "bg-amber-100 text-amber-800",
};

// The same three derived statuses the signed-waivers screen shows, in the same
// colours: a manager moves between both screens, so "pending" must not be grey
// on one and amber on the other. Keep in step with manager.waivers.tsx.
const WAIVER_CLASS: Record<Waiver["status"], string> = {
  pending: "bg-muted text-muted-foreground",
  active: "bg-primary/15 text-primary",
  superseded: "bg-muted text-muted-foreground line-through",
};

/** A copy of `record` without `key`. */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU") : "—";
}

/**
 * A `DATE` column arrives as `YYYY-MM-DD`. `new Date` would read that as UTC
 * midnight and shift it a day back for a manager in a negative-offset timezone,
 * so format the parts directly: a birth date has no timezone.
 */
function fmtDateOnly(value: string | null): string {
  if (!value) return "—";
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : value;
}

function fmtDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("en-AU") : "—";
}

function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        className,
      )}
    >
      {label}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words">{value || "—"}</dd>
    </div>
  );
}

/**
 * The signing context blob, rendered as plain rows so nothing is hidden.
 * Emits bare <Field>s: the caller owns the surrounding <dl>.
 */
function SignerMeta({ meta }: { meta: unknown }) {
  const entries =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? Object.entries(meta as Record<string, unknown>)
      : [];
  return (
    <>
      {entries.map(([key, value]) => (
        <Field
          key={key}
          label={key.replace(/_/g, " ")}
          value={Array.isArray(value) ? value.join(", ") : String(value)}
        />
      ))}
    </>
  );
}

/**
 * The person's email address: what it is, whether anyone has proved they can
 * read it, and the two things a manager can do about it.
 *
 * Correcting an address is the only email-editing path in the product, and it
 * always drops the person back to unverified: the new address has never been
 * proven, whatever was true of the old one. There is deliberately no "mark as
 * verified" here, because a badge a manager could set would only ever mean "a
 * manager believed this".
 */
function EmailCard({
  userId,
  email,
  emailConfirmedAt,
  onChanged,
}: {
  userId: string;
  email: string | null;
  emailConfirmedAt: string | null;
  onChanged: () => void;
}) {
  const changeEmail = useServerFn(setClubUserEmail);
  const resend = useServerFn(resendClubUserVerification);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(email ?? "");
  const [busy, setBusy] = useState(false);
  const verified = isEmailVerified(emailConfirmedAt);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await changeEmail({ data: { userId, email: draft } });
      if (!res.changed) {
        toast.success("That's already their email. Nothing changed.");
      } else if (res.verificationSent) {
        toast.success("Email updated. We sent a confirmation link to the new address.");
      } else {
        // The address moved but the email did not go out. Say so plainly: the
        // manager is the only one who can act on it, and telling them a link
        // was sent would surface as "the member never got anything" days later.
        toast.warning("Email updated, but we couldn't send the confirmation link. Try resending.");
      }
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update that email.");
    } finally {
      setBusy(false);
    }
  }

  async function sendAgain() {
    setBusy(true);
    try {
      const res = await resend({ data: { userId } });
      toast.success(
        res.alreadyVerified
          ? "That address is already confirmed."
          : "Verification email sent to " + res.email,
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send that email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <h2 className="mb-3 text-lg font-bold">Email</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        {verified
          ? `Confirmed on ${fmtDate(emailConfirmedAt)}, when they opened a link we sent here.`
          : "Nobody has opened a link we sent to this address yet. Approving a waiver emails a sign-in link here, so a typo means it goes nowhere."}
      </p>

      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <Label htmlFor="member-email">New email</Label>
            <Input
              id="member-email"
              type="email"
              required
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraft(email ?? "");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{email ?? "—"}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change email
          </Button>
          {!verified && email ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={sendAgain}>
              {busy ? "Sending..." : "Resend verification"}
            </Button>
          ) : null}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Changing this moves their login too. Signed waivers keep the address as it was typed, as
        evidence, so an older submission below can legitimately show a different one.
      </p>
    </div>
  );
}

function ManagerUserPage() {
  const { userId } = Route.useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchDetail = useServerFn(getClubUser);
  const getUrl = useServerFn(getWaiverPdfUrl);
  const approve = useServerFn(setWaiverApproval);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pdfs, setPdfs] = useState<Record<string, SignedUrlEntry>>({});
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  // Only the newest load's result may land: back-to-back approvals each trigger
  // their own refetch. (A different person is a different component instance —
  // see remountDeps above.)
  const loadSeq = useRef(0);
  const pdfInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useCallback(
    async (resetOpen: boolean) => {
      const seq = ++loadSeq.current;
      const data = await fetchDetail({ data: { userId } });
      if (seq !== loadSeq.current) return null; // a newer load won
      setDetail(data);
      // Only the newest still-pending submission opens by itself; a manager's
      // own expand/collapse choices survive a refetch after an approval.
      if (resetOpen) setOpen(deriveExpandedWaivers(data.waivers));
      return data;
    },
    [fetchDetail, userId],
  );

  useEffect(() => {
    if (!isManager) return;
    let active = true;
    setLoading(true);
    setError(null);
    load(true)
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Failed to load user");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isManager, load]);

  // Sign a PDF URL only for panels actually open, and re-sign a stale one:
  // Radix unmounts collapsed content, so re-expanding an old panel remounts the
  // iframe and would otherwise reuse a dead URL. See `signed-url-cache` for the
  // freshness rule.
  const ensurePdfUrl = useCallback(
    async (waiver: Waiver) => {
      if (!waiver.has_pdf) return;
      const cached = pdfs[waiver.id];
      if (!shouldFetchSignedUrl(cached, Date.now())) return;
      if (pdfInFlight.current.has(waiver.id)) return;
      pdfInFlight.current.add(waiver.id);
      // Drop the stale URL before re-signing, so the iframe remounts on the
      // loading line rather than flashing the storage error for an expired one.
      if (cached?.url) setPdfs((prev) => omitKey(prev, waiver.id));
      try {
        const { url } = await getUrl({ data: { id: waiver.id } });
        setPdfs((prev) => ({ ...prev, [waiver.id]: { url, at: Date.now() } }));
      } catch (e) {
        setPdfs((prev) => ({
          ...prev,
          [waiver.id]: {
            at: Date.now(),
            error: e instanceof Error ? e.message : "Failed to load the PDF",
          },
        }));
      } finally {
        pdfInFlight.current.delete(waiver.id);
      }
    },
    [getUrl, pdfs],
  );

  useEffect(() => {
    if (!detail) return;
    for (const w of detail.waivers) if (open.has(w.id)) void ensurePdfUrl(w);
  }, [detail, open, ensurePdfUrl]);

  function retryPdf(id: string) {
    setPdfs((prev) => omitKey(prev, id));
  }

  function toggle(id: string, next: boolean) {
    setOpen((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  function markApproving(id: string, busy: boolean) {
    setApprovingIds((prev) => {
      const set = new Set(prev);
      if (busy) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  async function setApproval(id: string, status: WaiverApprovalStatus) {
    markApproving(id, true);
    // Statuses are derived per person (active vs superseded), so refresh by
    // refetching the whole person rather than patching one waiver. `load`
    // answers null when a newer load owns the screen, which stays quiet.
    const outcome = await runApproval({
      status,
      approve: () => approve({ data: { id, status } }),
      refresh: async () => (await load(false)) !== null,
    });
    markApproving(id, false);
    if (outcome.kind !== "stale") toast[outcome.severity](outcome.message);
  }

  async function download(id: string) {
    try {
      const cached = pdfs[id];
      if (isSignedUrlFresh(cached, Date.now())) {
        window.open(cached.url, "_blank", "noopener");
        return;
      }
      const { url } = await getUrl({ data: { id } });
      // Keep the panel in step: this URL is as good as the one it holds, and
      // writing it back clears a stale entry or a recorded error.
      setPdfs((prev) => ({ ...prev, [id]: { url, at: Date.now() } }));
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to get PDF");
    }
  }

  if (loading) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-10">
        <p>Loading...</p>
      </section>
    );
  }

  if (error || !detail) {
    return (
      <section className="mx-auto max-w-5xl space-y-4 px-4 py-10">
        <p className="text-sm text-muted-foreground">{error ?? "User not found."}</p>
        <Button asChild variant="outline">
          <Link to="/manager/users">Back to users</Link>
        </Button>
      </section>
    );
  }

  const { user: summary, profile, memberships, waivers } = detail;

  return (
    <section className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-3xl font-black">{summary.name ?? summary.email ?? "User"}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              label={summary.lifecycle_status}
              className={LIFECYCLE_CLASS[summary.lifecycle_status] ?? "bg-slate-100 text-slate-800"}
            />
            {summary.roles.map((role) => (
              <Pill key={role} label={role} className="bg-indigo-100 text-indigo-800" />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {/* Every person has an email (it lives on their login record), so a
                missing one here means the lookup failed, not that we hold none. */}
            <span>{summary.email ?? "Email lookup failed"}</span>
            {summary.email ? (
              <Pill
                label={emailVerificationLabel(summary.email_confirmed_at)}
                className={VERIFICATION_CLASS[emailVerificationLabel(summary.email_confirmed_at)]}
              />
            ) : null}
            {summary.phone ? <span>· {summary.phone}</span> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            First seen {fmtDate(summary.first_seen_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/manager/users">Back to users</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/manager/memberships">Memberships</Link>
          </Button>
        </div>
      </div>

      <EmailCard
        userId={userId}
        email={summary.email}
        emailConfirmedAt={summary.email_confirmed_at}
        onChanged={() => void load(false)}
      />

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-bold">Profile</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          The club's current record. Approving a waiver copies that submission's details here.
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Preferred name" value={profile.preferred_name} />
          <Field label="Date of birth" value={fmtDateOnly(profile.date_of_birth)} />
          <Field label="Phone" value={profile.phone} />
          <Field label="Address" value={profile.address} />
          <Field label="UTS student number" value={profile.uts_student_number} />
          <Field label="Emergency contact" value={profile.emergency_contact_name} />
          <Field label="Emergency relationship" value={profile.emergency_contact_relationship} />
          <Field label="Emergency phone" value={profile.emergency_contact_phone} />
          <Field label="Medical notes" value={profile.medical_notes} />
          <Field label="Minor" value={profile.is_minor ? "Yes" : "No"} />
          {profile.is_minor ? (
            <>
              <Field label="Guardian" value={profile.guardian_name} />
              <Field label="Guardian relationship" value={profile.guardian_relationship} />
            </>
          ) : null}
          <Field
            label="SMS / WhatsApp consent"
            value={profile.sms_whatsapp_consent ? "Yes" : "No"}
          />
          <Field label="Record updated" value={fmtDateTime(profile.updated_at)} />
        </dl>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-bold">Memberships</h2>
        {memberships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No memberships yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Reference</th>
                  <th className="px-3 py-2">Starts</th>
                  <th className="px-3 py-2">Ends</th>
                  <th className="px-3 py-2">Sessions left</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{m.plan_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Pill
                        label={m.status}
                        className={MEMBERSHIP_CLASS[m.status] ?? "bg-slate-100 text-slate-800"}
                      />
                    </td>
                    <td className="px-3 py-2">{formatCents(m.price_cents)}</td>
                    <td className="px-3 py-2">{m.payment_reference ?? "—"}</td>
                    <td className="px-3 py-2">{fmtDate(m.starts_at)}</td>
                    <td className="px-3 py-2">{fmtDate(m.ends_at)}</td>
                    <td className="px-3 py-2">{m.sessions_remaining ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-bold">Waivers</h2>
        <p className="text-sm text-muted-foreground">
          Every submission, newest first. The newest one opens automatically while it still needs a
          decision; approved and older submissions stay collapsed.
        </p>
        {waivers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No waivers signed yet.</p>
        ) : (
          waivers.map((w) => {
            const isOpen = open.has(w.id);
            const busy = approvingIds.has(w.id);
            const pdf = pdfs[w.id];
            return (
              <Collapsible
                key={w.id}
                open={isOpen}
                onOpenChange={(next) => toggle(w.id, next)}
                className="rounded-lg border"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <CollapsibleTrigger className="flex items-center gap-2 text-left">
                    <ChevronDown
                      className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
                    />
                    <span>
                      <span className="font-medium">{fmtDateTime(w.signed_at)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        v{w.template_version ?? "—"}
                      </span>
                    </span>
                    <Pill label={w.status} className={WAIVER_CLASS[w.status]} />
                  </CollapsibleTrigger>
                  <div className="flex flex-wrap items-center gap-2">
                    {w.status === "pending" ? (
                      <Button
                        size="sm"
                        onClick={() => setApproval(w.id, "approved")}
                        disabled={busy}
                      >
                        {busy ? "Approving..." : "Approve"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setApproval(w.id, "pending")}
                        disabled={busy}
                      >
                        {busy ? "Updating..." : "Unapprove"}
                      </Button>
                    )}
                    {w.has_pdf ? (
                      <Button size="sm" variant="outline" onClick={() => download(w.id)}>
                        <Download className="mr-1 h-3 w-3" /> PDF
                      </Button>
                    ) : null}
                  </div>
                </div>

                <CollapsibleContent>
                  <div className="space-y-4 border-t p-3">
                    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <Field label="Name as signed" value={w.full_name} />
                      <Field label="Email" value={w.email} />
                      <Field label="Phone" value={w.phone} />
                      <Field label="Date of birth" value={fmtDateOnly(w.date_of_birth)} />
                      <Field label="Address" value={w.address} />
                      <Field label="UTS student number" value={w.uts_student_number} />
                      <Field label="Emergency contact" value={w.emergency_contact_name} />
                      <Field
                        label="Emergency relationship"
                        value={w.emergency_contact_relationship}
                      />
                      <Field label="Emergency phone" value={w.emergency_contact_phone} />
                      <Field label="Medical notes" value={w.medical_notes} />
                      <Field label="Minor" value={w.is_minor ? "Yes" : "No"} />
                      {w.is_minor ? (
                        <>
                          <Field label="Guardian" value={w.guardian_name} />
                          <Field label="Guardian relationship" value={w.guardian_relationship} />
                        </>
                      ) : null}
                      <Field
                        label="SMS / WhatsApp consent"
                        value={w.sms_whatsapp_consent ? "Yes" : "No"}
                      />
                      <Field label="Approved" value={fmtDateTime(w.approved_at)} />
                    </dl>

                    {!w.has_pdf ? (
                      <p className="text-sm text-muted-foreground">
                        No PDF was stored for this submission.
                      </p>
                    ) : pdf?.error ? (
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="text-muted-foreground">{pdf.error}</span>
                        <Button size="sm" variant="outline" onClick={() => retryPdf(w.id)}>
                          Try again
                        </Button>
                      </div>
                    ) : pdf?.url ? (
                      <iframe
                        src={pdf.url}
                        title={`Signed waiver ${fmtDateTime(w.signed_at)}`}
                        referrerPolicy="no-referrer"
                        className="h-[70vh] w-full rounded-md border bg-muted"
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Loading the signed PDF...</p>
                    )}

                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        Signing record
                      </summary>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Field label="Signer IP" value={w.signer_ip} />
                        <SignerMeta meta={w.signer_meta} />
                      </dl>
                    </details>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}
      </div>
    </section>
  );
}
