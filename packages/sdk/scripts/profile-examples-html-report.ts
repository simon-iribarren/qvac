import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  EXAMPLE_PROFILE_MANIFEST,
  type ExampleProfileManifestEntry,
} from "./profile-examples-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const defaultReportDir = join(packageRoot, "examples", ".profiler-report");

// ── Types ───────────────────────────────────────────────────────────

interface AggregatedStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  sum: number;
  last: number;
}

interface ProfilerJSON {
  ok: boolean;
  example: string;
  error?: { name?: string; message?: string; stack?: string };
  stderr?: string;
  profiler?: {
    config?: Record<string, unknown>;
    aggregates: Record<string, AggregatedStats>;
    recentEvents?: unknown[];
    exportedAt?: number;
  };
}

interface ExampleRow {
  name: string;
  tier: string;
  ok: boolean;
  errorMessage?: string;
  totalClientTimeMs: number;
  inferenceTimeMs: number;
  sdkOverheadMs: number;
  downloadTimeMs: number;
  loadTimeMs: number;
  aggregateCount: number;
  aggregates: Record<string, AggregatedStats>;
}

// ── Metric classification ───────────────────────────────────────────

function sumMatching(
  agg: Record<string, AggregatedStats>,
  predicate: (key: string) => boolean,
): number {
  let total = 0;
  for (const [key, stats] of Object.entries(agg)) {
    if (predicate(key)) total += stats.sum;
  }
  return total;
}

function classifyExample(
  name: string,
  tier: string,
  data: ProfilerJSON,
): ExampleRow {
  const agg = data.profiler?.aggregates ?? {};

  const totalClientTime = sumMatching(agg, (k) =>
    k.endsWith(".totalClientTime"),
  );
  const inferenceTime = sumMatching(
    agg,
    (k) =>
      k.endsWith(".server.handlerExecution") ||
      k.endsWith(".server.totalServerTime"),
  );
  const downloadTime = sumMatching(
    agg,
    (k) => k.includes("download.") && k.endsWith("Time"),
  );
  const loadTime = sumMatching(agg, (k) => k.endsWith(".load.totalTime"));

  const sdkOverhead = Math.max(0, totalClientTime - inferenceTime);

  return {
    name,
    tier,
    ok: data.ok,
    errorMessage: data.error?.message,
    totalClientTimeMs: totalClientTime,
    inferenceTimeMs: inferenceTime,
    sdkOverheadMs: sdkOverhead,
    downloadTimeMs: downloadTime,
    loadTimeMs: loadTime,
    aggregateCount: Object.keys(agg).length,
    aggregates: agg,
  };
}

// ── Duration formatting ─────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

// ── Metric type detection (mirrors profiler exporters) ──────────────

type MetricType = "duration" | "bytes" | "throughput" | "number";

function detectMetricType(name: string): MetricType {
  const lower = name.toLowerCase();
  if (lower.includes("bps") || lower.includes("speed")) return "throughput";
  if (
    lower.includes("bytes") ||
    lower.includes("downloaded") ||
    lower.includes("size")
  )
    return "bytes";
  if (
    lower.includes("count") ||
    lower.includes("tokens") ||
    lower.includes("factor") ||
    lower.includes("totalsegments") ||
    lower.includes("totalsamples")
  )
    return "number";
  return "duration";
}

