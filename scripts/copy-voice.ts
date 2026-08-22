// The copy rules from AGENTS.md, made mechanical.
//
// "Do not use the em dash (—) in prose" is the easiest rule in this repo to
// break by accident: the character is invisible in review, it survives a
// copy-paste from anywhere, and nothing about a build or a test run notices it.
// Two of them sat in the generated waiver PDF and its on-screen twin for months
// (issue #62), which is the document people sign. The banned constructions
// (issue #68) go the same way: "whether you're a complete beginner or ..." read
// as ordinary marketing prose to everyone who reviewed it.
//
// So the rules are checked rather than trusted. The scan reads real syntax via
// the TypeScript parser rather than grepping lines, because these rules are
// about COPY and not about the file: an em dash in a code comment is internal
// writing and explicitly allowed, while the same character in a string literal,
// a template literal or JSX text is something a person reads on screen.
//
// What is deliberately NOT flagged:
//
//   - comments of every kind, including JSX `{/* … */}` (internal writing),
//   - a string that is exactly "—", the placeholder glyph for an empty value
//     (AGENTS.md exempts it; `src/lib/dates.ts` EMPTY is the canonical one),
//   - the en dash "–" in a numeric range such as `5:30 – 7:00pm` (a different
//     character, and also exempt),
//   - anything passed to `console.*`, which is a server log, not copy,
//   - the files in EXEMPT_FILES below.
//
// Only the two mechanical rules live here. The rest of the voice (hollow hype,
// rule-of-three lists, telling someone what to do next rather than what broke)
// is a judgement call a checker would get wrong more often than a reviewer
// does: "unlocks the student rate" is concrete and fine, and no regex can tell
// it apart from "unlock your potential".

import ts from "typescript";

/** One thing a person reads that breaks a rule in AGENTS.md. */
export type CopyViolation = {
  /** 1-based, so it pastes straight into an editor as `file:line`. */
  line: number;
  /** Which rule: the em dash, or the construction that was matched. */
  rule: string;
  /** The text it was found in, trimmed and shortened for the failure message. */
  snippet: string;
};

/**
 * Files whose "copy" is not copy: text addressed to an API client or a coding
 * agent rather than to a member, a manager or a visitor. Issue #62 made this
 * call explicitly for the manifest, and the token page's prompt is the same
 * text in the same voice.
 *
 * Paths are repo-relative and compared exactly. Keep this list short, and say
 * why here rather than in a commit message nobody will find.
 */
export const EXEMPT_FILES: readonly string[] = [
  // AGENT_MANIFEST: the manager agent API's own protocol documentation, served
  // as JSON to whatever client is calling it. Never rendered on a screen.
  "src/lib/manager-agent.ts",
  // buildAgentPrompt: the prompt a manager copies into their coding agent. It
  // is displayed, but it is addressed to the agent, and it is the manifest's
  // voice, not the club's.
  "src/lib/manager-api-tokens.ts",
];

/** Generated files, and tests (which quote copy in order to pin it). */
export function isCopyScanned(repoRelativePath: string): boolean {
  if (!/\.tsx?$/.test(repoRelativePath)) return false;
  if (/\.(test|spec)\.tsx?$/.test(repoRelativePath)) return false;
  if (repoRelativePath.startsWith("src/integrations/supabase/")) return false;
  if (repoRelativePath.endsWith(".gen.ts")) return false;
  return !EXEMPT_FILES.includes(repoRelativePath);
}

const EM_DASH = "—";

/**
 * The two constructions AGENTS.md bans by name. Both are matched on
 * whitespace-collapsed text with substitutions standing in as `{}`, so neither
 * a line wrap nor an interpolated name hides one. Either apostrophe counts:
 * a curly one is what a word processor produces and reads identically.
 */
