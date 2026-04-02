import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import {
  EXAMPLE_PROFILE_MANIFEST,
  shouldRunHarness,
  type ExampleProfileManifestEntry,
  type ProfileTier,
} from "./profile-examples-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const examplesRoot = join(packageRoot, "examples");
const harnessScript = join(__dirname, "profile-example-harness.ts");

const SCRATCH_EXAMPLE_PATHS = new Set([
  "repro-cancel-bug.ts",
  "test-download-speed.ts",
]);

function collectExampleTsFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = join(base, ent.name).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      if (ent.name === "config") {
        continue;
      }
      out.push(...collectExampleTsFiles(abs, rel));
    } else if (ent.name.endsWith(".ts")) {
      if (rel === "tts/utils.ts") {
        continue;
      }
      if (SCRATCH_EXAMPLE_PATHS.has(rel)) {
        continue;
      }
      out.push(rel);
    }
  }
  return out.sort();
}

function parseArgs(argv: string[]): {
  tierCeiling: ProfileTier;
  outDir: string;
  dryRun: boolean;
  listOnly: boolean;
  skipDone: boolean;
  retryFailed: boolean;
} {
  let tierCeiling: ProfileTier = "smoke";
  let outDir = join(examplesRoot, ".profiler-report");
  let dryRun = false;
  let listOnly = false;
  let skipDone = false;
  let retryFailed = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--list") {
      listOnly = true;
    } else if (arg === "--skip-done") {
      skipDone = true;
    } else if (arg === "--retry-failed") {
      retryFailed = true;
    } else if (arg.startsWith("--tier=")) {
      const raw = arg.slice("--tier=".length);
      if (raw !== "smoke" && raw !== "standard" && raw !== "heavy") {
        console.error(`Invalid --tier=${raw} (use smoke | standard | heavy)`);
        process.exit(2);
      }
      tierCeiling = raw;
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    }
  }
  return { tierCeiling, outDir, dryRun, listOnly, skipDone, retryFailed };
}

function previousRunStatus(
  outDir: string,
  slug: string,
): "ok" | "failed" | "none" {
  const jsonPath = join(outDir, `${slug}.json`);
  if (!existsSync(jsonPath)) return "none";
  try {
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { ok?: boolean };
    return parsed.ok ? "ok" : "failed";
  } catch {
    return "none";
  }
}

function manifestPathSet(): Set<string> {
  return new Set(EXAMPLE_PROFILE_MANIFEST.map((e) => e.relativePath));
}

function entryForPath(
  relativePath: string,
): ExampleProfileManifestEntry | undefined {
  return EXAMPLE_PROFILE_MANIFEST.find((e) => e.relativePath === relativePath);
}

