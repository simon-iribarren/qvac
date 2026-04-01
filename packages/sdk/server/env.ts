import { runtimeProcess as workerProcess } from "@/server/utils/runtime-bare-io";
import { isBareKit } from "which-runtime";
import { z } from "zod";

const envSchema = z.object({
  QVAC_IPC_SOCKET_PATH: z.string().optional(),
  HOME_DIR: z.string(),
});

type WorkerEnv = z.infer<typeof envSchema>;

let validatedEnv: WorkerEnv | null = null;

/**
 * Initialize the worker environment. Call once at worker startup.
 * Returns whether RPC config was parsed from arguments.
 */
export function initEnv(): { hasRPCConfig: boolean } {
  /* eslint-disable @typescript-eslint/no-unsafe-assignment -- env index + zod merge */
  const defaultHomeDir =
    workerProcess.env["HOME"] ??
    workerProcess.env["USERPROFILE"] ??
    "/tmp";
  let envConfig: Record<string, string | undefined> = {
    HOME_DIR: defaultHomeDir,
  };
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  let hasRPCConfig = false;

  if (isBareKit && workerProcess.argv[0]) {
    envConfig["HOME_DIR"] = workerProcess.argv[0];
  }

  // Try to parse any argument as JSON config (fail gracefully)
  if (workerProcess.argv[2]) {
    try {
      const rpcArgs = JSON.parse(workerProcess.argv[2]) as Record<
        string,
        string
      >;
      envConfig = { ...envConfig, ...rpcArgs };
      hasRPCConfig = true;
    } catch {
      // Not JSON or invalid - use defaults (direct mode)
    }
  }

  validatedEnv = envSchema.parse(envConfig);
  return { hasRPCConfig };
}

/**
 * Get the worker environment. Must call initEnv() first.
 */
export function getEnv() {
  if (!validatedEnv) {
    // Fallback initialization for cases where initEnv wasn't called
    initEnv();
  }
  return {
    ...workerProcess.env,
    ...validatedEnv!,
  };
}

/**
 * Get the validated env config. Must call initEnv() first.
 */
export function getValidatedEnv() {
  if (!validatedEnv) {
    initEnv();
  }
  return validatedEnv!;
}