const BANNED_CONSTRUCTIONS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: `"whether you're X or Y"`, pattern: /\bwhether you(?:['’]re| are)\b/i },
  { rule: `"it's not just X, it's Y"`, pattern: /\bnot just\b.{1,60}?(?:,\s*it['’]s|\bbut)\b/i },
];

/** What an interpolation is replaced by when a template or an element is read as one string. */
const SUBSTITUTION = "{}";

/**
 * JSX text is raw source: `&mdash;` in a page renders as an em dash and would
 * otherwise scan clean. Only the entities that matter to these two rules are
 * decoded, since nothing else here reads the text as HTML.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&(?:mdash|#8212|#x2014);/gi, EM_DASH)
    .replace(/&(?:rsquo|apos|#39|#8217|#x2019);/gi, "'");
}

/** The placeholder-glyph exception: the whole string is the dash. */
function isPlaceholderGlyph(text: string): boolean {
  return text.trim() === EM_DASH;
}

/** A log line is internal writing, wherever in the argument list it sits. */
function isInsideConsoleCall(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "console"
    ) {
      return true;
    }
  }
  return false;
}

function snippet(text: string): string {
  const flat = collapse(text);
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One piece of text a person reads. */
type CopyText = {
  text: string;
  line: number;
  /**
   * True for a sentence read across its interpolations (a template literal, or
   * an element's children). The em dash rule ignores these, because it has
   * already seen each piece on its own and would otherwise report twice; the
   * construction rule needs them, because a phrase broken by `${name}` matches
   * in neither half.
   */
  joined: boolean;
};

/**
 * Every piece of text a person reads: string literals, the text chunks of
 * template literals, and JSX text, plus each template and each text-carrying
 * element read as one sentence. Comments never appear, because the parser
 * keeps them out of the tree.
 *
 * `fileName` only decides how the source is parsed (`.tsx` enables JSX), so a
 * caller testing a snippet can pass any name with the right extension.
 */
function copyTexts(fileName: string, source: string): CopyText[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const texts: CopyText[] = [];

  function take(node: ts.Node, text: string, joined: boolean): void {
    if (isInsideConsoleCall(node)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    texts.push({ text: decodeEntities(text), line: line + 1, joined });
  }

  /** `Upvote ${n} times` read as "Upvote {} times". */
  function readTemplate(node: ts.TemplateExpression): string {
    return (
      node.head.text + node.templateSpans.map((span) => SUBSTITUTION + span.literal.text).join("")
    );
  }

  /** An element's children read as one sentence, nested elements flattened in. */
  function readJsxChild(child: ts.JsxChild): string {
    if (ts.isJsxText(child)) return child.text;
    if (ts.isJsxExpression(child)) {
      // `{" "}` is Prettier's line-wrap filler and carries real words often
      // enough to matter; anything else stands in as a substitution.
      const inner = child.expression;
      return inner && ts.isStringLiteral(inner) ? inner.text : SUBSTITUTION;
    }
    if (ts.isJsxElement(child) || ts.isJsxFragment(child)) {
      return child.children.map(readJsxChild).join("");
    }
    return SUBSTITUTION;
  }

  /**
   * Only elements with words of their own are read whole. An outer `<div>` of
   * nothing but other elements would otherwise repeat every sentence below it.
   */
  function carriesWords(children: readonly ts.JsxChild[]): boolean {
    return children.some((child) => ts.isJsxText(child) && child.text.trim().length > 0);
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      take(node, node.text, false);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      take(node, node.text, false);
    } else if (ts.isJsxText(node)) {
      take(node, node.text, false);
    } else if (ts.isTemplateExpression(node)) {
      take(node, readTemplate(node), true);
    } else if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && carriesWords(node.children)) {
      take(node, node.children.map(readJsxChild).join(""), true);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return texts;
}

/** Every em dash in something a person reads, in one file's source. */
export function findEmDashesInSource(fileName: string, source: string): CopyViolation[] {
  const violations: CopyViolation[] = [];
  for (const { text, line, joined } of copyTexts(fileName, source)) {
    if (joined) continue;
    if (!text.includes(EM_DASH)) continue;
    if (isPlaceholderGlyph(text)) continue;
    violations.push({ line, rule: "em dash", snippet: snippet(text) });
  }
  return violations;
}

/** Every banned construction in something a person reads, in one file's source. */
export function findBannedConstructions(fileName: string, source: string): CopyViolation[] {
  // One sentence is read both in pieces and whole, and a nested element is read
  // again by its parent, so the same phrase arrives several times. Keyed on the
  // matched words, each is reported once; the parser walks outermost first, so
  // the last one to arrive is the tightest piece of text around it.
  const byPhrase = new Map<string, CopyViolation>();
  for (const { text, line } of copyTexts(fileName, source)) {
    const flat = collapse(text);
    for (const { rule, pattern } of BANNED_CONSTRUCTIONS) {
      const match = flat.match(pattern);
      if (!match) continue;
      byPhrase.set(`${rule}|${match[0].toLowerCase()}`, { line, rule, snippet: snippet(text) });
    }
  }
  return [...byPhrase.values()].sort((a, b) => a.line - b.line);
}

/** Both rules at once, in source order. */
export function findCopyViolations(fileName: string, source: string): CopyViolation[] {
  return [
    ...findEmDashesInSource(fileName, source),
    ...findBannedConstructions(fileName, source),
  ].sort((a, b) => a.line - b.line);
}
