// Turning one end-to-end run into the thing a reviewer opens.
//
// The input is Playwright's OWN json report (playwright.config.ts writes it to
// test-results/report.json). Nothing here re-derives what was run or re-opens a
// browser: the run already knows which tests it walked, which project walked
// them, and which screenshots were filed against each one, in order. This just
// reads that and lays it out.
//
// Pure on purpose — scripts/e2e-gallery.ts does the file copying, so these
// rules can be tested without a run (scripts/e2e-gallery-report.test.ts).
//
// Two kinds of thing come out of a run and they read differently:
//
//   - a FLOW (e2e/public, e2e/member, e2e/manager) is a strip of screens in the
//     order somebody walked them: the form filled in, the confirmation, the
//     manager approving it. That is the half that was missing before.
//   - the TOUR (e2e/tour) is one page per test at two widths, so it is laid out
//     as a page next to its phone-width twin, like the old contact sheet.

export type Shot = { name: string; file: string };

export type Entry = {
  /** Spec file, relative to `e2e/` (e.g. "manager/new-member-journey.spec.ts"). */
  file: string;
  /** Describe titles and the test title, outermost first. */
  titlePath: string[];
  project: string;
  status: string;
  ok: boolean;
  shots: Shot[];
};

/** Where the tour's specs live, relative to `e2e/`. */
const TOUR_PREFIX = "tour/";

export function isTourEntry(entry: Entry): boolean {
  return entry.file.startsWith(TOUR_PREFIX);
}

/** The test's own title — for the tour, that is the path it opened. */
export function entryTitle(entry: Entry): string {
  return entry.titlePath.at(-1) ?? entry.file;
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "shot"
  );
}

/** A directory name unique to one test in one project. */
export function entrySlug(entry: Entry): string {
  return slugify(`${entry.project}-${entry.file.replace(/\.spec\.ts$/, "")}-${entryTitle(entry)}`);
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type JsonAttachment = { name?: string; path?: string; contentType?: string };
type JsonResult = { status?: string; attachments?: JsonAttachment[] };
type JsonTest = { projectName?: string; status?: string; results?: JsonResult[] };
type JsonSpec = { title?: string; ok?: boolean; tests?: JsonTest[] };
type JsonSuite = { title?: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] };
export type JsonReport = { suites?: JsonSuite[] };

/**
 * Flatten Playwright's nested report into one entry per (test, project).
 *
 * The LAST result is the one read: a test that failed and passed on its retry
 * should show the run that worked, not the wreckage of the first attempt.
 * Playwright's own failure attachments (its `screenshot`, plus `video` and
 * `trace`, which are not images) sit in the same list — the video and trace are
 * left to the HTML report, where they can actually be played and replayed.
 */
export function collectEntries(report: JsonReport): Entry[] {
  const entries: Entry[] = [];

  const walk = (suite: JsonSuite, file: string, titles: string[]) => {
    const nextFile = suite.file ?? file;
    // The top-level suite of a file is titled with the file name, which would
    // then appear twice in every heading.
    const nextTitles =
      suite.title && suite.title !== nextFile ? [...titles, suite.title] : [...titles];

    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const result = test.results?.at(-1);
        const shots = (result?.attachments ?? [])
          .filter((attachment) => attachment.contentType?.startsWith("image/") && attachment.path)
          .map((attachment) => ({ name: attachment.name ?? "screenshot", file: attachment.path! }));

        entries.push({
          file: nextFile,
          titlePath: [...nextTitles, spec.title ?? "(untitled)"],
          project: test.projectName ?? "",
          status: test.status ?? result?.status ?? "unknown",
          ok: spec.ok !== false,
          shots,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, nextFile, nextTitles);
  };

  for (const suite of report.suites ?? []) walk(suite, suite.file ?? "", []);
  // The setup project signs the personas in; it is plumbing, not a flow.
  return entries.filter((entry) => entry.project !== "setup");
}

/** The flows, grouped by spec file, in the order the run reported them. */
export function flowGroups(entries: Entry[]): { file: string; entries: Entry[] }[] {
  const byFile = new Map<string, Entry[]>();
  for (const entry of entries.filter((candidate) => !isTourEntry(candidate))) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file)!.push(entry);
  }
  return [...byFile.entries()].map(([file, group]) => ({ file, entries: group }));
}

/** The tour, grouped by the path each test opened, one column per project. */
export function pageGroups(entries: Entry[]): { path: string; byProject: Map<string, Entry> }[] {
  const byPath = new Map<string, Map<string, Entry>>();
  for (const entry of entries.filter(isTourEntry)) {
    const path = entryTitle(entry);
    if (!byPath.has(path)) byPath.set(path, new Map());
    byPath.get(path)!.set(entry.project, entry);
  }
  return [...byPath.entries()].map(([path, byProject]) => ({ path, byProject }));
}

