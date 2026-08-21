// The two properties the live-database workflow depends on, checked here rather
// than trusted.
//
// `.github/workflows/migration-drift.yml` asks the live database two questions
// nothing else can answer: is every migration in the repo actually applied, and
// do the client grants match `supabase/lint/client-grants-expected.txt`. Both
// need the `SUPABASE_DB_URL` secret, and both used to warn-and-pass without it.
// So every run since the repo began reported success while checking nothing,
// which is worse than having no check: a green tick stops anyone from looking.
//
//   1. an unarmed check exits non-zero, so a green tick means it really ran,
//   2. and the credential never reaches a `pull_request` run, because a same-repo
//      PR branch (how Lovable and every agent push here) does receive secrets
//      while running scripts the PR itself can rewrite.
//
// Neither rule is visible in a passing run — a workflow that quietly loses
// either one still goes green — which is why they are pinned in the unit suite.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_DIR = resolve(process.cwd(), ".github/workflows");
const DRIFT_WORKFLOW = "migration-drift.yml";

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
}

function read(file: string): string {
  return readFileSync(join(WORKFLOW_DIR, file), "utf8");
}

/** The `if [ -z "$SUPABASE_DB_URL" ]; then … fi` blocks, one per live step. */
function missingSecretGuards(source: string): string[] {
  return [...source.matchAll(/if \[ -z "\$SUPABASE_DB_URL" \]; then\n([\s\S]*?)\n\s*fi\n/g)].map(
    (match) => match[1],
  );
}

describe("the migration drift workflow", () => {
  it("has a step for each live check", () => {
    // A rename that made the regexes below match nothing would turn every rule
    // here into a test that passes by finding no work.
    const source = read(DRIFT_WORKFLOW);
    expect([...source.matchAll(/secrets\.SUPABASE_DB_URL/g)]).toHaveLength(2);
  });

  it("guards every step that is handed the credential", () => {
    const source = read(DRIFT_WORKFLOW);
    expect(missingSecretGuards(source)).toHaveLength(
      [...source.matchAll(/secrets\.SUPABASE_DB_URL/g)].length,
    );
  });

  it("fails rather than passing when the secret is missing", () => {
    const guards = missingSecretGuards(read(DRIFT_WORKFLOW));
    for (const guard of guards) {
      expect(
        guard,
        "an unarmed check must exit non-zero, or a green tick means only that the job started",
      ).toContain("exit 1");
      expect(guard).not.toContain("exit 0");
    }
  });

  it("never runs on a pull request, so the credential stays away from unreviewed code", () => {
    const triggers = read(DRIFT_WORKFLOW).split(/^jobs:/m)[0];
    expect(triggers).not.toMatch(/^\s*pull_request(_target)?:/m);
  });
});

describe("the other workflows", () => {
  it("has workflows to check", () => {
    expect(workflowFiles().length).toBeGreaterThan(3);
  });

  it("keeps the live database credential out of anything a pull request triggers", () => {
    const offenders = workflowFiles().filter((file) => {
      const source = read(file);
      if (!source.includes("secrets.SUPABASE_DB_URL")) return false;
      const triggers = source.split(/^jobs:/m)[0];
      return /^\s*pull_request(_target)?:/m.test(triggers);
    });
    expect(
      offenders,
      "a same-repo pull request receives secrets and can rewrite the script that reads them",
    ).toEqual([]);
  });
});
