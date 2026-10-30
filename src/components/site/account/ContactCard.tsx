import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loading } from "@/components/site/Loading";
import { AddressFields } from "@/components/site/AddressFields";
import {
  auAddressDraft,
  auAddressFromRow,
  finishedAddress,
  composeAuAddress,
  draftFromLine,
  type AddressDraft,
} from "@/lib/au-address";
import { SaveFailure } from "@/components/site/SaveFailure";
import { CardActions } from "./CardActions";
import { useDetailsSave, type DetailsCardProps } from "./DetailsCard";

/**
 * The address to start the card from: the parts when the club holds them,
 * else the one line read where that is unambiguous (`draftFromLine`), and
 * whether the line could be read at all, so one that cannot is shown above the
 * empty boxes rather than lost.
 */
function readStoredAddress(row: {
  address?: string | null;
  address_street?: string | null;
  address_suburb?: string | null;
  address_state?: string | null;
  address_postcode?: string | null;
}): { address: AddressDraft; addressUnread: boolean } {
  const parts = auAddressFromRow(row);
  if (parts) return { address: auAddressDraft(parts), addressUnread: false };
  const own = draftFromLine(row.address, "own");
  return { address: own.draft, addressUnread: !own.read };
}

/**
 * How the club reaches this person, and who it calls if something happens.
 *
 * The warning in the description is not boilerplate: approving a waiver still
 * promotes that submission's contact fields onto the profile
 * (`waiverToProfileFields`), so a correction made here can be overwritten later
 * by a manager working through a backlog of older waivers.
 */
