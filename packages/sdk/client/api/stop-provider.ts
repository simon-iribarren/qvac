import { type StopProvideRequest } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import {
  InvalidResponseError,
  ProviderStopFailedError,
} from "@/utils/errors-client";

/**
 * Stops the running provider service.
 *
 * @returns A promise that resolves to the stop provide response containing success status
 * @throws {QvacErrorBase} When the response type is not "stopProvide" or the request fails
 */
export async function stopQVACProvider() {
  const request: StopProvideRequest = {
    type: "stopProvide",
  };

  const response = await send(request);
  if (response.type !== "stopProvide") {
    throw new InvalidResponseError("stopProvide");
  }

  if (response.error) {
    throw new ProviderStopFailedError(response.error);
  }

  return response;
}
