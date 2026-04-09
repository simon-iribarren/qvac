import { QVACRegistryClient } from "@qvac/registry-client";
import { getCacheDir } from "@/server/utils/cache";
import { getServerLogger } from "@/logging";
import { DEFAULT_REGISTRY_CORE_KEY } from "@/constants";

const logger = getServerLogger();

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

let registryClient: QVACRegistryClient | null = null;

function isFdLockError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("File descriptor could not be locked");
  }
  return false;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getRegistryClient(): Promise<QVACRegistryClient> {
  if (registryClient) {
    logger.debug("Registry client reused");
    return registryClient;
  }

  logger.info("🔗 Creating new registry client...");

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // TODO(QVAC-12232): pass corestoreOpts: { wait: true } once @qvac/registry-client is bumped
      const client = new QVACRegistryClient({
        registryCoreKey: DEFAULT_REGISTRY_CORE_KEY,
        storage: getCacheDir(
          `registry-corestore/${DEFAULT_REGISTRY_CORE_KEY}`,
        ),
      });

      await client.ready();
      registryClient = client;

      logger.info("✅ Registry client ready");
      return registryClient;
    } catch (error) {
      lastError = error;
      if (isFdLockError(error) && attempt < MAX_RETRIES) {
        const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `Registry client fd-lock failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoff}ms...`,
        );
        await delay(backoff);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

export async function closeRegistryClient(): Promise<void> {
  if (!registryClient) return;

  const client = registryClient;
  registryClient = null;

  logger.info("🔌 Closing registry client...");

  try {
    await client.close();
    logger.info("✅ Registry client closed");
  } catch (error) {
    logger.error(
      "❌ Error closing registry client:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function hasActiveRegistryClient(): boolean {
  return registryClient !== null;
}
