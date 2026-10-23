// Version 1 of the code of conduct, as the migration seeds it, is the text
// members have already agreed to.
//
// Every acceptance on file before the code of conduct moved into the database
// says `version = 1`, and that number has to keep meaning the text those people
// read (docs/code-of-conduct.md, rule 3). So the seeded row is pinned here byte
// for byte, read straight out of the migration file rather than trusted.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION_1_BODY_MD, VERSION_1_TITLE } from "./code-of-conduct-version-1.fixture";

const MIGRATION = resolve(
  __dirname,
  "../../supabase/migrations/20261023000000_code_of_conduct_versions.sql",
);

/** The dollar-quoted strings of the seed INSERT, in order: title, then body. */
function seededVersionOne(): { title: string; body: string } {
  const sql = readFileSync(MIGRATION, "utf8");
  const insert = sql.slice(sql.indexOf("INSERT INTO public.code_of_conduct_versions"));
  const quoted = [...insert.matchAll(/\$coc\$([\s\S]*?)\$coc\$/g)].map((m) => m[1]);
  expect(quoted).toHaveLength(2);
  return { title: quoted[0], body: quoted[1] };
}

describe("the seeded version 1", () => {
  it("is the title members agreed to", () => {
    expect(seededVersionOne().title).toBe(VERSION_1_TITLE);
  });

  it("is the body members agreed to, byte for byte", () => {
    expect(seededVersionOne().body).toBe(VERSION_1_BODY_MD);
  });

  it("is seeded as version 1, live, and the baseline everyone agrees to", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const insert = sql.slice(sql.indexOf("INSERT INTO public.code_of_conduct_versions"));
    expect(insert).toMatch(
      /^INSERT INTO public\.code_of_conduct_versions \(version, title, body_md, asks_reagreement, required_version, is_current\)\s+VALUES \(\s+1,/,
    );
    expect(insert).toMatch(
      /\$coc\$,\s+true,\s+1,\s+true\s+\)\s+ON CONFLICT \(version\) DO NOTHING;/,
    );
  });
});
