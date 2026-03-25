import {
  type Request,
  pingRequestSchema,
  loadModelRequestSchema,
  completionStreamRequestSchema,
  unloadModelRequestSchema,
  embedRequestSchema,
  cancelRequestSchema,
  provideRequestSchema,
  stopProvideRequestSchema,
  deleteCacheRequestSchema,
  downloadAssetRequestSchema,
  getModelInfoRequestSchema,
  transcribeStreamRequestSchema,
  loggingStreamRequestSchema,
  translateRequestSchema,
  ttsRequestSchema,
  ocrStreamRequestSchema,
  ragRequestSchema,
  pluginInvokeRequestSchema,
  pluginInvokeStreamRequestSchema,
  modelRegistryListRequestSchema,
  modelRegistrySearchRequestSchema,
  modelRegistryGetModelRequestSchema,
} from "@/schemas";
import { reply, stream, type Router } from "./procedure";
import { handleCompletionStream } from "@/server/rpc/handlers/completion-stream";
import { handleDownloadAsset } from "@/server/rpc/handlers/download-asset";
import { handleLoadModel } from "@/server/rpc/handlers/load-model";
import { handleLoadModelDelegated } from "@/server/rpc/handlers/load-model-delegated";
import { handleCompletionStreamDelegated } from "@/server/rpc/handlers/completion-stream-delegated";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { handleUnloadModel } from "@/server/rpc/handlers/unload-model";
import { handleUnloadModelDelegated } from "@/server/rpc/handlers/unload-model-delegated";
import { handleTranscribeStream } from "@/server/rpc/handlers/transcribe-stream";
import { handleEmbed } from "@/server/rpc/handlers/embed";
import { handleTranslate } from "@/server/rpc/handlers/translate";
import { handleLoggingStream } from "@/server/rpc/handlers/logging-stream";
import { cancelHandler } from "./handlers/cancelHandler";
import { provideHandler } from "./handlers/provideHandler";
import { stopProvideHandler } from "./handlers/stopProvideHandler";
import { handleRag } from "@/server/rpc/handlers/rag";
import { handleDeleteCache } from "@/server/rpc/handlers/delete-cache";
import { handleTextToSpeech } from "@/server/rpc/handlers/text-to-speech";
import { handleGetModelInfo } from "@/server/rpc/handlers/get-model-info";
import { handleOCRStream } from "@/server/rpc/handlers/ocr-stream";
import { handlePing } from "@/server/rpc/handlers/ping";
import {
  handlePluginInvoke,
  handlePluginInvokeStream,
} from "@/server/rpc/handlers/plugin-invoke";
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel,
} from "@/server/rpc/handlers/registry";

function ragSupportsProgress(request: Request): boolean {
  if (request.type !== "rag") return false;
  return ["ingest", "saveEmbeddings", "reindex"].includes(request.operation);
}

function isModelDelegated(request: Request): boolean {
  if (!("modelId" in request)) return false;
  const entry = getModelEntry(request.modelId as string);
  return entry?.isDelegated ?? false;
}

export const registry: Router = {
  ping: reply({
    input: pingRequestSchema,
    handler: handlePing,
  }),
  unloadModel: reply({
    input: unloadModelRequestSchema,
    handler: handleUnloadModel,
    delegatedHandler: handleUnloadModelDelegated,
    isDelegated: isModelDelegated,
  }),
  embed: reply({
    input: embedRequestSchema,
    handler: handleEmbed,
  }),
  cancel: reply({
    input: cancelRequestSchema,
    handler: cancelHandler,
  }),
  provide: reply({
    input: provideRequestSchema,
    handler: provideHandler,
  }),
  stopProvide: reply({
    input: stopProvideRequestSchema,
    handler: stopProvideHandler,
  }),
  deleteCache: reply({
    input: deleteCacheRequestSchema,
    handler: handleDeleteCache,
  }),
  getModelInfo: reply({
    input: getModelInfoRequestSchema,
    handler: handleGetModelInfo,
  }),
  pluginInvoke: reply({
    input: pluginInvokeRequestSchema,
    handler: handlePluginInvoke,
  }),
  modelRegistryList: reply({
    input: modelRegistryListRequestSchema,
    handler: handleModelRegistryList,
  }),
  modelRegistrySearch: reply({
    input: modelRegistrySearchRequestSchema,
    handler: handleModelRegistrySearch,
  }),
  modelRegistryGetModel: reply({
    input: modelRegistryGetModelRequestSchema,
    handler: handleModelRegistryGetModel,
  }),

  loadModel: reply({
    input: loadModelRequestSchema,
    handler: handleLoadModel,
    delegatedHandler: handleLoadModelDelegated,
    isDelegated: (r) =>
      r.type === "loadModel" && "delegate" in r && !!r.delegate,
    supportsProgress: true,
  }),
  downloadAsset: reply({
    input: downloadAssetRequestSchema,
    handler: handleDownloadAsset,
    supportsProgress: true,
  }),
  rag: reply({
    input: ragRequestSchema,
    handler: handleRag,
    supportsProgress: ragSupportsProgress,
  }),

  completionStream: stream({
    input: completionStreamRequestSchema,
    handler: handleCompletionStream,
    delegatedHandler: handleCompletionStreamDelegated,
    isDelegated: isModelDelegated,
  }),
  transcribeStream: stream({
    input: transcribeStreamRequestSchema,
    handler: handleTranscribeStream,
  }),
  loggingStream: stream({
    input: loggingStreamRequestSchema,
    handler: handleLoggingStream,
  }),
  translate: stream({
    input: translateRequestSchema,
    handler: handleTranslate,
  }),
  textToSpeech: stream({
    input: ttsRequestSchema,
    handler: handleTextToSpeech,
  }),
  ocrStream: stream({
    input: ocrStreamRequestSchema,
    handler: handleOCRStream,
  }),
  pluginInvokeStream: stream({
    input: pluginInvokeStreamRequestSchema,
    handler: handlePluginInvokeStream,
  }),
};