/** Every project that walked the tour, in first-seen order. */
export function tourProjects(entries: Entry[]): string[] {
  return [...new Set(entries.filter(isTourEntry).map((entry) => entry.project))];
}

/** Where a shot is copied to inside the gallery, relative to its root. */
export function shotHref(entry: Entry, shot: Shot): string {
  const name = shot.file.split("/").pop() ?? `${slugify(shot.name)}.png`;
  return `shots/${entrySlug(entry)}/${name}`;
}

function figure(entry: Entry, shot: Shot, caption: string): string {
  const href = shotHref(entry, shot);
  return [
    `<figure>`,
    `<a href="${href}"><img loading="lazy" src="${href}" alt="${escapeHtml(caption)}"></a>`,
    `<figcaption>${escapeHtml(caption)}</figcaption>`,
    `</figure>`,
  ].join("");
}

/**
 * Playwright's own words for how a test went, in the reader's.
 *
 * "unexpected" is what its report calls a failure, which is precise and no help
 * at all to somebody looking at a picture of a broken screen.
 */
export function statusLabel(status: string): string {
  if (status === "unexpected") return "failed";
  if (status === "flaky") return "passed on a retry";
  return status;
}

function statusBadge(entry: Entry): string {
  if (entry.ok) return "";
  return ` <span class="failed">${escapeHtml(statusLabel(entry.status))}</span>`;
}

