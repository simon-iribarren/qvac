import { createRequire } from "node:module";

export function createRuntimeRequire(parentURL: string): (id: string) => unknown {
  return createRequire(parentURL) as (id: string) => unknown;
}
