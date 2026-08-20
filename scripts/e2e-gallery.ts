#!/usr/bin/env bun
//
// Build the pull request's picture gallery out of an end-to-end run.
//
//   bash scripts/e2e.sh                 # the run itself
//   bun scripts/e2e-gallery.ts          # -> gallery/index.html
//
// It photographs nothing and opens no browser: the suite already did that
// (e2e/support/screenshots.ts), and Playwright's own json report says which
// tests ran, in which project, with which screenshots attached in what order.
// This copies those images somewhere publishable and lays them out — flows
// first, as strips of screens in the order somebody walked them, then every
// page at desktop and phone width.
//
// Options, all optional:
//
//   --report=<file>        Playwright's json report (default test-results/report.json)
//   --playwright-report=<dir>  the HTML report to carry along (default playwright-report)
//   --out=<dir>            where the gallery is written (default gallery)
//   --base-url=<url>       the published address, which is what lets the pull
//                          request comment embed the pictures inline
//   --commit=<sha>         shown in the comment's footer
//
// Writes `index.html` (+ `shots/`, + `report/`), `summary.md` and `comment.md`.
// `.github/workflows/e2e.yml` publishes the directory and posts `comment.md`.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildComment,
  buildGalleryHtml,
  buildSummary,
  collectEntries,
  shotHref,
  type JsonReport,
} from "./e2e-gallery-report";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name: string, fallback = ""): string {
  const match = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(`--${name}=`.length) : fallback;
}

const REPORT = resolve(REPO_ROOT, option("report", "test-results/report.json"));
const HTML_REPORT = resolve(REPO_ROOT, option("playwright-report", "playwright-report"));
const OUT_DIR = resolve(REPO_ROOT, option("out", "gallery"));
const BASE_URL = option("base-url").replace(/\/$/, "");

// The output directory is wiped, so refuse anything that is not a fresh
// directory below the repo: an absolute path elsewhere, `.`, or `src` would
// delete working files instead.
if (OUT_DIR === REPO_ROOT || !OUT_DIR.startsWith(REPO_ROOT + sep)) {
  console.error(
    `[gallery] refusing to empty ${OUT_DIR}: --out must name a directory below ${REPO_ROOT}`,
  );
  process.exit(1);
}

if (!existsSync(REPORT)) {
  console.error(`[gallery] no run to build from at ${REPORT}. Run \`bash scripts/e2e.sh\` first.`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, "utf8")) as JsonReport;
const entries = collectEntries(report);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let copied = 0;
let missing = 0;
for (const entry of entries) {
  for (const shot of entry.shots) {
    const destination = join(OUT_DIR, shotHref(entry, shot));
    if (!existsSync(shot.file)) {
      // A shot named in the report with no file behind it means the run was
      // cleaned up underneath us — worth saying, not worth failing over.
      missing += 1;
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(shot.file, destination);
    copied += 1;
  }
}

// Playwright's own report rides along: it is where a failure's trace and video
// are, and served over http (which is what publishing it is for) its trace
// viewer opens inline.
if (existsSync(HTML_REPORT)) {
  cpSync(HTML_REPORT, join(OUT_DIR, "report"), { recursive: true });
}

const failed = entries.filter((entry) => !entry.ok);
const subtitle = `${entries.length} tests, ${copied} screenshots, ${failed.length} failed. Photographed by the end-to-end suite against a seeded local club — fixture people, not the real one.`;

writeFileSync(
  join(OUT_DIR, "index.html"),
  buildGalleryHtml(entries, { title: "UTS Jitsu — this branch, walked", subtitle }),
);
writeFileSync(join(OUT_DIR, "summary.md"), buildSummary(entries));
writeFileSync(
  join(OUT_DIR, "comment.md"),
  buildComment(entries, {
    baseUrl: BASE_URL || undefined,
    reportUrl: BASE_URL ? `${BASE_URL}/report/index.html` : undefined,
    commit: option("commit") || undefined,
  }),
);
// GitHub Pages runs Jekyll over a branch by default, which drops files and
// directories whose names begin with an underscore — Playwright's report has
// them. This one empty file turns that off.
writeFileSync(join(OUT_DIR, ".nojekyll"), "");

console.log(`[gallery] ${entries.length} tests, ${copied} screenshots -> ${OUT_DIR}`);
if (missing > 0) console.warn(`[gallery] ${missing} screenshot(s) named in the report were gone`);
