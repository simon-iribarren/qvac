import { writeFileSync } from "fs";
import { pathToFileURL } from "url";

import { profiler } from "@qvac/sdk";

const exampleAbsPath = process.argv[2];
const outJsonPathArg = process.argv[3];

if (!exampleAbsPath || !outJsonPathArg) {
  console.error(
    "Usage: bun run scripts/profile-example-harness.ts <absolute-example.ts> <output.json>",
  );
  process.exit(2);
}

const outJsonPath = outJsonPathArg;
const extraArgs = process.argv.slice(4);

// Strip harness args so the example sees a clean argv.
// Extra args (argv[4+]) are forwarded so examples that read
// process.argv[2] (e.g. WAV path, image path) receive them.
process.argv = [process.argv[0]!, exampleAbsPath, ...extraArgs];

profiler.enable({
  mode: "verbose",
  includeServerBreakdown: true,
});

let flushed = false;
let importError: unknown;
const stderrChunks: string[] = [];

const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (
  chunk: string | Uint8Array,
  ...args: unknown[]
): boolean => {
  if (typeof chunk === "string") {
    stderrChunks.push(chunk);
  } else {
    stderrChunks.push(Buffer.from(chunk).toString("utf-8"));
  }
  return (origStderrWrite as Function)(chunk, ...args);
};

function formatError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: JSON.stringify(error) };
}

function flushReport(ok: boolean, error?: unknown): void {
  if (flushed) {
    return;
  }
  flushed = true;
  const profilerPayload = profiler.exportJSON({ includeRecentEvents: true });
  profiler.disable();
  const stderr = stderrChunks.join("");
  const record = {
    ok,
    example: exampleAbsPath,
    error: formatError(error),
    stderr: stderr.length > 0 ? stderr : undefined,
    profiler: profilerPayload,
  };
  writeFileSync(outJsonPath, JSON.stringify(record, null, 2) + "\n", "utf-8");
}

const origExit = process.exit.bind(process);
process.exit = (code?: number): never => {
  const c = code ?? 0;
  flushReport(
    c === 0,
    c === 0 ? undefined : { message: `process.exit(${String(c)})` },
  );
  origExit(c);
  throw new Error("unreachable");
};

try {
  await import(pathToFileURL(exampleAbsPath).href);
  flushReport(true);
} catch (error) {
  importError = error;
  console.error(error);
  flushReport(false, error);
}

const exitCode =
  importError === undefined ? 0 : importError instanceof Error ? 1 : 1;
origExit(exitCode);
