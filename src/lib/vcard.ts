// A person's contact card, as a vCard file a manager's phone can import.
//
// Pure and side-effect free, like `ics.ts`, whose escaping and line folding it
// reuses: vCard 3.0 (RFC 2426) and iCalendar both sit on the same RFC 2425
// content-line syntax, so the two rules are the same rules.
//
// Why 3.0 and nothing newer. Android's Contacts importer reads 2.1 and 3.0
// properly and 4.0 only in part (it drops what it does not know), and iOS,
// Google Contacts and Outlook all read 3.0. So 3.0 is the one version every
// phone a manager is likely to hold opens without losing a field.
//
// The labelled numbers ("Guardian", "Emergency") use the `X-<label>` TYPE that
// Android imports as a custom label. Anything that does not know it still keeps
// the number; it only loses the word beside it.
//
// ⚠️ What is NOT on the card is a decision, not an oversight. A contact card
// leaves the club's systems the moment it is saved: it syncs to the manager's
// own Google or iCloud account and goes wherever their phone backs up to. So it
// carries how to reach somebody, plus the birthday a contact card is expected
// to have, and nothing else. Medical notes, consents, the student number and
// kit sizes stay on the person page.

import { clubLocalDate } from "@/lib/calendar";
import { isDependant } from "@/lib/household";
import { escapeIcsText, foldIcsLine } from "@/lib/ics";
import { isMinorOn, profileFullName } from "@/lib/validation";

export type VCardPerson = {
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  /**
   * Not null when this person is a dependant (`household.ts`). Their record
   * then holds their account holder's email and, usually, phone: a child has
   * neither of their own.
   */
  guardian_user_id: string | null;
  /** The address the club writes to about them. For a dependant it is their guardian's. */
  email: string | null;
  phone: string | null;
  address: string | null;
  /** `YYYY-MM-DD`, as Postgres returns a `date`. */
  date_of_birth: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  is_minor: boolean;
  guardian_name: string | null;
  guardian_relationship: string | null;
  guardian_phone: string | null;
  guardian_email: string | null;
  /** Link back to their record, so the card opens the person page. */
  url?: string;
};

/** Trimmed, or null when there is nothing left. */
function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** "Bea (Sister)", "Bea", "(Sister)" or null. */
function nameWithRelationship(name: string | null, relationship: string | null): string | null {
  const n = clean(name);
  const r = clean(relationship);
  if (n && r) return `${n} (${r})`;
  return n ?? (r ? `(${r})` : null);
}

/**
 * A TYPE label Android shows beside a number. An extension type is `X-`
 * followed by letters, digits and hyphens only (RFC 2426 §4, `x-name`), so
 * labels are joined with hyphens ("Guardian-Emergency") and anything else is
 * dropped: an importer stricter than Android's may otherwise discard the line.
 */
function customType(labels: string[]): string {
  return `X-${labels.map((l) => l.replace(/[^A-Za-z0-9]/g, "")).join("-")}`;
}

type ContactPoint = { value: string; type: string };

/**
 * The phone numbers or emails to write, each at most once, in the order given.
 *
 * A family usually types the same parent's number into the child's own field,
 * the guardian field and the emergency field. Three entries for one number, the
 * first calling it the child's mobile, is exactly how a manager ends up
 * believing they can ring a ten-year-old. So a value written twice becomes one
 * entry carrying every label it came in with ("Guardian-Emergency"), and
 * anything that is one of `guardians` is labelled Guardian whichever slot it
 * came in through. An entry with no label is the person's own: alone it is
 * `ownType`, and beside other labels it is called `ownLabel`, so an adult who
 * gave their own mobile as their emergency number keeps it as their mobile.
 */
function contactPoints(
  entries: { value: string | null; label: string | null }[],
  guardians: (string | null)[],
  key: (value: string) => string,
  own: { type: string; label: string },
): ContactPoint[] {
  const guardianKeys = new Set(guardians.map(clean).flatMap((g) => (g ? [key(g)] : [])));
  const byKey = new Map<string, { value: string; labels: string[] }>();
  for (const entry of entries) {
    const value = clean(entry.value);
    if (!value) continue;
    const k = key(value);
    if (!k) continue;
    let point = byKey.get(k);
    if (!point) {
      point = { value, labels: guardianKeys.has(k) ? ["Guardian"] : [] };
      byKey.set(k, point);
    }
    // The person's own, unless it is their guardian's: that is the whole point.
    const label = entry.label ?? (guardianKeys.has(k) ? null : own.label);
    if (label && !point.labels.includes(label)) point.labels.push(label);
  }
  return [...byKey.values()].map(({ value, labels }) => ({
    value,
    type:
      labels.length === 0 || (labels.length === 1 && labels[0] === own.label)
        ? own.type
        : customType(labels),
  }));
}

