# cccs-accessibility

Rollup dashboard for the CCCS "Power of 13" WCAG audit pipeline: the 13
community colleges + the CCCS system site (cccs.edu).

This repo does **not** run audits. Each college's own tooling repo
(`audit-<domain>`, canonical core in [`cccs-audit-template`](https://github.com/ThirstyHead/cccs-audit-template))
runs a weekly Playwright + axe-core audit and publishes report JSON to its
results repo. The rollup **fetches each instance's latest report** from the
public results repos (no tokens needed) and renders a single dashboard:

- pages audited, clean pages, total violations
- last-run timestamp per instance
- status: **current** (ran within 10 days) / **stale** / **no runs yet** / **error**

The freshness column is deliberate: a stale or missing college must be *visible*,
not silently absent.

## Files

- `instances.json` — the 14 instances (slug, name, domain, results/tooling repos, site URL)
- `build-rollup.mjs` — zero-dep Node renderer (GitHub Contents API → `docs/index.html`)
- `.github/workflows/rollup.yml` — renders every Tuesday 06:00 UTC (after the Monday college runs), plus on-demand `workflow_dispatch`

## Usage

```bash
node build-rollup.mjs --out docs [--freshness-hours 240]
```

Published at <https://thirstyhead.com/cccs-accessibility/>.

## Adding an instance

1. Append an entry to `instances.json`.
2. Verify its results repo has `reports/axe-*.json` content.
3. Push — next run (or dispatch) includes it.