/** The single page the gallery opens as. */
export function buildGalleryHtml(entries: Entry[], meta: { title: string; subtitle: string }) {
  const flows = flowGroups(entries)
    .map(({ file, entries: group }) => {
      const tests = group
        .map((entry) => {
          const shots = entry.shots.map((shot) => figure(entry, shot, shot.name)).join("\n");
          const heading = entry.titlePath.join(" › ");
          return [
            `<article>`,
            `<h3>${escapeHtml(heading)} <small>${escapeHtml(entry.project)}</small>${statusBadge(entry)}</h3>`,
            `<div class="strip">${shots || '<p class="empty">no screenshots</p>'}</div>`,
            `</article>`,
          ].join("\n");
        })
        .join("\n");
      return `<section><h2>${escapeHtml(file)}</h2>${tests}</section>`;
    })
    .join("\n");

  const projects = tourProjects(entries);
  const pages = pageGroups(entries)
    .map(({ path, byProject }) => {
      const figures = projects
        .map((project) => {
          const entry = byProject.get(project);
          if (!entry) return "";
          const shot = entry.shots.at(-1);
          if (!shot)
            return `<figure><p class="empty">${escapeHtml(project)}: no screenshot</p></figure>`;
          return figure(
            entry,
            shot,
            `${project}${entry.ok ? "" : ` — ${statusLabel(entry.status)}`}`,
          );
        })
        .join("\n");
      return `<section class="page"><h2>${escapeHtml(path)}</h2><div class="shots">${figures}</div></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; padding: 2rem 1.5rem 4rem; max-width: 1400px;
         font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  p.lede { opacity: 0.75; margin-top: 0; }
  h2 { font-size: 1.1rem; font-family: ui-monospace, monospace; }
  h2.section { font-family: inherit; font-size: 1.25rem; margin-top: 3rem; }
  h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.5rem; }
  h3 small { font-weight: 400; opacity: 0.6; font-family: ui-monospace, monospace; }
  section { margin: 2.5rem 0; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent);
            padding-top: 1rem; }
  article { margin: 1.5rem 0; }
  .strip { display: flex; gap: 1rem; overflow-x: auto; padding-bottom: 0.5rem; }
  .strip figure { flex: 0 0 320px; margin: 0; }
  .strip img { height: 420px; object-fit: cover; object-position: top center; }
  .shots { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
  .shots figure { margin: 0; flex: 1 1 320px; min-width: 280px; }
  .shots figure:last-child { flex: 0 1 390px; }
  figcaption { font-size: 0.8rem; opacity: 0.7; margin-top: 0.4rem; }
  img { width: 100%; height: auto; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        border-radius: 6px; background: #fff; }
  .failed { color: #b00020; font-weight: 600; }
  .empty { opacity: 0.6; font-size: 0.85rem; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>${escapeHtml(meta.title)}</h1>
<p class="lede">${escapeHtml(meta.subtitle)}</p>
<nav><a href="#flows">Flows</a><a href="#pages">Every page</a><a href="report/index.html">Full test report</a></nav>
<h2 class="section" id="flows">Flows, in the order they were walked</h2>
${flows || '<p class="empty">No flows in this run.</p>'}
<h2 class="section" id="pages">Every page, desktop and phone</h2>
${pages || '<p class="empty">No pages in this run.</p>'}
</body>
</html>
`;
}

/** The status tables the pull request comment carries. */
export function buildSummary(entries: Entry[]): string {
  const projects = tourProjects(entries);
  const flows = flowGroups(entries).flatMap(({ entries: group }) => group);

  const flowRows = flows.map((entry) => {
    const cell = entry.ok ? "✅" : `❌ ${statusLabel(entry.status)}`;
    return `| ${escapeMarkdown(entry.titlePath.join(" › "))} | \`${entry.project}\` | ${entry.shots.length} | ${cell} |`;
  });

  const pageRows = pageGroups(entries).map(({ path, byProject }) => {
    const cells = projects.map((project) => {
      const entry = byProject.get(project);
      if (!entry) return "—";
      return entry.ok ? "✅" : `❌ ${statusLabel(entry.status)}`;
    });
    return `| \`${path}\` | ${cells.join(" | ")} |`;
  });

  const lines: string[] = [];
  if (flowRows.length > 0) {
    lines.push("| Flow | Project | Shots | |", "| --- | --- | --- | --- |", ...flowRows, "");
  }
  if (pageRows.length > 0) {
    lines.push(
      `| Page | ${projects.join(" | ")} |`,
      `| --- | ${projects.map(() => "---").join(" | ")} |`,
      ...pageRows,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * A flow as a row of captioned pictures.
 *
 * A table rather than bare `<img>` tags because a step's own name is half of
 * what makes the strip readable, and markdown has nowhere to put a caption.
 * Wrapped every four so a long flow stacks instead of scrolling off the side of
 * the comment.
 */
function imageStrip(entry: Entry, baseUrl: string): string {
  const PER_ROW = 4;
  const cells = entry.shots.map(
    (shot) =>
      `<td align="center" valign="top"><img width="220" alt="${escapeHtml(shot.name)}" src="${baseUrl}/${shotHref(entry, shot)}"><br><sub>${escapeHtml(shot.name)}</sub></td>`,
  );
  const rows: string[] = [];
  for (let index = 0; index < cells.length; index += PER_ROW) {
    rows.push(`<tr>${cells.slice(index, index + PER_ROW).join("")}</tr>`);
  }
  return `<table>${rows.join("")}</table>`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * The pull request comment.
 *
 * With a base URL — the GitHub Pages address this run was published to — the
 * flow strips are embedded as real images, so the flow can be read without
 * leaving the pull request. Without one (a fork, or Pages not set up) it is the
 * same comment minus the pictures.
 *
 * The link to the downloadable artifact is added by the workflow, which is the
 * only thing that knows the URL: it exists only once the upload has happened.
 */
/**
 * GitHub refuses a comment body over 65536 characters with a 422, and the
 * workflow posts with `continue-on-error`, so an oversized comment would not
 * fail — it would simply never appear. A run big enough to hit that is a run
 * whose pictures are worth even more, so the comment sheds the inline strips
 * and keeps its links rather than being lost.
 */
const COMMENT_LIMIT = 60_000;

export function buildComment(
  entries: Entry[],
  options: { baseUrl?: string; reportUrl?: string; commit?: string },
): string {
  const withImages = renderComment(entries, options, true);
  if (withImages.length <= COMMENT_LIMIT) return withImages;
  return renderComment(entries, options, false);
}

function renderComment(
  entries: Entry[],
  options: { baseUrl?: string; reportUrl?: string; commit?: string },
  embedImages: boolean,
): string {
  const { baseUrl, commit } = options;
  const failed = entries.filter((entry) => !entry.ok);

  const heading =
    failed.length === 0
      ? "### 📸 What this branch looks like"
      : `### 📸 What this branch looks like — ${failed.length} failed`;

  const links: string[] = [];
  if (baseUrl) links.push(`[**Open the gallery**](${baseUrl}/index.html)`);
  if (options.reportUrl) links.push(`[full test report](${options.reportUrl})`);

  const flowSections = flowGroups(entries).map(({ file, entries: group }) => {
    const body = group
      .map((entry) => {
        const project = entry.project ? ` (\`${entry.project}\`)` : "";
        const title = `**${entry.titlePath.join(" › ")}**${project}${entry.ok ? "" : ` — ❌ ${statusLabel(entry.status)}`}`;
        if (!baseUrl || !embedImages || entry.shots.length === 0) return title;
        return [title, "", imageStrip(entry, baseUrl)].join("\n");
      })
      .join("\n\n");
    return `<details>\n<summary>${file}</summary>\n\n${body}\n\n</details>`;
  });

  return [
    heading,
    "",
    links.join(" · "),
    "",
    embedImages
      ? "Every screen below was photographed by the end-to-end suite as it walked the flow, against a seeded local club (fixture people, not the real one)."
      : "This run took more screenshots than a comment can hold, so the strips are in the gallery. Every screen was photographed by the end-to-end suite as it walked the flow, against a seeded local club (fixture people, not the real one).",
    "",
    ...flowSections,
    "",
    "<details>\n<summary>Every page, and how the run went</summary>\n",
    buildSummary(entries),
    "\n</details>",
    "",
    commit ? `<sub>Built from ${commit}.</sub>` : "",
  ].join("\n");
}