/**
 * The digits that identify a phone number, so one number typed two ways is
 * still one number. An Australian number written internationally drops its
 * trunk 0 after the 61, so "+61 400 000 001", "0061 400 000 001" and
 * "+61 (0)400 000 001" are all put back to "0400000001".
 */
function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^00/, "");
  const national = /^610?(\d{9})$/.exec(digits);
  return national ? `0${national[1]}` : digits;
}

/**
 * Build the card. Lines are CRLF-separated and folded, ending in a CRLF.
 * `now` decides whether somebody is still a minor.
 */
export function buildVCard(p: VCardPerson, now: Date = new Date()): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
  const add = (line: string) => lines.push(foldIcsLine(line));
  const text = (value: string) => escapeIcsText(value);

  const first = clean(p.first_name) ?? "";
  const middle = clean(p.middle_name) ?? "";
  const last = clean(p.last_name) ?? "";
  // N is required in 3.0, and it is what Android files the contact under.
  add(`N:${text(last)};${text(first)};${text(middle)};;`);
  add(`FN:${text(profileFullName(p) || "UTS Jitsu member")}`);
  const preferred = clean(p.preferred_name);
  if (preferred && preferred.toLowerCase() !== first.toLowerCase()) {
    add(`NICKNAME:${text(preferred)}`);
  }

  const dependant = isDependant(p);
  // Who the club reaches about this person, when that is not them. A dependant
  // always has one (it is what makes them a dependant), whatever their age. An
  // account holder has one only while they are still a minor: `is_minor` is
  // the tick on the waiver they signed, so somebody who signed at 17 still
  // carries it at 20, and their parent's details do not belong in a manager's
  // phone as the contact for an adult. Their 18th birthday is the club's date,
  // in Sydney, not UTC's. Without a birthday the tick is all there is to go on.
  const hasGuardian =
    dependant || (p.date_of_birth ? isMinorOn(p.date_of_birth, clubLocalDate(now)) : p.is_minor);
  const guardianPhone = hasGuardian ? p.guardian_phone : null;
  const guardianEmail = hasGuardian ? p.guardian_email : null;

  const phones = contactPoints(
    [
      { value: p.phone, label: null },
      { value: guardianPhone, label: "Guardian" },
      { value: p.emergency_contact_phone, label: "Emergency" },
    ],
    // A dependant's own number is usually their account holder's, but a
    // teenager on a parent's account can have a mobile of their own. The
    // guardian's number on file settles which; without one, the number is
    // taken to be the account holder's, since that is who the club reaches.
    [guardianPhone, dependant && !clean(guardianPhone) ? p.phone : null],
    phoneKey,
    { type: "CELL", label: "Mobile" },
  );
  for (const tel of phones) add(`TEL;TYPE=${tel.type}:${text(tel.value)}`);

  const emails = contactPoints(
    // No INTERNET type: it is 3.0's default anyway, and Android turns a type
    // it has no slot for into the label, so it could show up as "INTERNET".
    [
      { value: p.email, label: null },
      { value: guardianEmail, label: "Guardian" },
    ],
    // A dependant has no mailbox of their own: the one on file is the account
    // holder's, so it is labelled as theirs rather than passed off as the child's.
    [guardianEmail, dependant ? p.email : null],
    (email) => email.toLowerCase(),
    { type: "HOME", label: "Home" },
  );
  for (const email of emails) add(`EMAIL;TYPE=${email.type}:${text(email.value)}`);

  const address = clean(p.address);
  // The club keeps an address as one line of free text, so it all goes in the
  // street component; Android shows the components joined back up.
  if (address) add(`ADR;TYPE=HOME:;;${text(address)};;;;`);

  if (p.date_of_birth && /^\d{4}-\d{2}-\d{2}$/.test(p.date_of_birth)) {
    add(`BDAY:${p.date_of_birth}`);
  }

  const notes: string[] = ["UTS Jitsu"];
  const guardian = hasGuardian
    ? nameWithRelationship(p.guardian_name, p.guardian_relationship)
    : null;
  if (guardian) notes.push(`Guardian: ${guardian}`);
  const emergency = nameWithRelationship(
    p.emergency_contact_name,
    p.emergency_contact_relationship,
  );
  if (emergency) notes.push(`Emergency contact: ${emergency}`);

  add(`NOTE:${text(notes.join("\n"))}`);
  if (p.url) add(`URL:${p.url}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

/** A file name a phone and a desktop both accept: the person's name, `.vcf`. */
export function vCardFileName(p: Pick<VCardPerson, "first_name" | "middle_name" | "last_name">) {
  const name = profileFullName(p)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${name || "contact"}.vcf`;
}
