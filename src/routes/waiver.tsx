import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { SiteLayout } from "@/components/site/SiteLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { submitWaiver } from "@/lib/submissions.functions";

export const Route = createFileRoute("/waiver")({
  head: () => ({
    meta: [
      { title: "Sign waiver — UTS Jitsu" },
      { name: "description", content: "Complete the UTS Jitsu training waiver before your first class." },
      { property: "og:title", content: "Sign waiver — UTS Jitsu" },
      { property: "og:description", content: "Complete the UTS Jitsu training waiver online." },
      { property: "og:url", content: "/waiver" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: "/waiver" }],
  }),
  component: Waiver,
});

function Waiver() {
  const navigate = useNavigate();
  const submit = useServerFn(submitWaiver);
  const [loading, setLoading] = useState(false);
  const [ackRisk, setAckRisk] = useState(false);
  const [ackRelease, setAckRelease] = useState(false);
  const [ackMedia, setAckMedia] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ackRisk || !ackRelease) {
      toast.error("Please read and accept the required acknowledgements.");
      return;
    }
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      await submit({
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
      navigate({ to: "/thank-you", search: { kind: "waiver" } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
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

        <form onSubmit={onSubmit} className="mt-8 space-y-6 rounded-2xl border bg-card p-6 md:p-8">
          <input type="text" name="hp" tabIndex={-1} autoComplete="off" className="hidden" />

          <fieldset className="space-y-5">
            <legend className="text-sm font-semibold">Your details</legend>
            <div>
              <Label htmlFor="full_name">Full name</Label>
              <Input id="full_name" name="full_name" required maxLength={120} className="mt-1.5" />
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label htmlFor="date_of_birth">Date of birth</Label>
                <Input id="date_of_birth" name="date_of_birth" type="date" required className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" name="phone" type="tel" required maxLength={30} className="mt-1.5" />
              </div>
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required maxLength={255} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" required maxLength={300} className="mt-1.5" />
            </div>
          </fieldset>

          <fieldset className="space-y-5 border-t pt-6">
            <legend className="text-sm font-semibold">Emergency contact</legend>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <Label htmlFor="emergency_contact_name">Contact name</Label>
                <Input id="emergency_contact_name" name="emergency_contact_name" required maxLength={120} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="emergency_contact_phone">Contact phone</Label>
                <Input id="emergency_contact_phone" name="emergency_contact_phone" type="tel" required maxLength={30} className="mt-1.5" />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3 border-t pt-6">
            <legend className="text-sm font-semibold">Medical</legend>
            <Label htmlFor="medical_notes">
              Any injuries, conditions or medications we should know about? (optional)
            </Label>
            <Textarea id="medical_notes" name="medical_notes" maxLength={2000} rows={4} />
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
            {loading ? "Submitting..." : "Sign and submit waiver"}
          </Button>
        </form>
      </section>
    </SiteLayout>
  );
}
