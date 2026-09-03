// The seeded local club the end-to-end tests run against, and the guard that
// keeps them off the hosted project.
//
// The manifest is written by scripts/seed-local-club.mjs, so there is one
// description of "a club with people in it" and the pictures a reviewer sees are
// of the same club the flows are proved against. docs/e2e-tests.md has the run
// instructions.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { isLocalSupabase } from "../../scripts/local-supabase";

export type Persona = "member" | "manager";

type ClubFixture = {
  /** Which database these ids exist in. Checked against SUPABASE_URL below. */
  supabaseUrl?: string;
  personas: Record<Persona, { email: string; userId: string }>;
  password: string;
  params: Record<string, string>;
  /**
   * Per-path parameter values, for a name that means different people on
   * different pages. `$userId` is somebody a manager is looking at on
   * `/manager/users`, and one of the member's own dependants on `/account`.
   * Optional: a fixture written before this existed still tours everything
   * else, and `fillRouteParams` falls back to the flat map above.
   */
  paramsByPath?: Record<string, Record<string, string>>;
  /**
   * The member persona's family: they are a parent of two children, neither of
   * whom has a login.
   *
   * Optional for the same reason `paramsByPath` is: a fixture written before
   * this existed still runs everything that does not need it, and a spec that
   * does need it says so rather than failing somewhere further in.
   */
  household?: {
    guardianUserId: string;
    children: { userId: string; name: string; dateOfBirth: string }[];
  };
};

// Resolved against the repo root, not the working directory: the seed writes it
// there, and a run started from a subdirectory would otherwise report "no
// seeded club" for a perfectly good one.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  process.env.LOCAL_CLUB_FIXTURE ?? ".local-club-fixture.json",
);
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Where a persona's signed-in session is saved.
 *
 * playwright.config.ts calls this too, so the projects and the setup that
 * writes their sessions cannot disagree about the path.
 */
export function storageStatePath(persona: Persona) {
  return `e2e/.auth/${persona}.json`;
}

/**
 * The seeded club, or a hard failure explaining which half of the setup is
 * missing.
 *
 * Deliberately not a smaller run: a manifest without credentials (or the
 * reverse) means a step got reordered or an environment variable stopped being
 * exported, and quietly skipping every signed-in flow would take the whole
 * suite's point away behind a green check.
 */
export function readClubFixture(): ClubFixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `No seeded club at ${FIXTURE_PATH}. Run \`bash scripts/e2e.sh\`, or see docs/e2e-tests.md.`,
    );
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      `There is a seeded club at ${FIXTURE_PATH} but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so nobody can be signed in.`,
    );
  }

  // Signing in is a SERVICE-ROLE admin call, and GoTrue's generate_link CREATES
  // the account when it does not exist — so pointed at the hosted project this
  // would put fixture people in the club's real auth. Checking the manifest's
  // own URL as well as the loopback rule catches the case where the two arrive
  // from different places (bun auto-loads `.env`, so it happens).
  assertLocalSupabase(SUPABASE_URL);
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ClubFixture;
  if (fixture.supabaseUrl && fixture.supabaseUrl !== SUPABASE_URL) {
    throw new Error(
      `The club was seeded against ${fixture.supabaseUrl} but SUPABASE_URL is ${SUPABASE_URL}. Refusing to sign in: these are different databases.`,
    );
  }
  return fixture;
}

/** Refuse to make admin calls against anything but a local stack. */
export function assertLocalSupabase(url: string) {
  if (isLocalSupabase(url)) return;
  throw new Error(
    `Refusing to talk to ${new URL(url).hostname} as the service role: the end-to-end tests only ever drive a local stack.`,
  );
}

/**
 * A service-role client for arranging and inspecting fixture state.
 *
 * Use it to set a test up or to check what a flow wrote, never to stand in for
 * the flow itself — a test that writes the row the app was supposed to write
 * passes whether or not the app works.
 */
export function adminClient(): SupabaseClient {
  const url = SUPABASE_URL;
  if (!url || !SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  }
  assertLocalSupabase(url);
  return createClient(url, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * scripts/seed-local-club.mjs's applicant persona. Exported so a spec that
 * needs to search for them by email (there is nowhere else to read it back
 * from: they are not in `personas` above) uses this instead of its own copy
 * of the literal.
 */
export const APPLICANT_EMAIL = "applicant@example.com";

/**
 * The seeded applicant's user id, resolved live rather than carried in the
 * manifest above: `personas` there is only the two people `auth.setup.ts`
 * signs in (a magic link per entry), and `params` is only the `$segment`
 * values `scripts/site-pages.ts` needs for a route. The applicant is
 * neither — never signed in, only ever the target of something a manager
 * does.
 *
 * Goes through the same `user_id_by_email` RPC the app itself uses to
 * resolve a person by email (see CLAUDE.md's Supabase-clients table), rather
 * than `auth.admin.listUsers()` — which paginates (50 users by default) and
 * would start missing the applicant the moment the seeded club holds more
 * people than that.
 */
export async function applicantUserId(): Promise<string> {
  const { data, error } = await adminClient().rpc("user_id_by_email", {
    _email: APPLICANT_EMAIL,
  });
  if (error) throw new Error(`could not look up the seeded applicant: ${error.message}`);
  if (!data) throw new Error(`no seeded user with email ${APPLICANT_EMAIL}`);
  return data;
}
