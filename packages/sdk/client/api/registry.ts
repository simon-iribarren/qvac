import type { ModelRegistryEntry, ModelRegistryEntryAddon } from "@/schemas";
import { rpc } from "@/client/rpc/caller";
import { ModelRegistryQueryFailedError } from "@/utils/errors-client";

export type { ModelRegistryEntry, ModelRegistryEntryAddon };

export interface ModelRegistrySearchParams {
  filter?: string;
  engine?: string;
  quantization?: string;
  modelType?: ModelRegistryEntryAddon;
  addon?: ModelRegistryEntryAddon;
}

interface RegistryResponse {
  success?: boolean | undefined;
  error?: string | undefined;
}

function validateRegistryResponse(
  response: RegistryResponse,
  fallbackError?: string,
): void {
  if (!response.success) {
    throw new ModelRegistryQueryFailedError(
      response.error ?? fallbackError ?? "Unknown registry error",
    );
  }
}

async function modelRegistryList(): Promise<ModelRegistryEntry[]> {
  const response = await rpc.modelRegistryList.call({});
  validateRegistryResponse(response);
  return response.models!;
}

async function modelRegistrySearch(
  params: ModelRegistrySearchParams = {},
): Promise<ModelRegistryEntry[]> {
  const { modelType, ...rest } = params;
  const response = await rpc.modelRegistrySearch.call({
    ...rest,
    addon: modelType ?? rest.addon,
  });
  validateRegistryResponse(response);
  return response.models!;
}

async function modelRegistryGetModel(
  registryPath: string,
  registrySource: string,
): Promise<ModelRegistryEntry> {
  const response = await rpc.modelRegistryGetModel.call({
    registryPath,
    registrySource,
  });
  validateRegistryResponse(
    response,
    `Model not found: ${registrySource}/${registryPath}`,
  );
  return response.model!;
}

export { modelRegistryList, modelRegistrySearch, modelRegistryGetModel };
