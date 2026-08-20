#!/usr/bin/env bun
//
// Fail if the COMMITTED `.env` ever holds something that is not publishable.
//
// `.env` is tracked in this repo on purpose: Lovable Cloud generates it
// (gpt-engineer-app[bot] wrote every version of it) and re-creates it on the
// next Cloud sync, so removing it or adding it to .gitignore just starts a
// churn fight with the platform. See CLAUDE.md > Environment variables.
//
// The catch is that a tracked `.env` is a loaded gun once the repo is public:
// the file a person naturally reaches for when they need a service-role key
// locally is the one already under version control, and `git add -A` commits
// it without comment. Nothing else in the pipeline would notice — the value is
// syntactically ordinary and the build stays green. So this checker is the
// thing that notices.
//
// It reads what git has, NOT the working copy. A developer keeping a local
// SUPABASE_SERVICE_ROLE_KEY in their own `.env` to run scripts against a local
// stack is fine and expected; only committing it is the problem. Checking the
// working copy would punish the safe case and miss nothing extra.
//
// Two independent rules, because either alone has a blind spot:
//
//   * an allowlist of KEY NAMES — catches a secret whose value shape we do not
//     recognise (a bare hex token, an opaque vendor string);
//   * a deny-list of VALUE SHAPES — catches a secret smuggled in under a
//     harmless-looking or VITE_-prefixed name, which the allowlist would only
//     flag as "unknown" and a reviewer might wave through.
//
// A new key from Lovable fails this check by design: that is the review gate.
// If the new value really is publishable (the Google Picker API key discussed
// for the Drive folder picker would be), add it to PUBLISHABLE_ENV_KEYS below
// in the same commit, and say in the message why it is safe to publish.
//
// Run:  bun scripts/check-committed-env.mjs

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Env var names allowed to appear in the committed `.env`.
 *
 * Every one of these is public by design: the `VITE_*` values are baked into
 * the browser bundle at build time and can be read out of jitsu.au with
 * devtools, and their unprefixed twins are the same values for SSR. The
 * publishable key is the Supabase `anon` key, which is safe because RLS and
 * table grants are the boundary, not the key's secrecy.
 */
export const PUBLISHABLE_ENV_KEYS = new Set([
  "SUPABASE_PROJECT_ID",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "VITE_SUPABASE_PROJECT_ID",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_URL",
  "VITE_GOOGLE_OAUTH_CLIENT_ID",
]);

/**
 * Names we know are secrets, so the failure can say so outright rather than
 * calling them merely unrecognised. Everything the server reads from
 * `process.env` that is not in PUBLISHABLE_ENV_KEYS belongs here.
 */
const KNOWN_SECRET_KEYS = new Set([
  "SUPABASE_SERVICE_ROLE_KEY",
  "LOVABLE_API_KEY",
  "LOVABLE_SEND_URL",
  "MANAGER_AGENT_API_KEY",
  "NOTIFICATION_DIGEST_KEY",
  "APP_USER_CONNECTION_KEY_SECRET",
  "GOOGLE_DRIVE_APP_USER_CONNECTOR_CLIENT_API_KEY",
]);

/** Value shapes that are a credential whatever key they are hiding behind. */
const SECRET_VALUE_SHAPES = [
  [/^sb_secret_/, "a Supabase secret key"],
  [/^sbp_/, "a Supabase personal access token"],
  [/^sk-ant-/, "an Anthropic API key"],
  [/^gh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/^github_pat_/, "a GitHub fine-grained token"],
  [/^AKIA[0-9A-Z]{16}$/, "an AWS access key id"],
  [/^xox[baprs]-/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, "a private key"],
  [/^postgres(ql)?:\/\/[^@]*:[^@]+@/, "a Postgres connection string with a password"],
];

/** Decode a JWT payload, or null if `value` is not a readable JWT. */
export function jwtPayload(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Strip one layer of matching surrounding quotes. */
function unquote(raw) {
  const trimmed = raw.trim();
  const quoted = /^"(.*)"$/s.exec(trimmed) ?? /^'(.*)'$/s.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

/**
 * Parse `.env` text into `{ key, value, line }` records, skipping blanks and
 * comments. Deliberately permissive about `export KEY=` and unquoted values:
 * this is a security check, so anything a shell or bun would load has to be
 * seen, not just the exact shape Lovable writes today.
 */
export function parseEnv(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(line);
    if (!match) return;
    entries.push({ key: match[1], value: unquote(match[2]), line: index + 1 });
  });
  return entries;
}

/**
 * Audit parsed `.env` text. Returns one finding per problem, each naming the
 * key, the line, and what to do about it. An empty array means the file holds
 * only publishable values.
 */
export function auditEnv(text) {
  const findings = [];

  for (const { key, value, line } of parseEnv(text)) {
    if (KNOWN_SECRET_KEYS.has(key)) {
      findings.push({
        key,
        line,
        reason: `${key} is a secret and must never be committed. Keep it in Lovable Cloud project secrets (server runtime only).`,
      });
    } else if (!PUBLISHABLE_ENV_KEYS.has(key)) {
      findings.push({
        key,
        line,
        reason: `${key} is not in the publishable allowlist. If it really is public (a VITE_ value is baked into the browser bundle either way), add it to PUBLISHABLE_ENV_KEYS in scripts/check-committed-env.mjs and say why in the commit. If it is a secret, remove it and move it to Lovable Cloud project secrets.`,
      });
    }

    // Value-shape rules run for every key, including allowlisted ones: the
    // point is to catch a real credential pasted over a name we trust.
    for (const [pattern, description] of SECRET_VALUE_SHAPES) {
      if (pattern.test(value)) {
        findings.push({
          key,
          line,
          reason: `${key} holds what looks like ${description}. Remove it and rotate the credential.`,
        });
      }
    }

    const payload = jwtPayload(value);
    if (payload && typeof payload.role === "string" && payload.role !== "anon") {
      findings.push({
        key,
        line,
        reason: `${key} is a JWT with role "${payload.role}". Only the "anon" key is publishable. Remove it and rotate the credential.`,
      });
    }
  }

  return findings;
}

/**
 * The committed `.env`, or null when git tracks no such file (nothing to
 * check, which is a pass).
 */
function committedEnv() {
  try {
    return execFileSync("git", ["show", "HEAD:.env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function main() {
  const text = committedEnv();
  if (text === null) {
    console.log("[env-check] no .env is committed — nothing to check.");
    return;
  }

  const findings = auditEnv(text);
  if (findings.length === 0) {
    console.log("[env-check] committed .env holds only publishable values.");
    return;
  }

  console.error("The committed .env holds something that must not be public.\n");
  for (const { line, reason } of findings) {
    console.error(`  .env:${line}  ${reason}`);
  }
  console.error(
    "\nThis repo's .env is tracked because Lovable Cloud generates it. That makes it\n" +
      "the easiest file to leak a secret through. See CLAUDE.md > Environment variables.",
  );
  process.exitCode = 1;
}

// Run as a script (`bun scripts/check-committed-env.mjs`) rather than imported.
// Compared against argv rather than `import.meta.main`, which node only grew
// recently and which this file has to behave the same under.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