function slugifyRelativePath(rel: string): string {
  return rel.replace(/\//g, "__").replace(/\.ts$/, "");
}

function markdownInventory(): string {
  const discovered = collectExampleTsFiles(examplesRoot, "");
  const lines: string[] = [
    "| Example | Profiler harness | Tier / reason |",
    "|---------|------------------|---------------|",
  ];
  for (const rel of discovered) {
    const entry = entryForPath(rel);
    if (!entry) {
      lines.push(`| \`${rel}\` | — | **missing from manifest** |`);
      continue;
    }
    if (entry.mode === "harness") {
      lines.push(`| \`${rel}\` | yes | ${entry.tier} |`);
    } else {
      lines.push(`| \`${rel}\` | no | skip: ${entry.reason} |`);
    }
  }
  return lines.join("\n") + "\n";
}

const { tierCeiling, outDir, dryRun, listOnly, skipDone, retryFailed } =
  parseArgs(process.argv.slice(2));

const discovered = collectExampleTsFiles(examplesRoot, "");
const manifestPaths = manifestPathSet();
const missingOnDisk = [...manifestPaths].filter((p) => !discovered.includes(p));
const missingInManifest = discovered.filter((p) => !manifestPaths.has(p));

if (missingOnDisk.length > 0) {
  console.error("Manifest references files not found under examples/:");
  for (const p of missingOnDisk) {
    console.error(`  - ${p}`);
  }
  process.exit(2);
}

if (missingInManifest.length > 0) {
  console.error("Discovered example .ts files missing from manifest:");
  for (const p of missingInManifest) {
    console.error(`  - ${p}`);
  }
  process.exit(2);
}

if (listOnly) {
  console.log(markdownInventory());
  process.exit(0);
}

const toRun = EXAMPLE_PROFILE_MANIFEST.filter((e) =>
  shouldRunHarness(e, tierCeiling),
);

if (dryRun) {
  console.log(
    `Dry run: would profile ${String(toRun.length)} example(s) (tier ceiling: ${tierCeiling})`,
  );
  for (const e of toRun) {
    if (e.mode === "harness") {
      console.log(`  - ${e.relativePath} (${e.tier})`);
    }
  }
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const summaryRows: string[] = [
  "| Example | Tier | Exit | Aggregate ops (count) |",
  "|---------|------|------|-------------------------|",
];

let failureCount = 0;

let skippedCount = 0;

for (const entry of toRun) {
  if (entry.mode !== "harness") {
    continue;
  }
  const slug = slugifyRelativePath(entry.relativePath);
  const absExample = join(examplesRoot, entry.relativePath);
  const outJson = join(outDir, `${slug}.json`);
  const outLog = join(outDir, `${slug}.log`);

  if (skipDone || retryFailed) {
    const prev = previousRunStatus(outDir, slug);
    if (prev === "ok" && skipDone) {
      console.log(`\n⏭ Skipping ${entry.relativePath} (already ok)`);
      skippedCount += 1;
      addSummaryRowFromExisting(outJson, entry, summaryRows);
      continue;
    }
    if (prev === "failed" && !retryFailed) {
      console.log(
        `\n⏭ Skipping ${entry.relativePath} (previously failed; use --retry-failed to re-run)`,
      );
      skippedCount += 1;
      addSummaryRowFromExisting(outJson, entry, summaryRows);
      failureCount += 1;
      continue;
    }
  }

  console.log(`\n→ Profiling ${entry.relativePath} …`);
  const result = spawnSync("bun", ["run", harnessScript, absExample, outJson], {
    cwd: packageRoot,
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.stderr) {
    writeFileSync(outLog, result.stderr, "utf-8");
  }

  const exitOk = result.status === 0;
  if (!exitOk) {
    failureCount += 1;
    console.log(`  ✗ Exit ${String(result.status ?? 1)} — log: ${slug}.log`);
  }
  let aggCount = "—";
  try {
    const raw = readFileSync(outJson, "utf-8");
    const parsed = JSON.parse(raw) as {
      profiler?: { aggregates?: Record<string, unknown> };
    };
    const n = parsed.profiler?.aggregates
      ? Object.keys(parsed.profiler.aggregates).length
      : 0;
    aggCount = String(n);
  } catch {
    aggCount = "(no json)";
  }
  summaryRows.push(
    `| \`${entry.relativePath}\` | ${entry.tier} | ${exitOk ? "0" : String(result.status ?? 1)} | ${aggCount} |`,
  );
}

function addSummaryRowFromExisting(
  jsonPath: string,
  entry: ExampleProfileManifestEntry & { mode: "harness" },
  rows: string[],
): void {
  try {
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      profiler?: { aggregates?: Record<string, unknown> };
    };
    const n = parsed.profiler?.aggregates
      ? Object.keys(parsed.profiler.aggregates).length
      : 0;
    const exit = parsed.ok ? "0" : "1";
    rows.push(
      `| \`${entry.relativePath}\` | ${entry.tier} | ${exit} | ${String(n)} |`,
    );
  } catch {
    rows.push(`| \`${entry.relativePath}\` | ${entry.tier} | ? | (no json) |`);
  }
}

const summaryMd = [
  `# SDK examples — profiler report`,
  ``,
  `- Generated from \`bun run profile-examples-report\` (tier ceiling: **${tierCeiling}**).`,
  `- Per-example JSON: \`${outDir.replace(packageRoot + "/", "")}/\`*.json`,
  `- Timings and counts are **machine-specific** (cache, GPU, network); use this for structure and coverage, not benchmarks.`,
  ``,
  ...summaryRows,
  ``,
  "## Full inventory",
  ``,
  markdownInventory(),
].join("\n");

writeFileSync(join(outDir, "SUMMARY.md"), summaryMd, "utf-8");
console.log(`\nWrote ${join(outDir, "SUMMARY.md")}`);
if (skippedCount > 0) {
  console.log(`Skipped ${String(skippedCount)} already-processed example(s).`);
}
if (failureCount > 0) {
  console.log(
    `${String(failureCount)} failure(s). See .log files in ${outDir.replace(packageRoot + "/", "")}/ for stderr.`,
  );
}

process.exit(failureCount > 0 ? 1 : 0);
