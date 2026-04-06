import type * as nodeFs from "node:fs";
import type * as nodePath from "node:path";
import { createRuntimeRequire } from "#create-require";

const isBare =
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined" &&
  typeof (globalThis as { Bare?: unknown }).Bare !== "undefined";

const req = createRuntimeRequire(import.meta.url);

export const runtimeFs = req(isBare ? "bare-fs" : "node:fs") as typeof nodeFs;

export const runtimePath = req(isBare ? "bare-path" : "node:path") as typeof nodePath;

export const runtimeProcess = req(isBare ? "bare-process" : "node:process") as NodeJS.Process;
