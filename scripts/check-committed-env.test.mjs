import { describe, expect, it } from "vitest";

import {
  PUBLISHABLE_ENV_KEYS,
  auditEnv,
  gitRevisionFor,
  jwtPayload,
  parseEnv,
} from "./check-committed-env.mjs";

/** Build an unsigned JWT carrying `payload`, the shape Supabase keys have. */
function jwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.SIGNATURE`;
}

const ANON_KEY = jwt({ iss: "supabase", ref: "abc", role: "anon" });
const SERVICE_ROLE_KEY = jwt({ iss: "supabase", ref: "abc", role: "service_role" });

/** The committed `.env` as Lovable writes it today: the case that must pass. */
const PUBLISHABLE_ENV = [
  'SUPABASE_PROJECT_ID="abcdefghijklmnopqrst"',
  `SUPABASE_PUBLISHABLE_KEY="${ANON_KEY}"`,
  'SUPABASE_URL="https://c--0000-prod.lovable.cloud"',
  'VITE_SUPABASE_PROJECT_ID="abcdefghijklmnopqrst"',
  `VITE_SUPABASE_PUBLISHABLE_KEY="${ANON_KEY}"`,
  'VITE_SUPABASE_URL="https://c--0000-prod.lovable.cloud"',
  'VITE_GOOGLE_OAUTH_CLIENT_ID="626329413356-abc.apps.googleusercontent.com"',
].join("\n");

describe("parseEnv", () => {
  it("reads quoted, unquoted and export-prefixed assignments", () => {
    const entries = parseEnv(['A="one"', "B=two", "export C='three'"].join("\n"));
    expect(entries).toEqual([
      { key: "A", value: "one", line: 1 },
      { key: "B", value: "two", line: 2 },
      { key: "C", value: "three", line: 3 },
    ]);
  });

  it("skips blanks and comments, and reports 1-indexed line numbers", () => {
    const entries = parseEnv(["# a comment", "", 'REAL="x"'].join("\n"));
    expect(entries).toEqual([{ key: "REAL", value: "x", line: 3 }]);
  });
});

describe("jwtPayload", () => {
  it("decodes a JWT payload", () => {
    expect(jwtPayload(ANON_KEY)).toMatchObject({ role: "anon" });
  });

  it("returns null for anything that is not a JWT", () => {
    expect(jwtPayload("https://example.com")).toBeNull();
    expect(jwtPayload("a.b")).toBeNull();
  });
});

describe("gitRevisionFor", () => {
  it("reads the index under --staged, which is what a commit will contain", () => {
    // The pre-commit hook depends on this: HEAD would be the PREVIOUS commit,
    // so a hook reading it would pass the very commit introducing the secret.
    expect(gitRevisionFor(["--staged"])).toBe(":.env");
  });

  it("reads HEAD by default, which is what CI checks", () => {
    expect(gitRevisionFor([])).toBe("HEAD:.env");
  });
});

describe("auditEnv", () => {
  it("passes the publishable set Lovable commits today", () => {
    expect(auditEnv(PUBLISHABLE_ENV)).toEqual([]);
  });

  it("keeps every allowlisted key in step with that file", () => {
    // If Lovable adds a key and someone allowlists it without updating this
    // fixture, the fixture stops proving the real file passes.
    const keys = parseEnv(PUBLISHABLE_ENV).map((entry) => entry.key);
    expect(new Set(keys)).toEqual(PUBLISHABLE_ENV_KEYS);
  });

  it("rejects a service-role key by name", () => {
    const findings = auditEnv(
      `${PUBLISHABLE_ENV}\nSUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"`,
    );
    expect(findings).toHaveLength(2); // the name rule and the JWT-role rule
    expect(findings.every((f) => f.key === "SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(findings[0].reason).toContain("must never be committed");
  });

  it("rejects a service-role JWT hiding behind an allowlisted name", () => {
    // The allowlist alone would wave this through: the key name is one we
    // expect. Only the value-shape rule catches it.
    const findings = auditEnv(
      PUBLISHABLE_ENV.replace(
        `VITE_SUPABASE_PUBLISHABLE_KEY="${ANON_KEY}"`,
        `VITE_SUPABASE_PUBLISHABLE_KEY="${SERVICE_ROLE_KEY}"`,
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("VITE_SUPABASE_PUBLISHABLE_KEY");
    expect(findings[0].reason).toContain('role "service_role"');
  });

  it("rejects an unrecognised key so a new one gets a human look", () => {
    const findings = auditEnv(`${PUBLISHABLE_ENV}\nVITE_SOMETHING_NEW="whatever"`);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("VITE_SOMETHING_NEW");
    expect(findings[0].reason).toContain("not in the publishable allowlist");
  });

  it.each([
    ["a Supabase secret key", "sb_secret_abcdefghijklmnop"],
    ["a Supabase access token", "sbp_0123456789abcdef0123456789abcdef01234567"],
    ["a GitHub token", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a Slack token", "xoxb-000000-000000-abcdefghijklmnop"],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----"],
    [
      "a Postgres URL with a password",
      "postgresql://postgres:hunter2@db.example.com:5432/postgres",
    ],
  ])("rejects %s whatever key it is under", (_label, value) => {
    const findings = auditEnv(`${PUBLISHABLE_ENV}\nVITE_SUPABASE_URL="${value}"`);
    expect(findings.some((f) => f.key === "VITE_SUPABASE_URL")).toBe(true);
  });

  it("reports the line number so the failure points at the offending row", () => {
    const findings = auditEnv(`${PUBLISHABLE_ENV}\nLOVABLE_API_KEY="anything"`);
    expect(findings[0].line).toBe(8);
  });

  it("passes when nothing is committed", () => {
    expect(auditEnv("")).toEqual([]);
  });
});
