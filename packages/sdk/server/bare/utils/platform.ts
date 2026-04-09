import os from "bare-os";

export interface PlatformInfo {
  os: string;
  arch: string;
  totalMemory: number;
  availableMemory: number;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getPlatformInfo(): PlatformInfo {
  const totalMemory = safeCall(() => os.totalmem(), 0);
  const freeMemory = safeCall(() => os.freemem(), 0);

  const availableMemory =
    freeMemory > 0 ? freeMemory : totalMemory > 0 ? totalMemory * 0.5 : 0;

  return {
    os: safeCall(() => os.platform(), "unknown"),
    arch: safeCall(() => os.arch(), "unknown"),
    totalMemory,
    availableMemory,
  };
}
