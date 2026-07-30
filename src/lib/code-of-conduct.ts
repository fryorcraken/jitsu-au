/**
 * The club's code of conduct: the document itself, and the pure rules around it.
 *
 * Unlike the waiver, this document does NOT live in the database. That is a
 * deliberate difference, not an oversight:
 *
 *   * The waiver is a legal release whose exact wording a manager needs to be
 *     able to change without a deploy, and every signature is filed against the
 *     version it was signed under, with the full text frozen into a PDF.
 *   * The code of conduct is house rules. It changes when the committee agrees
 *     to change it, review matters more than speed, and the text belongs in
 *     version control where a diff shows what actually changed and when.
 *
 * So the body lives here and `CODE_OF_CONDUCT_VERSION` is bumped by hand when
 * the wording changes in a way members should re-read. Acceptances record the
 * version they agreed to, which is what makes "you agreed to an older version"
 * a state the site can see and show.
 *
 * Keep this module side-effect-free and free of server imports (no supabase
 * clients, no `process.env`) so it stays unit-testable, mirroring `validation.ts`
 * and `email-verification.ts`.
 */

/**
 * Bump this when the wording changes materially.
 *
 * A bump asks everyone who already signed to read and accept the new version:
 * their acceptance shows as out of date until they do. So bump for a rule
 * change, not for a typo fix, and never edit an old version's text in place
 * without one — an acceptance records a number, and that number has to keep
 * meaning the text people actually read.
 */
export const CODE_OF_CONDUCT_VERSION = 1;

export const CODE_OF_CONDUCT_TITLE = "UTS Jitsu Code of Conduct";

/** The single tick box on the signing form. */
export const CODE_OF_CONDUCT_ACKNOWLEDGEMENT =
  "I have read the UTS Jitsu Code of Conduct and the ActivateUTS Clubs Code of Conduct, and I agree to follow both.";

/** The ActivateUTS code this one sits on top of. Linked from the body as well. */
export const ACTIVATE_UTS_CODE_URL =
  "https://www.activateuts.com.au/terms-conditions/club-code-of-conduct/";

/**
 * The document. Markdown-ish, in the small subset `parseCodeOfConductBlocks`
 * understands: `#` and `##` headings, `- ` bullets, `**bold**`, bare URLs, and
 * paragraphs separated by a blank line.
 */
export const CODE_OF_CONDUCT_BODY_MD = `# ${CODE_OF_CONDUCT_TITLE}

Welcome to UTS Jitsu.

We strive to create an environment where we both learn, and help others learn. Cooperation is essential to martial art training. This code of conduct is written with that in mind.

By training with us you agree to this Code and to the ActivateUTS Clubs Code of Conduct: ${ACTIVATE_UTS_CODE_URL}

## Health and hygiene

- **Sick? Stay home.** Do not train with a fever, an infection, or a contagious condition. If you need to cough during training, cough into your gi lapel.
- **Injuries.** Tell the Coach in Charge about any existing injury before training, and report any new injury immediately.
- **Bleeding.** Stop training immediately. Resume only once the wound is covered with a bandage or tape and the mat has been cleaned with alcohol wipes.
- **Skin conditions.** Do not train with an open, weeping or contagious skin condition until it is medically cleared.
- **Nails.** Keep fingernails and toenails short and cut flat, not to a point. Check before every session.
- **Gi (uniform).** Wash your gi before every session. Replace or repair it if it has holes, tears or loose thread. Soak your belt in soapy water regularly.

## Jewellery and piercings

- Remove all jewellery before training: rings, necklaces, earrings, wristbands, watches.
- Piercings that cannot be removed must be fully covered with medical tape or a band-aid.

## Mat etiquette

- **Rei (bow).** Bow when stepping onto and off the mat. Wait for the Coach in Charge to acknowledge you before you step on.
- **Footwear.** Never walk barefoot outside the mat area. Wear flip-flops or sandals off the mat, and never walk on the mat in shoes.
- **Bring to every session:** flip-flops, towel, water bottle and mouthguard.
- **Leaving early.** Always tell the Coach in Charge if you need to leave a session early.

## Protective equipment

- **Mouthguard.** Mandatory for all sparring and resistance training. The club can help you source one.
- Some sessions may need boxing or MMA gloves, shin guards and/or a helmet. You will be told in advance. The club will try to lend equipment but cannot promise enough for everyone, and can help you source your own.

## Grading and uniform

Regular sessions:

- Get a gi through the club. Speak to the club committee.
- Until you have one, sports clothes are fine. Long pants are preferred and a top is required.
- Other standard martial arts uniforms are permitted at the coach's discretion.
- A short-sleeve rash guard under the gi is recommended. The club can help you source one.

Gradings:

- A blue or white judo gi with the Jitsu badge is required.
- Your belt must be your current Sydney Jitsu rank colour, correctly tied.

## Respect, inclusion and training safety

- Treat everyone with dignity and respect: training partners, coaches and guests.
- Bullying, harassment, discrimination, objectification and vilification of any kind will not be tolerated.
- All physical contact must be appropriate for the technique being practised. Stop immediately on a tap or at any sign of discomfort.
- No member is ever required to train, spar or partner with someone against their will, whatever that person's rank or seniority. You can talk to your coach, sit out, or change partner.
- Changing facilities must be used appropriately and respectfully.
- Headbutts, knee strikes and elbow strikes to the head are allowed only when the coach has explicitly permitted them and the person receiving them is wearing extra protective gear (mouthguard and helmet).
- "Staking" an opponent on their neck during ground work is allowed only when both people are Jitsu light blue grades or above, and the coach has explicitly said this is a sparring or resistance exercise.
- Biting, scratching and spitting are always prohibited.

## Reporting incidents

- Report any and all incidents to the Coach in Charge.
- The Coach in Charge will report to ActivateFit as required by ActivateUTS policy.
- You may report directly to ActivateUTS if you are not comfortable approaching the coach.
- No retaliation against anyone who raises a concern in good faith will be tolerated.

## Coaching standards

- All coaches hold a current First Aid certification. This is mandatory and renewed regularly.
- All coaches hold a valid NSW Working with Children Check (WWCC).
- Certificates and registration numbers can be provided on request.

## Breaches of this Code

- Breaches are handled under the ActivateUTS Clubs Code of Conduct disciplinary process.
- Outcomes range from a formal warning to suspension or expulsion, depending on how serious the breach is.
- Matters involving criminal conduct or child safety are referred to the relevant authorities.
`;

