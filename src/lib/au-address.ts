// An Australian address in parts: street, suburb, state and postcode.
//
// Every address the club held used to be one free-text box, so nothing made
// anybody give a postcode and nothing could be sorted by suburb. The database
// now keeps the four parts beside the one-line `address` that every screen,
// email and PDF still reads (`20261029000000_structured_address.sql`), and this
// module is the app's half of that arrangement: the rules a part must satisfy,
// the one way to turn parts into a line, and the one way back.
//
// The line format is not a matter of taste. On `waivers` the database refuses
// a row whose `address` is not exactly the line composed from its parts
// (`waivers_address_matches_parts`), so a composition here that differed from
// the migration's by one space would stop every waiver from being signed.
// `au-address.test.ts` reads the migration and fails if the two ever disagree.
//
// Pure and server-import-free, like `validation.ts`, so the form, the server
// and the tests all share it.
import { z } from "zod";

/** The eight states and territories, by the abbreviation an address uses. */
export const AU_STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
export type AuState = (typeof AU_STATES)[number];

/** What the state picker shows. The abbreviation leads, as on an envelope. */
export const AU_STATE_NAMES: Record<AuState, string> = {
  ACT: "Australian Capital Territory",
  NSW: "New South Wales",
  NT: "Northern Territory",
  QLD: "Queensland",
  SA: "South Australia",
  TAS: "Tasmania",
  VIC: "Victoria",
  WA: "Western Australia",
};

export const isAuState = (value: string): value is AuState =>
  (AU_STATES as readonly string[]).includes(value);

/** A complete address. Every part is trimmed and present. */
export type AuAddress = {
  street: string;
  suburb: string;
  state: AuState;
  postcode: string;
};

/** An address while somebody is typing it: any part may still be blank. */
export type AuAddressDraft = {
  street: string;
  suburb: string;
  state: AuState | "";
  postcode: string;
};

export const EMPTY_AU_ADDRESS: AuAddressDraft = { street: "", suburb: "", state: "", postcode: "" };

/** The longest each part may be, as the database's CHECK constraints allow. */
export const AU_ADDRESS_LIMITS = { street: 200, suburb: 60 } as const;

/**
 * The one-line form of an address: `<street>, <suburb> <STATE> <postcode>`.
 *
 * This is what lands in `address` and therefore on the signed PDF, so it must
 * match the migration's composition character for character.
 */
export function composeAuAddress(a: AuAddress): string {
  return `${a.street}, ${a.suburb} ${a.state} ${a.postcode}`;
}

// Mirrors `public.split_au_address` in the migration, rule for rule, so the
// app and the database agree on which old addresses can be read as parts.
const SPLIT =
  /^\s*(.*[0-9].*[a-z.])\s*,\s*([^,0-9]*[^\s,0-9])\s*,?\s+(act|nsw|nt|qld|sa|tas|vic|wa)\s*,?\s+([0-9]{4})(\s*,?\s*australia)?\s*$/i;
const POSTCODE_LEAD: Record<AuState, RegExp> = {
  ACT: /^(02|26|29)/,
  NSW: /^[12]/,
  NT: /^0[89]/,
  QLD: /^[49]/,
  SA: /^5/,
  TAS: /^7/,
  VIC: /^[38]/,
  WA: /^6/,
};

/**
 * Read the four parts out of a one-line address, or `null` when that cannot be
 * done without guessing. Used to offer an address the club holds as a single
 * line back to somebody as parts; the reasons it refuses are in the migration.
 */
export function splitAuAddress(line: string | null | undefined): AuAddress | null {
  // Any control character (a newline above all) means a multi-line address,
  // which is not the shape this reads.
  // eslint-disable-next-line no-control-regex
  if (!line || /[\u0000-\u001f\u007f]/.test(line)) return null;
  const m = SPLIT.exec(line);
  if (!m) return null;
  const [, street, suburb, rawState, postcode] = m;
  if (street.length > AU_ADDRESS_LIMITS.street || suburb.length > AU_ADDRESS_LIMITS.suburb) {
    return null;
  }
  const state = rawState.toUpperCase() as AuState;
  if (!POSTCODE_LEAD[state].test(postcode)) return null;
  return { street, suburb, state, postcode };
}

/** The draft to show for an address the club holds, or an empty one. */
export function auAddressDraft(a: AuAddress | null): AuAddressDraft {
  return a ? { ...a } : { ...EMPTY_AU_ADDRESS };
}

/** True when nothing has been typed into any part. */
export function isBlankAuAddress(d: AuAddressDraft): boolean {
  return !d.street.trim() && !d.suburb.trim() && !d.state && !d.postcode.trim();
}

