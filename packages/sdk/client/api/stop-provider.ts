import type { StopProvideParams } from "@/schemas";
import { rpc } from "@/client/rpc/caller";
import { ProviderStopFailedError } from "@/utils/errors-client";

/**
 * Stops a running provider service and leaves the specified topic.
 *
 * @param options - Options object with required topic
 * @param options.topic - Topic hex string to leave
 * @returns A promise that resolves to the stop provide response containing success status
 * @throws {QvacErrorBase} When the response type is not "stopProvide" or the request fails
 */
export async function stopQVACProvider(params: StopProvideParams) {
  const response = await rpc.stopProvide.call({ topic: params.topic });

  if (response.error) {
    throw new ProviderStopFailedError(response.error);
  }

  return response;
}
