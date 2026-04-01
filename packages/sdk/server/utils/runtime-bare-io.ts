import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import nodeProcess from "node:process";
import { createRequire } from "node:module";

const requireBare = createRequire(import.meta.url);

function useBareNativeIo(): boolean {
  return (
    typeof (globalThis as { Bun?: unknown }).Bun === "undefined" &&
    typeof (globalThis as { Bare?: unknown }).Bare !== "undefined"
  );
}

const useBare = useBareNativeIo();

export const runtimeFs: typeof nodeFs = useBare
  ? (requireBare("bare-fs") as unknown as typeof nodeFs)
  : nodeFs;

export const runtimePath: typeof nodePath = useBare
  ? (requireBare("bare-path") as unknown as typeof nodePath)
  : nodePath;

export const runtimeProcess: NodeJS.Process = useBare
  ? (requireBare("bare-process") as unknown as NodeJS.Process)
  : nodeProcess;
