import type { UnloadModelParams } from "@/schemas";
import { rpc } from "@/client/rpc/caller";
import { close } from "@/client/rpc/rpc-client";
import { stopLoggingStreamForModel } from "@/client/logging-stream-registry";
import { ModelUnloadFailedError } from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

/**
 * Unloads a previously loaded model from the server.
 *
 * When the last model is unloaded (no more models remain), this function
 * automatically closes the RPC connection, allowing the process to exit
 * naturally without requiring manual cleanup.
 *
 * @param params - The parameters for unloading the model
 * @param params.modelId - The unique identifier of the model to unload
 * @param params.clearStorage - Whether to clear the storage for the model
 * @throws {QvacErrorBase} When the response type is invalid or when the unload operation fails
 */
export async function unloadModel(params: UnloadModelParams) {
  const response = await rpc.unloadModel.call({
    modelId: params.modelId,
    clearStorage: params.clearStorage ?? false,
  });

  if (!response.success) {
    throw new ModelUnloadFailedError(params.modelId);
  }

  stopLoggingStreamForModel(params.modelId);

  if (
    response.hasActiveModels === false &&
    response.hasActiveProviders === false
  ) {
    logger.info(
      "🧹 No models or providers active, automatically closing RPC connection...",
    );
    await close();
  }
}
