// Pure reporting logic for scripts/pr-screenshots.mjs: what counts as a page
// that rendered, and how a run is written up.
//
// Split out of the entrypoint so it can be tested. That script's top level
// deletes a directory and spawns a server, so importing it from a test is not
// an option. Same split as pwa-icon-geometry.mjs next door.
//
// A "shot" is one page at one viewport:
//   { path, viewport, status, state, file?, error? }
// where `state` is the value of the `data-page-state` attribute the app's
// failure boundaries carry (see src/routes/__root.tsx), or null.

/** "/" -> "home", "/manager/kb" -> "manager-kb". */
export function slugFor(path) {
  return path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "-");
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Did this page actually render?
 *
 * The status code is not enough on its own: the router's error boundary and
 * its 404 both render inside an ordinary 200, so a site-wide "This page didn't
 * load" would otherwise read as a clean run. A shot passes only when the
 * response was not an error AND no failure boundary claimed the page.
 *
 * This does NOT see a route that catches its own loader error and renders a
 * card in place of its content (src/routes/blog/index.tsx does exactly that).
 * Such a page is reported as fine, so treat a green run as "every route
 * rendered", not "every route has its data".
 */
export function isShotOk(shot) {
  if (!shot) return false;
  if (shot.error) return false;
  return shot.status > 0 && shot.status < 400 && !shot.state;
}

/** One human-readable cell/word for why a shot failed. */
export function failureReason(shot) {
  if (!shot) return "not attempted";
  if (shot.state) return `${shot.state} page`;
  if (shot.error) return "did not load";
  return `HTTP ${shot.status}`;
}

/** Group shots by path, preserving the order the paths were first seen. */
function groupByPath(shots) {
  const byPath = new Map();
  for (const shot of shots) {
    if (!byPath.has(shot.path)) byPath.set(shot.path, {});
    byPath.get(shot.path)[shot.viewport] = shot;
  }
  return byPath;
}

/** The markdown table the workflow embeds in its pull request comment. */
export function buildSummaryTable(shots, viewports) {
  const header = `| Page | ${viewports.map((v) => `${v.name} (${v.width}px)`).join(" | ")} |`;
  const divider = `| --- | ${viewports.map(() => "---").join(" | ")} |`;

  const rows = [...groupByPath(shots).entries()].map(([path, byViewport]) => {
    const cells = viewports.map((viewport) => {
      const shot = byViewport[viewport.name];
      if (!shot) return "—";
      return isShotOk(shot) ? `${shot.status}` : `❌ ${failureReason(shot)}`;
    });
    return `| \`${path}\` | ${cells.join(" | ")} |`;
  });

  return [header, divider, ...rows].join("\n") + "\n";
}

/** The single-page contact sheet that opens from the downloaded artifact. */
export function buildContactSheet(shots, viewports) {
  const sections = [...groupByPath(shots).entries()]
    .map(([path, byViewport]) => {
      const figures = viewports
        .map((viewport) => {
          const shot = byViewport[viewport.name];
          const src = `${viewport.name}/${slugFor(path)}.png`;
          // A failed page is still photographed whenever the shot got far
          // enough to write a file — the picture of the failure is the most
          // useful thing in the artifact.
          const image = shot?.file
            ? `<a href="${src}"><img src="${src}" alt="${escapeHtml(path)} at ${viewport.name} width"></a>`
            : "";
          const caption = isShotOk(shot)
            ? viewport.name
            : `${viewport.name} — failed: ${escapeHtml(failureReason(shot))}`;
          return `<figure><figcaption>${caption}</figcaption>${image}</figure>`;
        })
        .join("\n");
      return `<section><h2>${escapeHtml(path)}</h2><div class="shots">${figures}</div></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UTS Jitsu — PR screenshots</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; padding: 2rem 1.5rem 4rem; max-width: 1400px;
         font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.4rem; }
  section { margin: 2.5rem 0; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent);
            padding-top: 1rem; }
  h2 { font-size: 1.1rem; font-family: ui-monospace, monospace; }
  .shots { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; flex: 1 1 320px; min-width: 280px; }
  figure:last-child { flex: 0 1 390px; }
  figcaption { font-size: 0.8rem; opacity: 0.7; margin-bottom: 0.4rem; }
  img { width: 100%; height: auto; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
        border-radius: 6px; }
</style>
</head>
<body>
<h1>UTS Jitsu — every page on this branch</h1>
<p>Full-page screenshots of the production build, public pages first, then the member
area and the manager screens as the people who use them see them. Click an image for
the original.</p>
${sections}
</body>
</html>
`;
}
