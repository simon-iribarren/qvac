import type { StopProvideResponse } from "@/schemas/stop-provide";
import { unregisterProvider } from "@/server/bare/hyperswarm";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function stopProvideHandler(): StopProvideResponse {
  try {
    unregisterProvider();

    return {
      type: "stopProvide" as const,
      success: true,
    };
  } catch (error) {
    logger.error("❌ Error in stop provide handler:", error);
    return {
      type: "stopProvide" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
