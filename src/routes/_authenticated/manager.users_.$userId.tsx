import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { deriveExpandedWaivers, formatCents } from "@/lib/validation";
import { getClubUser } from "@/lib/club-user.functions";
import { getWaiverPdfUrl, setWaiverApproval } from "@/lib/waiver.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/users_/$userId")({
  head: () => ({
    meta: [{ title: "User | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
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

const WAIVER_CLASS: Record<Waiver["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  superseded: "bg-slate-100 text-slate-800",
};

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU") : "—";
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

/** The signing context blob, rendered as plain rows so nothing is hidden. */
function SignerMeta({ meta }: { meta: unknown }) {
  const entries =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? Object.entries(meta as Record<string, unknown>)
      : [];
  if (!entries.length) return null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <Field
          key={key}
          label={key.replace(/_/g, " ")}
          value={Array.isArray(value) ? value.join(", ") : String(value)}
        />
      ))}
    </dl>
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
  const [pdfUrls, setPdfUrls] = useState<Record<string, string>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const load = useCallback(
    async (resetOpen: boolean) => {
      const data = (await fetchDetail({ data: { userId } })) as Detail;
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
    load(true)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load user"))
      .finally(() => setLoading(false));
  }, [isManager, load]);

  // A signed PDF URL is short-lived, so fetch it only for panels actually
  // opened, and only once per panel.
  const ensurePdfUrl = useCallback(
    async (waiver: Waiver) => {
      if (!waiver.has_pdf || pdfUrls[waiver.id]) return;
      try {
        const { url } = await getUrl({ data: { id: waiver.id } });
        setPdfUrls((prev) => ({ ...prev, [waiver.id]: url }));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load the PDF");
      }
    },
    [getUrl, pdfUrls],
  );

  useEffect(() => {
    if (!detail) return;
    for (const w of detail.waivers) if (open.has(w.id)) void ensurePdfUrl(w);
  }, [detail, open, ensurePdfUrl]);

  function toggle(id: string, next: boolean) {
    setOpen((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  async function setApproval(id: string, status: "approved" | "pending") {
    setApprovingId(id);
    try {
      await approve({ data: { id, status } });
      // Statuses are derived per person (active vs superseded), so refetch.
      await load(false);
      toast.success(
        status === "approved"
          ? "Waiver approved. The member's record has been updated."
          : "Approval removed. The waiver is pending again.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update approval");
    } finally {
      setApprovingId(null);
    }
  }

  async function download(id: string) {
    try {
      const { url } = await getUrl({ data: { id } });
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
          <p className="text-sm text-muted-foreground">
            {summary.email ?? "No email on file"}
            {summary.phone ? ` · ${summary.phone}` : ""}
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

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-lg font-bold">Profile</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          The club's current record. Approving a waiver copies that submission's details here.
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Preferred name" value={profile.preferred_name} />
          <Field label="Date of birth" value={fmtDate(profile.date_of_birth)} />
          <Field label="Phone" value={summary.phone} />
          <Field label="Address" value={profile.address} />
          <Field
            label="UTS student number"
            value={summary.uts_student_number ?? (summary.is_uts_student ? "Yes" : "No")}
          />
          <Field label="Emergency contact" value={profile.emergency_contact_name} />
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
          <Field label="First seen" value={fmtDate(summary.first_seen_at)} />
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
                        disabled={approvingId === w.id}
                      >
                        {approvingId === w.id ? "Approving..." : "Approve"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setApproval(w.id, "pending")}
                        disabled={approvingId === w.id}
                      >
                        {approvingId === w.id ? "Updating..." : "Unapprove"}
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
                      <Field label="Date of birth" value={fmtDate(w.date_of_birth)} />
                      <Field label="Address" value={w.address} />
                      <Field label="UTS student number" value={w.uts_student_number} />
                      <Field label="Emergency contact" value={w.emergency_contact_name} />
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

                    {w.has_pdf ? (
                      pdfUrls[w.id] ? (
                        <iframe
                          src={pdfUrls[w.id]}
                          title={`Signed waiver ${fmtDateTime(w.signed_at)}`}
                          className="h-[70vh] w-full rounded-md border bg-muted"
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">Loading the signed PDF...</p>
                      )
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No PDF was stored for this submission.
                      </p>
                    )}

                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        Signing record
                      </summary>
                      <div className="mt-2 space-y-2">
                        <Field label="Signer IP" value={w.signer_ip} />
                        <SignerMeta meta={w.signer_meta} />
                      </div>
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