/** The address a profile or waiver row holds as parts, when it holds them. */
export function auAddressFromRow(row: {
  address_street?: string | null;
  address_suburb?: string | null;
  address_state?: string | null;
  address_postcode?: string | null;
}): AuAddress | null {
  const { address_street, address_suburb, address_state, address_postcode } = row;
  if (!address_street || !address_suburb || !address_postcode) return null;
  if (!address_state || !isAuState(address_state)) return null;
  return {
    street: address_street,
    suburb: address_suburb,
    state: address_state,
    postcode: address_postcode,
  };
}

/** The four columns an address is stored in, for an insert or an update. */
export function auAddressColumns(a: AuAddress | null) {
  return {
    address_street: a?.street ?? null,
    address_suburb: a?.suburb ?? null,
    address_state: a?.state ?? null,
    address_postcode: a?.postcode ?? null,
  };
}

/** Which part a problem is about. Doubles as the suffix of that input's id. */
export type AuAddressPart = keyof AuAddress;

/** The `id` of one part's input on a form: the form's jump links aim at these. */
export const auAddressFieldId = (idPrefix: string, part: AuAddressPart) => `${idPrefix}_${part}`;

/** One thing wrong with a draft, in the words the form shows under the field. */
export type AuAddressProblem = { part: AuAddressPart; label: string; hint?: string };

/**
 * What is still missing or wrong in a draft, in the order the fields appear.
 *
 * The same rules `auAddressSchema` enforces, said to a person: the form lists
 * these before anything is sent, so somebody hears "the postcode is four
 * digits" under the field rather than as a rejected submission.
 */
export function auAddressProblems(d: AuAddressDraft): AuAddressProblem[] {
  const problems: AuAddressProblem[] = [];
  if (!d.street.trim()) problems.push({ part: "street", label: "Street address" });
  if (!d.suburb.trim()) {
    problems.push({ part: "suburb", label: "Suburb" });
  } else if (/[0-9,]/.test(d.suburb)) {
    problems.push({
      part: "suburb",
      label: "Suburb",
      hint: "Just the suburb name here. The street goes in the line above",
    });
  }
  if (!d.state) problems.push({ part: "state", label: "State" });
  if (!d.postcode.trim()) {
    problems.push({ part: "postcode", label: "Postcode" });
  } else if (!/^[0-9]{4}$/.test(d.postcode.trim())) {
    problems.push({ part: "postcode", label: "Postcode", hint: "A postcode is four digits" });
  }
  return problems;
}

// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
// A suburb also carries no digit and no comma: none has either, and either
// would make the composed line read back as a different address.
// eslint-disable-next-line no-control-regex
const SUBURB_CHARS = /^[^\u0000-\u001f\u007f0-9,]*$/;

/**
 * A complete address as it crosses the wire. The same bounds as the database's
 * `*_address_parts_valid` constraints, so a submission is refused here in
 * words rather than by a constraint name after the insert.
 */
export const auAddressSchema = z.object({
  street: z
    .string()
    .trim()
    .min(1, "Please give the street address.")
    .max(AU_ADDRESS_LIMITS.street)
    .regex(NO_CONTROL, "Please keep the street address on one line."),
  suburb: z
    .string()
    .trim()
    .min(1, "Please give the suburb.")
    .max(AU_ADDRESS_LIMITS.suburb)
    .regex(SUBURB_CHARS, "Please give just the suburb name."),
  state: z.enum(AU_STATES, { message: "Please choose a state." }),
  postcode: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "A postcode is four digits."),
});

/**
 * The address a submission carries, as the line to store and the parts beside
 * it.
 *
 * New forms send parts, and the line is composed from them, so the two can
 * never disagree. A client that predates parts (a tab left open across a
 * deploy, an older agent) still sends one line; that is stored as typed with no
 * parts, which the database allows, rather than refused or guessed at.
 */
export function resolveAddressInput(
  line: string | null | undefined,
  parts: AuAddress | null | undefined,
): { address: string; parts: AuAddress | null } {
  if (parts) return { address: composeAuAddress(parts), parts };
  return { address: (line ?? "").trim(), parts: null };
}

/** A finished draft as parts, trimmed, or `null` while anything is missing or wrong. */
export function completeAuAddress(d: AuAddressDraft): AuAddress | null {
  const parsed = auAddressSchema.safeParse(d);
  return parsed.success ? parsed.data : null;
}

/**
 * The line a draft reads as so far, for a live preview of the document.
 *
 * The same shape as `composeAuAddress`, and identical to it once the draft is
 * complete; until then it shows whatever has been typed, so a half-filled
 * address previews as half an address rather than as nothing.
 */
export function draftAddressLine(d: AuAddressDraft): string {
  const done = completeAuAddress(d);
  if (done) return composeAuAddress(done);
  const locality = [d.suburb.trim(), d.state, d.postcode.trim()].filter(Boolean).join(" ");
  return [d.street.trim(), locality].filter(Boolean).join(", ");
}