export function ContactCard({ userId, voice, profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save, saveError, clearSaveError, retrySave } = useDetailsSave({
    userId,
    profile,
    onSaved,
  });
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState<AddressDraft>(auAddressDraft(null));
  // Pressing Save with part of the address missing is the one way this card
  // can be refused before it is sent, so it says which part, under the field.
  const [attempted, setAttempted] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [ecName, setEcName] = useState("");
  const [ecRelationship, setEcRelationship] = useState("");
  const [ecPhone, setEcPhone] = useState("");

  // See AboutYouCard: keyed on this card's own fields, never on `profile`.
  const stored = useMemo(
    () => ({
      phone: profile?.phone ?? "",
      ...readStoredAddress({
        address: profile?.address,
        address_street: profile?.address_street,
        address_suburb: profile?.address_suburb,
        address_state: profile?.address_state,
        address_postcode: profile?.address_postcode,
      }),
      addressLine: profile?.address ?? "",
      smsConsent: profile?.sms_whatsapp_consent ?? false,
      ecName: profile?.emergency_contact_name ?? "",
      ecRelationship: profile?.emergency_contact_relationship ?? "",
      ecPhone: profile?.emergency_contact_phone ?? "",
    }),
    [
      profile?.phone,
      profile?.address,
      profile?.address_street,
      profile?.address_suburb,
      profile?.address_state,
      profile?.address_postcode,
      profile?.sms_whatsapp_consent,
      profile?.emergency_contact_name,
      profile?.emergency_contact_relationship,
      profile?.emergency_contact_phone,
    ],
  );

  const revert = useMemo(
    () => () => {
      setPhone(stored.phone);
      setAddress(stored.address);
      setAttempted(false);
      setSmsConsent(stored.smsConsent);
      setEcName(stored.ecName);
      setEcRelationship(stored.ecRelationship);
      setEcPhone(stored.ecPhone);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const addressChanged =
    Boolean(address.overseas) !== Boolean(stored.address.overseas) ||
    (["street", "suburb", "state", "postcode", "country"] as const).some(
      (part) => (address[part] ?? "") !== (stored.address[part] ?? ""),
    );
  const dirty =
    phone !== stored.phone ||
    addressChanged ||
    smsConsent !== stored.smsConsent ||
    ecName !== stored.ecName ||
    ecRelationship !== stored.ecRelationship ||
    ecPhone !== stored.ecPhone;

  // The line on file could not be read as parts: show it while the member
  // copies it into the boxes, so it is there to read until they are done.
  const previousLine =
    stored.addressUnread && !finishedAddress(address) ? stored.addressLine : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The address is only checked, and only sent, when it was edited. Saving a
    // new mobile must not depend on an address the club could not split, and
    // it must not rewrite the address line as typed into the composed one.
    const finished = addressChanged ? finishedAddress(address) : null;
    if (addressChanged && !finished) {
      setAttempted(true);
      return;
    }
    await save(
      {
        phone: phone.trim(),
        // The parts, plus the line made from them so this page's copy of the
        // profile reads right straight away. The server composes the line
        // itself and does not take this one on trust.
        ...(finished?.parts
          ? {
              address_street: finished.parts.street,
              address_suburb: finished.parts.suburb,
              address_state: finished.parts.state,
              address_postcode: finished.parts.postcode,
              address: composeAuAddress(finished.parts),
            }
          : {}),
        // An address outside Australia goes as its one line, with no parts:
        // the database clears any it held for the old address.
        ...(finished?.line ? { address: finished.line } : {}),
        sms_whatsapp_consent: smsConsent,
        emergency_contact_name: ecName.trim(),
        emergency_contact_relationship: ecRelationship.trim(),
        emergency_contact_phone: ecPhone.trim(),
      },
      "Contact details saved",
      `Could not save ${voice.whose} contact details`,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact</CardTitle>
        <CardDescription>
          {voice.isSelf
            ? "How we reach you, and who we call if something happens in class."
            : `How we reach you about ${voice.who}, and who we call if something happens in class.`}{" "}
          Saving here updates our current record straight away. It does not change a waiver already
          signed, which keeps what was typed at the time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="account-phone">Mobile{voice.isSelf ? "" : " to reach you on"}</Label>
              <Input
                id="account-phone"
                type="tel"
                required
                maxLength={30}
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearSaveError();
                }}
                className="mt-1.5"
              />
              <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={smsConsent}
                  onCheckedChange={(v) => {
                    setSmsConsent(v === true);
                    clearSaveError();
                  }}
                  className="mt-0.5"
                />
                <span>
                  {/* "I", not "we": everywhere else on this card "we" is the
                      club, so "we agree" read as the club agreeing with itself.
                      The person ticking is one parent. */}
                  {voice.isSelf
                    ? "I agree to be contacted by SMS or WhatsApp, and added to club WhatsApp groups."
                    : `I agree to ${voice.who} being contacted by SMS or WhatsApp, and added to club WhatsApp groups.`}
                </span>
              </label>
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Home address</legend>
              <AddressFields
                idPrefix="account-address"
                value={address}
                onChange={(next) => {
                  setAddress(next);
                  clearSaveError();
                }}
                previousLine={previousLine}
                showProblems={attempted}
              />
            </fieldset>

            <fieldset className="space-y-4 rounded-md border p-4">
              <legend className="px-1 text-sm font-medium">Emergency contact</legend>
              <div>
                <Label htmlFor="account-ec-name">Name</Label>
                <Input
                  id="account-ec-name"
                  required
                  maxLength={120}
                  value={ecName}
                  onChange={(e) => {
                    setEcName(e.target.value);
                    clearSaveError();
                  }}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="account-ec-relationship">Relationship</Label>
                <Input
                  id="account-ec-relationship"
                  required
                  maxLength={80}
                  value={ecRelationship}
                  onChange={(e) => {
                    setEcRelationship(e.target.value);
                    clearSaveError();
                  }}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="account-ec-phone">Mobile</Label>
                <Input
                  id="account-ec-phone"
                  type="tel"
                  required
                  maxLength={30}
                  value={ecPhone}
                  onChange={(e) => {
                    setEcPhone(e.target.value);
                    clearSaveError();
                  }}
                  className="mt-1.5"
                />
              </div>
            </fieldset>

            {saveError && (
              <SaveFailure
                what="change to the contact details"
                message={saveError}
                onRetry={() => void retrySave?.()}
                retrying={busy}
                keptOnDevice={false}
              />
            )}
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
