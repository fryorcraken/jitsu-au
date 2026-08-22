import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LoadingPanel } from "@/components/site/LoadingPanel";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ClubAccountDetails } from "@/components/site/ClubAccountDetails";
import { getClubSettings, saveClubSettings } from "@/lib/membership.functions";
import { invoiceMarkdownComponents } from "@/lib/invoice-markdown";
import { clubPaymentDetailsSchema, formatBsb } from "@/lib/validation";
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
  const [published, setPublished] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
        toast.error(e instanceof Error ? e.message : "Failed to load settings");
      })
      .finally(() => setLoading(false));
  }, [isManager, fetchSettings]);

  function set(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
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
    try {
      await save({ data: parsed.data });
      setErrors({});
      setPublished(true);
      toast.success("Saved. Members can see these details now.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <>
        <LoadingPanel />
      </>
    );
  }

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
            <p className="font-medium">We could not load the club's payment settings.</p>
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
              The account members pay into. These details appear on the membership page and on every
              invoice email.
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
      </section>
    </>
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