function fmtMetric(value: number, name: string): string {
  const type = detectMetricType(name);
  if (type === "bytes") {
    if (value < 1024) return `${value.toFixed(0)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (type === "throughput") {
    if (value < 1024) return `${value.toFixed(0)} B/s`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB/s`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  if (type === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  }
  return fmtMs(value);
}

// ── Metric grouping for detail view ─────────────────────────────────

interface MetricGroup {
  label: string;
  metrics: [string, AggregatedStats][];
}

function groupMetrics(agg: Record<string, AggregatedStats>): MetricGroup[] {
  const groups: Record<string, [string, AggregatedStats][]> = {
    "RPC / Client": [],
    "Server / Inference": [],
    "Model Loading": [],
    Download: [],
    Delegation: [],
    Other: [],
  };

  for (const [key, stats] of Object.entries(agg)) {
    if (key.includes("server.") || key.includes("handler")) {
      groups["Server / Inference"]!.push([key, stats]);
    } else if (key.includes("load.") || key.includes("modelInit")) {
      groups["Model Loading"]!.push([key, stats]);
    } else if (key.includes("download.")) {
      groups["Download"]!.push([key, stats]);
    } else if (key.includes("delegat")) {
      groups["Delegation"]!.push([key, stats]);
    } else if (
      key.includes("rpc") ||
      key.includes("Client") ||
      key.includes("parsing") ||
      key.includes("overhead")
    ) {
      groups["RPC / Client"]!.push([key, stats]);
    } else {
      groups["Other"]!.push([key, stats]);
    }
  }

  return Object.entries(groups)
    .filter(([, metrics]) => metrics.length > 0)
    .map(([label, metrics]) => ({
      label,
      metrics: metrics.sort((a, b) => a[0].localeCompare(b[0])),
    }));
}

// ── Load data ───────────────────────────────────────────────────────

function loadResults(reportDir: string): ExampleRow[] {
  const manifestMap = new Map<string, ExampleProfileManifestEntry>();
  for (const entry of EXAMPLE_PROFILE_MANIFEST) {
    const slug = entry.relativePath.replace(/\//g, "__").replace(/\.ts$/, "");
    manifestMap.set(slug, entry);
  }

  const jsonFiles = readdirSync(reportDir).filter((f) => f.endsWith(".json"));
  const rows: ExampleRow[] = [];

  for (const file of jsonFiles) {
    const slug = file.replace(/\.json$/, "");
    const entry = manifestMap.get(slug);
    if (!entry || entry.mode !== "harness") continue;

    try {
      const raw = readFileSync(join(reportDir, file), "utf-8");
      const data = JSON.parse(raw) as ProfilerJSON;
      rows.push(classifyExample(entry.relativePath, entry.tier, data));
    } catch {
      // skip malformed
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ── HTML generation ─────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateDetailRows(row: ExampleRow, index: number): string {
  const groups = groupMetrics(row.aggregates);
  let html = `<tr class="detail-row" id="detail-${index}"><td colspan="8"><div class="detail-content">`;

  for (const group of groups) {
    html += `<div class="metric-group"><h4>${escHtml(group.label)}</h4>`;
    html += `<table class="metric-table"><thead><tr>`;
    html += `<th>Metric</th><th>Count</th><th>Min</th><th>Avg</th><th>Max</th><th>Total</th>`;
    html += `</tr></thead><tbody>`;

    for (const [key, stats] of group.metrics) {
      const shortKey = key.split(".").slice(-2).join(".");
      html += `<tr>`;
      html += `<td class="metric-key" title="${escHtml(key)}">${escHtml(shortKey)}</td>`;
      html += `<td class="num">${stats.count}</td>`;
      html += `<td class="num">${fmtMetric(stats.min, key)}</td>`;
      html += `<td class="num">${fmtMetric(stats.avg, key)}</td>`;
      html += `<td class="num">${fmtMetric(stats.max, key)}</td>`;
      html += `<td class="num">${fmtMetric(stats.sum, key)}</td>`;
      html += `</tr>`;
    }

    html += `</tbody></table></div>`;
  }

  html += `</div></td></tr>`;
  return html;
}

function tierBadge(tier: string): string {
  const colors: Record<string, string> = {
    smoke: "#4ade80",
    standard: "#60a5fa",
    heavy: "#f472b6",
  };
  const color = colors[tier] ?? "#94a3b8";
  return `<span class="tier-badge" style="--tier-color: ${color}">${tier}</span>`;
}

function overheadBar(inference: number, sdk: number, total: number): string {
  if (total === 0) return `<div class="bar-container"><div class="bar-empty">no timing data</div></div>`;

  const infPct = (inference / total) * 100;
  const sdkPct = (sdk / total) * 100;

  return `<div class="bar-container">
    <div class="bar-inference" style="width: ${infPct.toFixed(1)}%" title="Inference: ${fmtMs(inference)} (${pct(inference, total)})"></div>
    <div class="bar-sdk" style="width: ${sdkPct.toFixed(1)}%" title="SDK overhead: ${fmtMs(sdk)} (${pct(sdk, total)})"></div>
  </div>`;
}

function generateHTML(rows: ExampleRow[]): string {
  const passing = rows.filter((r) => r.ok).length;
  const total = rows.length;
  const skipped = EXAMPLE_PROFILE_MANIFEST.filter(
    (e) => e.mode === "skip",
  ).length;
  const totalExamples = EXAMPLE_PROFILE_MANIFEST.length;

  const avgInferencePct =
    rows.reduce((acc, r) => {
      if (r.totalClientTimeMs === 0) return acc;
      return acc + r.inferenceTimeMs / r.totalClientTimeMs;
    }, 0) /
    rows.filter((r) => r.totalClientTimeMs > 0).length;

  const summaryTableRows = rows
    .map((row, i) => {
      const statusIcon = row.ok
        ? `<span class="status-ok">&#10003;</span>`
        : `<span class="status-fail">&#10007;</span>`;

      return `<tr class="summary-row" onclick="toggleDetail(${i})">
      <td>${statusIcon}</td>
      <td class="example-name">${escHtml(row.name)}</td>
      <td>${tierBadge(row.tier)}</td>
      <td class="num">${fmtMs(row.totalClientTimeMs)}</td>
      <td>${overheadBar(row.inferenceTimeMs, row.sdkOverheadMs, row.totalClientTimeMs)}</td>
      <td class="num pct-cell">${pct(row.inferenceTimeMs, row.totalClientTimeMs)}</td>
      <td class="num pct-cell">${pct(row.sdkOverheadMs, row.totalClientTimeMs)}</td>
      <td class="num">${row.aggregateCount}</td>
    </tr>
    ${generateDetailRows(row, i)}`;
    })
    .join("\n");

  const skipRows = EXAMPLE_PROFILE_MANIFEST.filter((e) => e.mode === "skip")
    .map(
      (e) =>
        `<tr><td class="example-name">${escHtml(e.relativePath)}</td><td>${escHtml(e.reason)}</td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QVAC SDK — Profiler Examples Report</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #242836;
    --border: #2e3348;
    --text: #e2e8f0;
    --text-dim: #8892b0;
    --accent: #7c3aed;
    --green: #4ade80;
    --red: #f87171;
    --blue: #60a5fa;
    --pink: #f472b6;
    --inference-color: #7c3aed;
    --sdk-color: #f59e0b;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: var(--text);
  }

  h2 {
    font-size: 1.1rem;
    font-weight: 500;
    margin: 2rem 0 0.75rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  h4 {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .header {
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .header p {
    color: var(--text-dim);
    font-size: 0.85rem;
  }

  .stats-bar {
    display: flex;
    gap: 2rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }

  .stat {
    display: flex;
    flex-direction: column;
  }

  .stat-value {
    font-size: 1.4rem;
    font-weight: 700;
    color: var(--text);
  }

  .stat-value.green { color: var(--green); }
  .stat-value.blue { color: var(--blue); }
  .stat-value.pink { color: var(--pink); }

  .stat-label {
    font-size: 0.7rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .legend {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  .legend-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    margin-right: 0.4rem;
    vertical-align: middle;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  th {
    text-align: left;
    padding: 0.6rem 0.75rem;
    color: var(--text-dim);
    font-weight: 500;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .summary-row {
    cursor: pointer;
    transition: background 0.15s;
  }

  .summary-row:hover {
    background: var(--surface);
  }

  .example-name {
    font-weight: 500;
    white-space: nowrap;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .pct-cell {
    color: var(--text-dim);
    font-size: 0.75rem;
  }

  .status-ok { color: var(--green); font-weight: 700; }
  .status-fail { color: var(--red); font-weight: 700; }

  .tier-badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--bg);
    background: var(--tier-color);
  }

  /* Inference vs SDK bar */
  .bar-container {
    display: flex;
    height: 14px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--surface2);
    min-width: 120px;
  }

  .bar-inference {
    background: var(--inference-color);
    height: 100%;
    transition: width 0.3s;
  }

  .bar-sdk {
    background: var(--sdk-color);
    height: 100%;
    transition: width 0.3s;
  }

  .bar-empty {
    color: var(--text-dim);
    font-size: 0.65rem;
    padding: 0 0.5rem;
    line-height: 14px;
  }

  /* Expandable detail rows */
  .detail-row {
    display: none;
  }

  .detail-row.open {
    display: table-row;
  }

  .detail-content {
    padding: 1rem 0.75rem;
    background: var(--surface);
    border-radius: 4px;
    margin: 0.25rem 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: 1rem;
  }

  .metric-group {
    background: var(--surface2);
    border-radius: 4px;
    padding: 0.75rem;
  }

  .metric-table {
    font-size: 0.72rem;
  }

  .metric-table th {
    font-size: 0.65rem;
    padding: 0.3rem 0.5rem;
  }

  .metric-table td {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }

  .metric-key {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--blue);
  }

  /* Skip table */
  .skip-table {
    margin-top: 0.5rem;
  }

  .skip-table td {
    font-size: 0.75rem;
    color: var(--text-dim);
    padding: 0.3rem 0.75rem;
  }

  .skip-table .example-name {
    color: var(--text-dim);
    font-weight: 400;
  }

  .footer {
    margin-top: 3rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    font-size: 0.7rem;
    color: var(--text-dim);
  }

  @media (max-width: 900px) {
    body { padding: 1rem; }
    .detail-content { grid-template-columns: 1fr; }
    .stats-bar { gap: 1rem; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>QVAC SDK — Profiler Examples Report</h1>
  <p>Inference vs SDK overhead across all examples. Click a row to expand detailed metrics.</p>
  <div class="stats-bar">
    <div class="stat">
      <span class="stat-value green">${passing}/${total}</span>
      <span class="stat-label">Passing</span>
    </div>
    <div class="stat">
      <span class="stat-value blue">${totalExamples}</span>
      <span class="stat-label">Total examples</span>
    </div>
    <div class="stat">
      <span class="stat-value pink">${skipped}</span>
      <span class="stat-label">Skipped</span>
    </div>
    <div class="stat">
      <span class="stat-value">${isNaN(avgInferencePct) ? "—" : (avgInferencePct * 100).toFixed(1) + "%"}</span>
      <span class="stat-label">Avg inference share</span>
    </div>
  </div>
</div>

<h2>Results</h2>
<div class="legend">
  <span><span class="legend-dot" style="background: var(--inference-color)"></span>Inference (server)</span>
  <span><span class="legend-dot" style="background: var(--sdk-color)"></span>SDK overhead (RPC, parsing, transport)</span>
</div>

<table>
<thead>
<tr>
  <th></th>
  <th>Example</th>
  <th>Tier</th>
  <th style="text-align:right">Total time</th>
  <th>Inference / SDK split</th>
  <th style="text-align:right">Infer %</th>
  <th style="text-align:right">SDK %</th>
  <th style="text-align:right">Ops</th>
</tr>
</thead>
<tbody>
${summaryTableRows}
</tbody>
</table>

<h2>Skipped examples (${skipped})</h2>
<table class="skip-table">
<tbody>
${skipRows}
</tbody>
</table>

<div class="footer">
  Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC &middot;
  Timings are machine-specific (cache, GPU, network) — use for structure, not benchmarks.
</div>

<script>
function toggleDetail(i) {
  const row = document.getElementById('detail-' + i);
  if (row) row.classList.toggle('open');
}
</script>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────

const reportDir = process.argv[2] ?? defaultReportDir;
const outPath =
  process.argv[3] ?? join(reportDir, "profiler-examples-report.html");

const rows = loadResults(reportDir);

if (rows.length === 0) {
  console.error(
    `No profiler JSON results found in ${reportDir}.\n` +
      `Run: bun run profile-examples-report -- --tier=heavy`,
  );
  process.exit(1);
}

const html = generateHTML(rows);
writeFileSync(outPath, html, "utf-8");
console.log(`Wrote ${outPath} (${rows.length} examples)`);
