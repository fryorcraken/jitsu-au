import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/site/Loading";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ClubAccountDetails } from "@/components/site/ClubAccountDetails";
import { SaveFailure } from "@/components/site/SaveFailure";
import { SubmitStatus } from "@/components/site/SubmitStatus";
import { useResilientSubmit } from "@/hooks/use-resilient-submit";
import { INTAKE_SUBMIT } from "@/lib/submit-resilience";
import { getClubSettings, saveClubSettings } from "@/lib/club-settings.functions";
import { invoiceMarkdownComponents } from "@/lib/invoice-markdown";
import { describeLoadError } from "@/lib/load-error";
import {
  CLUB_REPLY_TO_MAX,
  clubPaymentDetailsSchema,
  clubReplyToSchema,
  formatBsb,
} from "@/lib/validation";
import type { ClubPaymentDetails } from "@/lib/validation";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/settings")({
  head: () => ({
    meta: [{ title: "Club settings | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SettingsPage,
});

/** The form's fields as strings, which is what inputs deal in. */
type FormState = Record<keyof ClubPaymentDetails, string>;

const EMPTY: FormState = {
  account_name: "",
  bsb: "",
  account_number: "",
  bank_name: "",
  swift_bic: "",
  bank_address: "",
  account_holder_address: "",
  note: "",
};

/**
 * The boxes, in the order they are filled in. Grouped rather than flat: the
 * account is what everybody pays into, the overseas block only ever adds to it,
 * and mixing the two would make a required SWIFT code look plausible.
 */
const ACCOUNT_INPUTS = [
  { key: "account_name", label: "Account name", placeholder: "UTS Jitsu Club Inc" },
  { key: "bsb", label: "BSB", placeholder: "062-000", hint: "Six digits." },
  { key: "account_number", label: "Account number", placeholder: "12345678" },
  { key: "bank_name", label: "Bank", placeholder: "Commonwealth Bank of Australia" },
] as const;

const INTERNATIONAL_INPUTS = [
  {
    key: "swift_bic",
    label: "SWIFT/BIC code",
    placeholder: "CTBAAU2S",
    hint: "8 or 11 characters. Australia has no IBAN, so this is what an overseas bank asks for.",
  },
  {
    key: "bank_address",
    label: "Bank address",
    placeholder: "Sydney NSW 2000, Australia",
    hint: "The branch address some overseas banks ask for.",
  },
  {
    key: "account_holder_address",
    label: "Account holder address",
    placeholder: "1 Broadway, Ultimo NSW 2007, Australia",
    hint: "The club's own address. A PO box is not accepted for international transfers.",
  },
] as const;

function SettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchSettings = useServerFn(getClubSettings);
  const save = useServerFn(saveClubSettings);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [legacy, setLegacy] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // A failed save stays on screen beside the form, never only as a toast: what
  // a toast leaves behind is a form that looks saved while members still see
  // the old account.
  const [saveError, setSaveError] = useState<string | null>(null);
  // The load failing is its own state, not an absent one. See the panel below.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  useEffect(() => {
    if (!isManager) return;
    fetchSettings()
      .then((s) => {
        setLoadFailed(false);
        setLegacy(s.legacy_instructions);
        setReplyTo(s.email_reply_to);
        setPublished(s.details != null);
        if (s.details) {
          setForm({ ...s.details, bsb: formatBsb(s.details.bsb) });
        }
      })
      .catch((e) => {
        // Not just a toast. `getClubSettings` throws rather than return an empty
        // account precisely so a failed read cannot be mistaken for an
        // unpublished one; swallowing that here would put the empty form back on
        // screen and hand a manager the overwrite it was protecting them from.
        setLoadFailed(true);
        toast.error(describeLoadError(e, "Could not load the club's settings"));
      })
      .finally(() => setLoading(false));
  }, [isManager, fetchSettings]);

  function set(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // The panel describes the values that failed to save, not these.
    setSaveError(null);
    // Clear this field's complaint as soon as it is touched. Leaving it up while
    // somebody fixes it reads as "still wrong" when it is not.
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  // Parsed here as well as on the server so a mistyped BSB is a message under
  // the box rather than a failed save with nothing to point at.
  const parsed = clubPaymentDetailsSchema.safeParse(form);
  const preview = parsed.success ? parsed.data : null;

  async function onSave() {
    if (!parsed.success) {
      const next: Partial<Record<keyof FormState, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormState;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      toast.error("Check the highlighted fields.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await save({ data: { key: "invoice_payment_details", value: parsed.data } });
      setErrors({});
      setPublished(true);
      toast.success("Saved. Members can see these details now.");
    } catch (e) {
      const message = describeLoadError(e, "We could not reach the server.");
      setSaveError(/[.!?]$/.test(message) ? message : `${message}.`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading className="p-8" />;

  /**
   * The read failed, so we do not know what the club's account currently says.
   *
   * The form is deliberately NOT rendered here. An empty form plus "members
   * cannot see how to pay" is a lie we cannot support, and worse, it invites a
   * manager to retype the account from memory over the top of one that may be
   * perfectly fine. Nothing to type into means nothing to overwrite.
   */
  if (loadFailed) {
    return (
      <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
        <h1 className="text-3xl font-black">Club settings</h1>
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium">We could not load the club's settings.</p>
            <p className="mt-1 text-muted-foreground">
              Nothing has changed, and members are unaffected. We have not shown the form because we
              cannot tell you what is in it right now, and saving over details we could not read is
              worse than waiting a minute.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => window.location.reload()}>
                Try again
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link to="/manager/memberships">Back to memberships</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Club settings</h1>
            <p className="text-sm text-muted-foreground">
              The account members pay into, and where replies to the club's emails go.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/manager/memberships">Back to memberships</Link>
          </Button>
        </div>

        {/* Leads, rather than sits at the bottom: while this is showing, nobody
            can pay us. Suppressed when the read failed, because then we do not
            know whether it is true. */}
        {!published && !loadFailed && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-medium">Members cannot see how to pay yet.</p>
              <p className="mt-1 text-muted-foreground">
                Fill in the account below and save. Until you do, the membership page and every
                invoice email tell people to get in touch instead.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">The club's account</h2>
              {ACCOUNT_INPUTS.map((field) => (
                <Field
                  key={field.key}
                  id={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  hint={"hint" in field ? field.hint : undefined}
                  value={form[field.key]}
                  error={errors[field.key]}
                  onChange={(v) => set(field.key, v)}
                />
              ))}
            </div>

            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">For overseas payers</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Optional, and only shown to someone who opens "Paying from overseas?" on the
                  membership page.
                </p>
              </div>
              {INTERNATIONAL_INPUTS.map((field) => (
                <Field
                  key={field.key}
                  id={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  hint={field.hint}
                  value={form[field.key]}
                  error={errors[field.key]}
                  onChange={(v) => set(field.key, v)}
                />
              ))}
            </div>

            <div>
              <Label htmlFor="note">Note (optional, Markdown)</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Anything the boxes above don't cover, like a PayID. Shown under the account details.
              </p>
              <Textarea
                id="note"
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
                rows={4}
                maxLength={1000}
                className="mt-2 text-sm"
              />
              {errors.note && <p className="mt-1 text-xs text-destructive">{errors.note}</p>}
            </div>

            {saveError && (
              <SaveFailure
                what="account"
                message={`${saveError} Members still see the details that were there before.`}
                onRetry={() => void onSave()}
                retrying={saving}
                keptOnDevice={false}
              />
            )}
            <Button onClick={onSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What members see</CardTitle>
                <CardDescription>
                  The same panel as the membership page, updating as you type.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ClubAccountDetails details={preview} />
              </CardContent>
            </Card>

            {/* The free text these fields replaced. Read-only, and only worth
                showing while the account is still empty: it is where the values
                being typed in are most likely to be found. */}
            {!published && legacy && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Your previous instructions</CardTitle>
                  <CardDescription>
                    No longer shown to anyone. Copy the details across, then this box goes away.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground">
                    <ReactMarkdown components={invoiceMarkdownComponents}>{legacy}</ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <ReplyToCard initial={replyTo} />
      </section>
    </>
  );
}

/**
 * The address a reply to any club email reaches. Its own card with its own
 * Save, because it has nothing to do with the bank account and a manager
 * fixing one should not have to re-validate the other.
 *
 * Saved through `useResilientSubmit`: the save is an upsert of one value, so a
 * retry after a lost answer writes the same thing again and is safe.
 */
function ReplyToCard({ initial }: { initial: string | null }) {
  const save = useServerFn(saveClubSettings);
  const send = useResilientSubmit<{ ok: true }>(INTAKE_SUBMIT);
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState<string | null>(initial);
  const [touched, setTouched] = useState(false);

  const parsed = clubReplyToSchema.safeParse(value);
  const problem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the address.");
  const unchanged = parsed.success && parsed.data === (saved ?? "");

  function onChange(next: string) {
    setValue(next);
    // A failure panel describes the value that failed to save. Once the box is
    // edited it is about something nobody has tried to save yet.
    if (send.status === "failed") send.reset();
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    const address = parsed.data;
    const outcome = await send.submit({
      run: (signal) => save({ signal, data: { key: "email_reply_to", value: address } }),
    });
    if (outcome.ok) {
      setSaved(address || null);
      setValue(address);
      setTouched(false);
      send.reset();
      toast.success(
        address
          ? `Saved. Replies to club emails now go to ${address}.`
          : "Cleared. Club emails now point people at the contact page instead.",
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Replies to club emails</CardTitle>
        <CardDescription>
          When someone replies to an invoice, receipt or waiver email, it goes here. Use an inbox
          someone reads.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
          <p className="text-sm" role="status">
            {saved ? (
              <>
                Replies go to <strong>{saved}</strong>.
              </>
            ) : (
              <>
                Not set. Replies to club emails reach nobody, so every email points people at the
                contact page, phone and WhatsApp instead.
              </>
            )}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="email_reply_to">Reply-to address</Label>
            <p id="email_reply_to-hint" className="text-xs text-muted-foreground">
              Any address, on any domain. Leave it empty and save to stop offering replies.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="email_reply_to"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={value}
                maxLength={CLUB_REPLY_TO_MAX}
                placeholder="hello@example.com"
                onChange={(e) => onChange(e.target.value)}
                disabled={send.busy}
                aria-invalid={touched && problem ? true : undefined}
                aria-describedby={
                  touched && problem
                    ? "email_reply_to-hint email_reply_to-error"
                    : "email_reply_to-hint"
                }
              />
              <Button type="submit" disabled={send.busy || unchanged}>
                {send.busy ? "Saving..." : "Save address"}
              </Button>
            </div>
            {touched && problem && (
              <p id="email_reply_to-error" role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            )}
          </div>
          <SubmitStatus
            status={send.status}
            attempt={send.attempt}
            attempts={send.attempts}
            error={send.error}
            failureKind={send.failureKind}
            onRetry={() => void submit()}
          />
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  placeholder,
  hint,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  hint?: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className="mt-1.5"
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
