import type {
  ModelRegistryListResponse,
  ModelRegistrySearchRequest,
  ModelRegistrySearchResponse,
  ModelRegistryGetModelRequest,
  ModelRegistryGetModelResponse,
  ModelRegistryEntry,
} from "@/schemas";
import { REGISTRY_ERROR_CODES } from "@/schemas/sdk-errors-registry";
import {
  getAddonFromEngine,
  resolveCanonicalEngine,
} from "@/schemas/engine-addon-map";
import { getRegistryClient } from "@/server/bare/registry/registry-client";
import { getServerLogger } from "@/logging";
import { ModelRegistryQueryFailedError } from "@/utils/errors-server";

interface QvacError extends Error {
  code?: number;
}

const logger = getServerLogger();

function toHexString(
  value: Buffer | string | { data: number[] } | undefined,
): string {
  if (!value) return "";
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "string") return value;
  if (typeof value === "object" && "data" in value) {
    return Buffer.from(value.data).toString("hex");
  }
  return "";
}

interface RegistryModelRaw {
  path: string;
  source: string;
  engine?: string;
  quantization?: string;
  params?: string;
  blobBinding?: {
    coreKey?: Buffer | string | { data: number[] };
    blockOffset?: number;
    blockLength?: number;
    byteOffset?: number;
    byteLength?: number;
    sha256?: string;
  };
}

function processRegistryModel(
  model: RegistryModelRaw,
): ModelRegistryEntry | null {
  const engine = resolveCanonicalEngine(model.engine || "");
  if (!engine) {
    logger.warn(
      `Skipping model with unknown engine "${model.engine}": ${model.path}`,
    );
    return null;
  }

  const filename = model.path.split("/").pop() || model.path;
  const blobBinding = model.blobBinding || {};

  const blobCoreKey = toHexString(blobBinding.coreKey);
  const blobBlockOffset = blobBinding.blockOffset ?? 0;
  const blobBlockLength = blobBinding.blockLength ?? 0;
  const blobByteOffset = blobBinding.byteOffset ?? 0;
  const expectedSize = blobBinding.byteLength ?? 0;
  const sha256Checksum = blobBinding.sha256 || "";

  const addon = getAddonFromEngine(engine);

  // Extract model name from path
  const parts = model.path.split("/");
  const name =
    (parts.length >= 2
      ? parts[1] || parts[0]
      : filename.replace(/\.\w+$/, "")) || filename;

  return {
    name,
    registryPath: model.path,
    registrySource: model.source,
    blobCoreKey,
    blobBlockOffset,
    blobBlockLength,
    blobByteOffset,
    modelId: filename,
    addon,
    expectedSize,
    sha256Checksum,
    engine,
    quantization: model.quantization || "",
    params: model.params || "",
  };
}

export async function handleModelRegistryList(): Promise<ModelRegistryListResponse> {
  logger.debug("Handling QVAC model registry list request");

  try {
    const client = await getRegistryClient();
    const registryModels = await client.findBy();
    const models = (registryModels as RegistryModelRaw[])
      .map(processRegistryModel)
      .filter((m): m is ModelRegistryEntry => m !== null);

    logger.debug(`QVAC model registry list returned ${models.length} models`);

    return {
      type: "modelRegistryList",
      success: true,
      models,
    };
  } catch (error) {
    logger.error("QVAC model registry list failed:", error);

    // Re-throw registry client errors directly (19001-19003)
    const qvacError = error as QvacError;
    if (
      qvacError.code === REGISTRY_ERROR_CODES.FAILED_TO_CONNECT ||
      qvacError.code === REGISTRY_ERROR_CODES.FAILED_TO_CLOSE ||
      qvacError.code === REGISTRY_ERROR_CODES.MODEL_NOT_FOUND
    ) {
      throw error;
    }

    // Wrap unknown errors in SDK error
    throw new ModelRegistryQueryFailedError(
      error instanceof Error ? error.message : "Unknown error",
      error,
    );
  }
}

export async function handleModelRegistrySearch(
  request: ModelRegistrySearchRequest,
): Promise<ModelRegistrySearchResponse> {
  logger.debug("Handling QVAC model registry search request", request);

  try {
    const client = await getRegistryClient();

    const registryModels = (await client.findBy({
      ...(request.quantization && { quantization: request.quantization }),
    })) as RegistryModelRaw[];

    let models = registryModels
      .map(processRegistryModel)
      .filter((m): m is ModelRegistryEntry => m !== null);

    if (request.engine) {
      models = models.filter((m) => m.engine === request.engine);
    }

    if (request.filter) {
      const filterLower = request.filter.toLowerCase();
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(filterLower) ||
          m.registryPath.toLowerCase().includes(filterLower) ||
          m.addon.toLowerCase().includes(filterLower) ||
          m.engine.toLowerCase().includes(filterLower),
      );
    }

    if (request.addon) {
      models = models.filter((m) => m.addon === request.addon);
    }

    logger.debug(
      `QVAC model registry search returned ${models.length} models`,
    );

    return {
      type: "modelRegistrySearch",
      success: true,
      models,
    };
  } catch (error) {
    logger.error("QVAC model registry search failed:", error);

    // Re-throw registry client errors directly (19001-19003)
    const qvacError = error as QvacError;

    if (
      qvacError.code === REGISTRY_ERROR_CODES.FAILED_TO_CONNECT ||
      qvacError.code === REGISTRY_ERROR_CODES.FAILED_TO_CLOSE ||
      qvacError.code === REGISTRY_ERROR_CODES.MODEL_NOT_FOUND
    ) {
      throw error;
    }

    throw new ModelRegistryQueryFailedError(
      error instanceof Error ? error.message : "Unknown error",
      error,
    );
  }
}

export async function handleModelRegistryGetModel(
  request: ModelRegistryGetModelRequest,
): Promise<ModelRegistryGetModelResponse> {
  logger.debug("Handling QVAC model registry get model request", request);

  try {
    const client = await getRegistryClient();

    const rawModel = await client.getModel(
      request.registryPath,
      request.registrySource,
    );

    if (!rawModel) {
      throw new ModelRegistryQueryFailedError(
        `Model not found: ${request.registrySource}/${request.registryPath}`,
      );
    }

    const model = processRegistryModel(rawModel as RegistryModelRaw);

    if (!model) {
      throw new ModelRegistryQueryFailedError(
        `Model has unknown engine "${(rawModel as RegistryModelRaw).engine}": ${request.registryPath}`,
      );
    }

    logger.debug("QVAC model registry get model found:", model.name);

    return {
      type: "modelRegistryGetModel",
      success: true,
      model,
    };
  } catch (error) {
    logger.error("QVAC model registry get model failed:", error);

    // Re-throw registry client errors directly (19001-19003)
    const qvacError = error as QvacError;
    if (
      qvacError.code === REGISTRY_ERROR_CODES.FAILED_TO_CONNECT ||
      qvacError.code === REGISTRY_ERROR_CODES.FAILED_TO_CLOSE ||
      qvacError.code === REGISTRY_ERROR_CODES.MODEL_NOT_FOUND
    ) {
      throw error;
    }

    throw new ModelRegistryQueryFailedError(
      error instanceof Error ? error.message : "Unknown error",
      error,
    );
  }
}
