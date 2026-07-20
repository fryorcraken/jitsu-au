import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle2, Download } from "lucide-react";
import {
  submitWaiverWithPdf,
  getCurrentWaiverTemplate,
  getMyLatestWaiver,
} from "@/lib/waiver.functions";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/waiver")({
  head: () => ({
    meta: [
      { title: "Sign waiver | UTS Jitsu" },
      { name: "description", content: "Complete the UTS Jitsu training waiver before your first class." },
      { property: "og:title", content: "Sign waiver | UTS Jitsu" },
      { property: "og:description", content: "Complete the UTS Jitsu training waiver online." },
      { property: "og:url", content: "https://jitsu.au/waiver" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "https://jitsu.au/waiver" }],
  }),
  component: Waiver,
});

type Prefill = {
  full_name?: string;
  date_of_birth?: string;
  address?: string;
  phone?: string;
  email?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  medical_notes?: string;
};

function Waiver() {
  const submit = useServerFn(submitWaiverWithPdf);
  const fetchTemplate = useServerFn(getCurrentWaiverTemplate);
  const fetchMine = useServerFn(getMyLatestWaiver);
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(false);
  const [ackRisk, setAckRisk] = useState(false);
  const [ackRelease, setAckRelease] = useState(false);
  const [ackMedia, setAckMedia] = useState(false);
  const [isMinor, setIsMinor] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill>({});

  const templateQ = useQuery({
    queryKey: ["waiver-template"],
    queryFn: () => fetchTemplate(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (authLoading || !user) return;
    fetchMine()
      .then((row) => { if (row) setPrefill(row as Prefill); })
      .catch(() => { /* no prior waiver */ });
  }, [authLoading, user, fetchMine]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ackRisk || !ackRelease) {
      toast.error("Please read and accept the required acknowledgements.");
      return;
    }
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      const res = await submit({
        data: {
          full_name: String(fd.get("full_name") || ""),
          date_of_birth: String(fd.get("date_of_birth") || ""),
          address: String(fd.get("address") || ""),
          phone: String(fd.get("phone") || ""),
          email: String(fd.get("email") || ""),
          emergency_contact_name: String(fd.get("emergency_contact_name") || ""),
          emergency_contact_phone: String(fd.get("emergency_contact_phone") || ""),
          medical_notes: String(fd.get("medical_notes") || ""),
          ack_risk: true,
          ack_release: true,
          ack_media: ackMedia,
          signature_name: String(fd.get("signature_name") || ""),
          hp: String(fd.get("hp") || ""),
        },
      });
      if (res.pdf_url) setPdfUrl(res.pdf_url);
      toast.success("Waiver signed. Download your copy below.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (pdfUrl) {
    return (
      <SiteLayout>
        <section className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center">
          <CheckCircle2 className="h-16 w-16 text-primary" />
          <h1 className="mt-6 text-3xl font-bold md:text-4xl">Waiver signed</h1>
          <p className="mt-3 text-muted-foreground">
            Thanks. A copy has been saved. Download your signed waiver PDF below.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <a href={pdfUrl} target="_blank" rel="noopener" download>
                <Download className="mr-2 h-4 w-4" /> Download waiver PDF
              </a>
            </Button>
            <Button asChild variant="outline"><Link to="/">Back home</Link></Button>
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            The download link expires in 1 hour. Signed-in members can re-download from their account.
          </p>
        </section>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout>
      <section className="mx-auto max-w-2xl px-4 py-16 md:py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Waiver</p>
        <h1 className="mt-3 text-4xl font-bold">Training waiver</h1>
        <p className="mt-3 text-muted-foreground">
          Please complete the waiver before your first training session. Your details are
          kept private and used only for club administration.
        </p>

        {templateQ.data && (
          <article className="mt-8 rounded-2xl border bg-muted/30 p-6 text-sm leading-relaxed">
            <h2 className="text-lg font-bold">{templateQ.data.title}</h2>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-muted-foreground">
              {templateQ.data.body_md}
            </pre>
            <p className="mt-3 text-xs text-muted-foreground">
              Placeholders like {"{{full_name}}"} will be filled in from your details on the signed PDF.
            </p>
          </article>
        )}

        <form onSubmit={onSubmit} className="mt-8 space-y-6 rounded-2xl border bg-card p-6 md:p-8">
          <input type="text" name="hp" tabIndex={-1} autoComplete="off" className="hidden" />

          {user && (
            <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
              Signed in as {user.email}. Your details have been pre-filled from your last waiver.
            </p>
          )}

          <fieldset className="space-y-5">
            <legend className="text-sm font-semibold">Your details</legend>
            <div>
              <Label htmlFor="full_name">Full name</Label>
              <Input id="full_name" name="full_name" required maxLength={120} defaultValue={prefill.full_name ?? ""} key={`n-${prefill.full_name ?? ""}`} className="mt-1.5" />
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label htmlFor="date_of_birth">Date of birth</Label>
                <Input id="date_of_birth" name="date_of_birth" type="date" required defaultValue={prefill.date_of_birth ?? ""} key={`d-${prefill.date_of_birth ?? ""}`} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" name="phone" type="tel" required maxLength={30} defaultValue={prefill.phone ?? ""} key={`p-${prefill.phone ?? ""}`} className="mt-1.5" />
              </div>
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required maxLength={255} defaultValue={prefill.email ?? user?.email ?? ""} key={`e-${prefill.email ?? user?.email ?? ""}`} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" required maxLength={300} defaultValue={prefill.address ?? ""} key={`a-${prefill.address ?? ""}`} className="mt-1.5" />
            </div>
          </fieldset>

          <fieldset className="space-y-5 border-t pt-6">
            <legend className="text-sm font-semibold">Emergency contact</legend>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label htmlFor="emergency_contact_name">Contact name</Label>
                <Input id="emergency_contact_name" name="emergency_contact_name" required maxLength={120} defaultValue={prefill.emergency_contact_name ?? ""} key={`ecn-${prefill.emergency_contact_name ?? ""}`} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="emergency_contact_phone">Contact phone</Label>
                <Input id="emergency_contact_phone" name="emergency_contact_phone" type="tel" required maxLength={30} defaultValue={prefill.emergency_contact_phone ?? ""} key={`ecp-${prefill.emergency_contact_phone ?? ""}`} className="mt-1.5" />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3 border-t pt-6">
            <legend className="text-sm font-semibold">Medical</legend>
            <Label htmlFor="medical_notes">
              Any injuries, conditions or medications we should know about? (optional)
            </Label>
            <Textarea id="medical_notes" name="medical_notes" maxLength={2000} rows={4} defaultValue={prefill.medical_notes ?? ""} key={`m-${prefill.medical_notes ?? ""}`} />
          </fieldset>

          <fieldset className="space-y-4 border-t pt-6">
            <legend className="text-sm font-semibold">Acknowledgements</legend>
            <label className="flex items-start gap-3 text-sm">
              <Checkbox checked={ackRisk} onCheckedChange={(v) => setAckRisk(v === true)} className="mt-0.5" />
              <span>
                I understand that Japanese Jiu-Jitsu involves physical contact and risk of
                injury, and I participate voluntarily at my own risk.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Checkbox checked={ackRelease} onCheckedChange={(v) => setAckRelease(v === true)} className="mt-0.5" />
              <span>
                I release Sydney Jitsu Inc, UTS Jitsu, its instructors and training partners
                from liability for injuries sustained during training, except where caused
                by gross negligence.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Checkbox checked={ackMedia} onCheckedChange={(v) => setAckMedia(v === true)} className="mt-0.5" />
              <span>
                (Optional) I consent to photos and video taken during class being used for
                club promotion on social media and the club website.
              </span>
            </label>
          </fieldset>

          <fieldset className="space-y-3 border-t pt-6">
            <legend className="text-sm font-semibold">Signature</legend>
            <Label htmlFor="signature_name">Type your full name to sign</Label>
            <Input id="signature_name" name="signature_name" required maxLength={120} placeholder="Your full name" />
            <p className="text-xs text-muted-foreground">
              By typing your name and submitting this form, you agree it constitutes an
              electronic signature dated {new Date().toLocaleDateString()}.
            </p>
          </fieldset>

          <Button type="submit" size="lg" disabled={loading} className="w-full">
            {loading ? "Generating PDF..." : "Sign and download waiver"}
          </Button>
        </form>
      </section>
    </SiteLayout>
  );
}
