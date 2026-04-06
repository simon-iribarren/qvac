import type * as nodeFs from "node:fs";
import type * as nodePath from "node:path";
import type { createRequire as CreateRequireFn } from "node:module";

type RequireFn = (id: string) => unknown;

const isBare =
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined" &&
  typeof (globalThis as { Bare?: unknown }).Bare !== "undefined";

function getRequire(): RequireFn {
  if (isBare) {
    return require;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("node:module") as { createRequire: typeof CreateRequireFn };
  return mod.createRequire(import.meta.url);
}

const req = getRequire();

export const runtimeFs = req(isBare ? "bare-fs" : "node:fs") as typeof nodeFs;

export const runtimePath = req(isBare ? "bare-path" : "node:path") as typeof nodePath;

export const runtimeProcess = req(isBare ? "bare-process" : "node:process") as NodeJS.Process;