// ---- Rendering ----

export type CodeOfConductBlock =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] };

/**
 * Parse the document body into blocks for rendering.
 *
 * Close to `parseWaiverBlocks`, with one addition that the waiver never needed:
 * bullet lists. The code of conduct is almost entirely rules-as-bullets, and
 * rendering them as paragraphs of literal "- " would be unreadable on a phone,
 * which is where most people will read this.
 *
 * Consecutive `- ` lines within one block become a single list. A block that
 * mixes prose and bullets keeps the prose lines as their own paragraph, so an
 * intro line like "Regular sessions:" does not have to sit in its own block.
 */
export function parseCodeOfConductBlocks(body: string): CodeOfConductBlock[] {
  const blocks: CodeOfConductBlock[] = [];
  for (const raw of body.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith("# ")) {
      blocks.push({ kind: "h1", text: block.slice(2).trim() });
      continue;
    }
    if (block.startsWith("## ")) {
      blocks.push({ kind: "h2", text: block.slice(3).trim() });
      continue;
    }

    let bullets: string[] = [];
    let prose: string[] = [];
    const flushBullets = () => {
      if (bullets.length) blocks.push({ kind: "ul", items: bullets });
      bullets = [];
    };
    const flushProse = () => {
      if (prose.length) blocks.push({ kind: "p", text: prose.join("\n") });
      prose = [];
    };

    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("- ")) {
        flushProse();
        bullets.push(trimmed.slice(2).trim());
      } else {
        flushBullets();
        prose.push(trimmed);
      }
    }
    flushBullets();
    flushProse();
  }
  return blocks;
}

/** A run of document text: plain, bold, or a link. */
export type CodeOfConductSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * Split a line into spans: `**bold**` runs and bare `https://` URLs.
 *
 * The URLs are written bare in the body on purpose (the ActivateUTS code is
 * quoted as a URL in the club's own wording), so they are linked here rather
 * than being marked up in the source text.
 */
export function parseCodeOfConductSpans(line: string): CodeOfConductSpan[] {
  const spans: CodeOfConductSpan[] = [];
  // Trailing punctuation is excluded from the URL so a sentence-ending full
  // stop does not become part of the href.
  const pattern = /(\*\*.+?\*\*)|(https?:\/\/[^\s<>()]*[^\s<>().,;:])/g;
  let index = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > index) spans.push({ kind: "text", text: line.slice(index, at) });
    if (match[1]) {
      spans.push({ kind: "bold", text: match[1].slice(2, -2) });
    } else {
      spans.push({ kind: "link", text: match[2], href: match[2] });
    }
    index = at + match[0].length;
  }
  if (index < line.length) spans.push({ kind: "text", text: line.slice(index) });
  return spans;
}

// ---- Where a person stands ----

/**
 * Whether someone has agreed to the code, and to which version.
 *
 * `outdated` is a real state, not a rounding of "signed": the club changed the
 * rules and this person has not read the change. It is still not a blocker
 * (nothing about the code of conduct blocks training), so screens show it as a
 * prompt rather than a warning.
 */
export type CodeOfConductState = "unsigned" | "signed" | "outdated";

export function codeOfConductState(
  acceptedVersion: number | null | undefined,
  currentVersion: number = CODE_OF_CONDUCT_VERSION,
): CodeOfConductState {
  if (acceptedVersion == null) return "unsigned";
  return acceptedVersion >= currentVersion ? "signed" : "outdated";
}

/** The latest version any of these acceptances covers, or null for none. */
export function latestAcceptedVersion(
  acceptances: { version: number }[] | null | undefined,
): number | null {
  if (!acceptances || acceptances.length === 0) return null;
  return acceptances.reduce((best, a) => Math.max(best, a.version), 0) || null;
}

/**
 * The link that takes a person straight to the signing form.
 *
 * Omit `siteUrl` for a root-relative link (what the site itself uses); pass it
 * for an email, which needs an absolute URL. Without a token the link is just
 * the page: readable by anyone, signable only by someone the site can identify.
 */
export function buildCodeOfConductUrl(opts: { siteUrl?: string; token?: string | null }): string {
  const base = `${(opts.siteUrl ?? "").replace(/\/+$/, "")}/code-of-conduct`;
  if (!opts.token) return base;
  return `${base}?t=${encodeURIComponent(opts.token)}`;
}
