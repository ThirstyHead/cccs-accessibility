/**
 * CCCS Accessibility rollup: fetch each instance's audit history from its
 * (public) results repo and render a single dashboard to docs/.
 *
 * Zero deps (node only). Results repos are public, so no token is needed.
 * Honesty requirement (plan §6.5): every instance row shows its last-run
 * timestamp + status, so a stale or missing college is visible rather than
 * silently absent.
 *
 * Usage:
 *   node build-rollup.mjs [--out docs] [--freshness-hours 240]
 *
 * For each instance (instances.json):
 *   1. GET https://raw.githubusercontent.com/ThirstyHead/<resultsRepo>/main/docs/history.json
 *      -> full run series (published by each college's build-site.mjs) — used
 *         for the per-college trend sparkline and latest-run numbers.
 *   2. Fallback: contents API -> latest axe-*.json only (no trend data).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // build-rollup.mjs lives at the repo root
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const OUT = arg('out', 'docs');
const FRESH_HOURS = Number(arg('freshness-hours', '240')); // "current" if within 10 days
const ORG = 'ThirstyHead';

const instances = JSON.parse(fs.readFileSync(path.join(ROOT, 'instances.json'), 'utf8'));

async function gh(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cccs-rollup' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

async function fetchInstance(inst) {
  // Preferred source: the published trend series (docs/history.json) — full
  // history, public, served by GitHub Pages, so no API rate-limit risk.
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${ORG}/${inst.resultsRepo}/main/docs/history.json`, {
      headers: { 'user-agent': 'cccs-rollup' },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      const series = data && Array.isArray(data.series) ? data.series : null;
      if (series && series.length) {
        const latest = series[series.length - 1];
        return {
          status: 'ok',
          inst,
          generated: latest.generated,
          reportFile: latest.reportFile,
          pages: latest.pagesAudited ?? 0,
          // cleanPages only exists in reports built after the caveat upgrade;
          // null = unknown for older runs.
          clean: latest.cleanPages ?? null,
          totalViolations: latest.totalViolations ?? 0,
          pagesBlocked: latest.pagesBlocked ?? 0,
          series,
          source: 'history.json',
        };
      }
    }
  } catch {
    // fall through to the legacy path
  }

  // Legacy: latest report only via contents API (no trend). A 404 means the
  // results repo has no reports/ directory yet — the expected state for a
  // freshly scaffolded college, NOT an error.
  const listingRes = await fetch(`https://api.github.com/repos/${ORG}/${inst.resultsRepo}/contents/reports?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cccs-rollup' },
    signal: AbortSignal.timeout(30000),
  });
  if (listingRes.status === 404) return { status: 'no-reports', inst, series: [] };
  if (!listingRes.ok) throw new Error(`list ${inst.resultsRepo}/reports -> ${listingRes.status}`);
  const listing = await listingRes.json();
  if (!Array.isArray(listing)) throw new Error(`unexpected listing: ${JSON.stringify(listing).slice(0, 120)}`);
  const byName = [...listing].filter((f) => /^axe-.*\.json$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
  const latest = byName[0];
  if (!latest) return { status: 'no-reports', inst, series: [] };
  const raw = await (await gh(latest.download_url)).text();
  const report = JSON.parse(raw);
  const pages = report.pages ?? [];
  const clean = pages.filter((p) => (p.violationTotal ?? 0) === 0).length;
  const totalViolations = pages.reduce((s, p) => s + (p.violationTotal ?? 0), 0);
  const pagesBlocked = pages.filter((p) => p.blocked || (typeof p.status === 'number' && p.status >= 400)).length;
  const ruleCounts = new Map();
  for (const p of pages) for (const v of p.violations ?? []) ruleCounts.set(v.id, (ruleCounts.get(v.id) ?? 0) + (v.nodes ?? 0));
  const topRules = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    status: 'ok',
    inst,
    generated: report.generated,
    reportFile: latest.name,
    pages: pages.length,
    clean,
    totalViolations,
    pagesBlocked,
    topRules,
    series: [],
    source: 'reports API',
  };
}

const rows = [];
for (const inst of instances) {
  try {
    rows.push(await fetchInstance(inst));
  } catch (e) {
    rows.push({ status: 'error', inst, error: String(e.message ?? e), series: [] });
  }
}

const now = new Date();
const fresh = (r) => r.status === 'ok' && now - new Date(r.generated) < FRESH_HOURS * 3600 * 1000;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const statusBadge = (r) => {
  if (r.status === 'ok')
    return fresh(r)
      ? '<span class="badge fresh">current</span>'
      : '<span class="badge stale">stale</span>';
  if (r.status === 'no-reports') return '<span class="badge none">no runs yet</span>';
  return '<span class="badge err">error</span>';
};

// Per-college trend sparkline: node-level violations per published run.
function trendSpark(series) {
  const pts = (series || []).map((s) => s.totalViolations ?? 0);
  if (pts.length < 2) return '<span class="dim">–</span>';
  const w = 150, h = 34, padX = 4, padT = 4, padB = 4;
  const max = Math.max(...pts, 1);
  const x = (i) => padX + (i * (w - 2 * padX)) / (pts.length - 1);
  const y = (v) => h - padB - (v / max) * (h - padT - padB);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts.length - 1;
  const dots = pts
    .map(
      (v, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === last ? 2.6 : 1.6}" fill="${i === last ? '#f0883e' : '#58a6ff'}"/>`,
    )
    .join('');
  return `<svg class="spark" width="${w}" height="${h}" role="img" aria-label="${pts.length} runs, latest ${pts[last]} violations"><polyline points="${line}" fill="none" stroke="#58a6ff" stroke-width="1.5"/>${dots}</svg>`;
}

const blockedBadge = (r) =>
  r.status === 'ok' && (r.pagesBlocked ?? 0) > 0 ? `<br><span class="badge blocked">${r.pagesBlocked} not audited</span>` : '';

const bodyRows = rows
  .map((r) => {
    const t = r.inst;
    const d =
      r.status === 'ok'
        ? `<td class="num">${r.pages}</td>
           <td class="num">${r.clean ?? '–'}</td>
           <td class="num ${r.totalViolations ? 'warn' : ''}">${r.totalViolations}</td>
           <td class="time">${new Date(r.generated).toUTCString().replace(':00 GMT', ' UTC')}</td>
           <td class="trend">${trendSpark(r.series)}</td>`
        : `<td class="num">–</td><td class="num">–</td><td class="num">–</td>
           <td class="time">${r.status === 'error' ? esc(r.error) : ''}</td><td class="trend"><span class="dim">–</span></td>`;
    return `<tr>
      <td><a href="${esc(t.siteUrl)}" target="_blank" rel="noopener">${esc(t.name)}</a><br>
          <span class="dim">${esc(t.domain)}</span></td>
      ${d}
      <td>${statusBadge(r)}${blockedBadge(r)}</td>
    </tr>`;
  })
  .join('\n');

const okCount = rows.filter((r) => r.status === 'ok').length;
const freshCount = rows.filter(fresh).length;
const blockedTotal = rows.reduce((s, r) => s + ((r.status === 'ok' ? r.pagesBlocked : 0) || 0), 0);
const withTrend = rows.filter((r) => r.status === 'ok' && (r.series?.length ?? 0) >= 2).length;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCCS Accessibility — Power of 13 Rollup</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0; background: #0d1117; color: #e6edf3; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .sub { color: #8b949e; margin: 0 0 1.5rem; }
  .stats { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: .75rem 1rem; }
  .stat b { display: block; font-size: 1.4rem; }
  .stat span { color: #8b949e; font-size: .8rem; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: .6rem .75rem; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { background: #161b22; color: #8b949e; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: none; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .warn { color: #f0883e; font-weight: 600; }
  .time { color: #8b949e; font-size: .8rem; white-space: nowrap; }
  .dim { color: #8b949e; font-size: .8rem; }
  .trend { white-space: nowrap; }
  .spark { vertical-align: middle; }
  .badge { display: inline-block; padding: .15rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
  .badge.fresh { background: #12261e; color: #3fb950; }
  .badge.stale { background: #2d1d0e; color: #f0883e; }
  .badge.none  { background: #1c2128; color: #8b949e; }
  .badge.err   { background: #2d1215; color: #f85149; }
  .badge.blocked { background: #2d1d0e; color: #f0883e; }
  footer { margin-top: 2rem; color: #8b949e; font-size: .8rem; line-height: 1.6; }
</style>
</head>
<body>
<div class="wrap">
  <h1>CCCS Accessibility — Power of 13</h1>
  <p class="sub">WCAG 2.1 AA audit rollup · 13 colleges + CCCS system site · generated ${esc(now.toUTCString().replace(':00 GMT', ' UTC'))}</p>
  <div class="stats">
    <div class="stat"><b>${instances.length}</b><span>instances</span></div>
    <div class="stat"><b>${okCount}</b><span>with report data</span></div>
    <div class="stat"><b>${freshCount}</b><span>current (&lt;${FRESH_HOURS / 24} days)</span></div>
    <div class="stat"><b>${withTrend}</b><span>with trend (≥2 runs)</span></div>
    <div class="stat"><b>${blockedTotal}</b><span>pages not audited (WAF/404)</span></div>
  </div>
  <table>
    <thead><tr>
      <th>College</th><th class="num">Pages</th><th class="num">Clean</th>
      <th class="num">Violations</th><th>Last run (UTC)</th><th>Trend (violations/run)</th><th>Status</th>
    </tr></thead>
    <tbody>
${bodyRows}
    </tbody>
  </table>
  <footer>
    Per-college detail: each row links to the college's own audit site. The trend chart plots node-level
    violations per weekly run (source: each results repo's published <code>docs/history.json</code>).
    Pages a college's site serves back as an HTTP error (WAF 403, 404, 5xx) are <em>not</em> audited —
    they are excluded from the violation counts and reported on the college's site as a coverage caveat.
    Reports run weekly (Mondays 06:00 UTC) by independent per-college tooling repos
    (canonical core: <a href="https://github.com/${ORG}/cccs-audit-template">cccs-audit-template</a>).
  </footer>
</div>
</body>
</html>
`;

const outDir = path.resolve(ROOT, OUT);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log(`rollup: ${rows.length} instances (${okCount} with data, ${freshCount} fresh, ${withTrend} with trend) -> ${path.join(outDir, 'index.html')}`);
for (const r of rows) console.log(`  ${r.inst.resultsRepo.padEnd(14)} ${r.status}${r.status === 'ok' ? ` pages=${r.pages} clean=${r.clean ?? '?'} violations=${r.totalViolations} blocked=${r.pagesBlocked ?? 0} runs=${r.series?.length ?? 0} generated=${r.generated}` : r.error ? ` ${r.error}` : ''}`);