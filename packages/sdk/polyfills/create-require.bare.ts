import Module from "bare-module";

export function createRuntimeRequire(parentURL: string): (id: string) => unknown {
  return Module.createRequire(parentURL) as (id: string) => unknown;
}
