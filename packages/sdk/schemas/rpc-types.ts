import type { Request, Response } from "./common";
import type { PingRequest, PingResponse } from "./ping";
import type {
  LoadModelRequest,
  LoadModelResponse,
  ModelProgressUpdate,
} from "./load-model";
import type {
  CompletionStreamRequest,
  CompletionStreamResponse,
} from "./completion-stream";
import type { UnloadModelRequest, UnloadModelResponse } from "./unload-model";
import type { EmbedRequest, EmbedResponse } from "./embed";
import type { CancelRequest, CancelResponse } from "./cancel";
import type { ProvideRequest, ProvideResponse } from "./provide";
import type { StopProvideRequest, StopProvideResponse } from "./stop-provide";
import type { DeleteCacheRequest, DeleteCacheResponse } from "./delete-cache";
import type {
  DownloadAssetRequest,
  DownloadAssetResponse,
} from "./download-asset";
import type {
  GetModelInfoRequest,
  GetModelInfoResponse,
} from "./get-model-info";
import type {
  TranscribeStreamRequest,
  TranscribeStreamResponse,
} from "./transcription";
import type {
  LoggingStreamRequest,
  LoggingStreamResponse,
} from "./logging-stream";
import type { TranslateRequest, TranslateResponse } from "./translate";
import type { TtsRequest, TtsResponse } from "./text-to-speech";
import type { OCRStreamRequest, OCRStreamResponse } from "./ocr";
import type { RagRequest, RagResponse, RagProgressUpdate } from "./rag";
import type {
  PluginInvokeRequest,
  PluginInvokeResponse,
  PluginInvokeStreamRequest,
  PluginInvokeStreamResponse,
} from "./plugin";
import type {
  ModelRegistryListRequest,
  ModelRegistryListResponse,
  ModelRegistrySearchRequest,
  ModelRegistrySearchResponse,
  ModelRegistryGetModelRequest,
  ModelRegistryGetModelResponse,
} from "./registry";

/**
 * Maps each RPC operation (keyed by the request's `type` discriminator) to its
 * specific request, response, and optional progress types.
 *
 * Used by `ResponseFor<T>` and `StreamResponseFor<T>` to narrow return types
 * from `send()` and `stream()`.
 */
export type RequestResponseMap = {
  ping: {
    request: PingRequest;
    response: PingResponse;
  };
  loadModel: {
    request: LoadModelRequest;
    response: LoadModelResponse;
    progress: ModelProgressUpdate;
  };
  completionStream: {
    request: CompletionStreamRequest;
    response: CompletionStreamResponse;
  };
  unloadModel: {
    request: UnloadModelRequest;
    response: UnloadModelResponse;
  };
  embed: {
    request: EmbedRequest;
    response: EmbedResponse;
  };
  cancel: {
    request: CancelRequest;
    response: CancelResponse;
  };
  provide: {
    request: ProvideRequest;
    response: ProvideResponse;
  };
  stopProvide: {
    request: StopProvideRequest;
    response: StopProvideResponse;
  };
  deleteCache: {
    request: DeleteCacheRequest;
    response: DeleteCacheResponse;
  };
  downloadAsset: {
    request: DownloadAssetRequest;
    response: DownloadAssetResponse;
    progress: ModelProgressUpdate;
  };
  getModelInfo: {
    request: GetModelInfoRequest;
    response: GetModelInfoResponse;
  };
  transcribeStream: {
    request: TranscribeStreamRequest;
    response: TranscribeStreamResponse;
  };
  loggingStream: {
    request: LoggingStreamRequest;
    response: LoggingStreamResponse;
  };
  translate: {
    request: TranslateRequest;
    response: TranslateResponse;
  };
  textToSpeech: {
    request: TtsRequest;
    response: TtsResponse;
  };
  ocrStream: {
    request: OCRStreamRequest;
    response: OCRStreamResponse;
  };
  rag: {
    request: RagRequest;
    response: RagResponse;
    progress: RagProgressUpdate;
  };
  pluginInvoke: {
    request: PluginInvokeRequest;
    response: PluginInvokeResponse;
  };
  pluginInvokeStream: {
    request: PluginInvokeStreamRequest;
    response: PluginInvokeStreamResponse;
  };
  modelRegistryList: {
    request: ModelRegistryListRequest;
    response: ModelRegistryListResponse;
  };
  modelRegistrySearch: {
    request: ModelRegistrySearchRequest;
    response: ModelRegistrySearchResponse;
  };
  modelRegistryGetModel: {
    request: ModelRegistryGetModelRequest;
    response: ModelRegistryGetModelResponse;
  };
};

export type RequestType = keyof RequestResponseMap;

/**
 * Narrows the Response type based on a Request's `type` discriminator.
 *
 * When `T` is a specific request (e.g. `PingRequest`), resolves to the
 * matching response (e.g. `PingResponse`). When `T` is the wide `Request`
 * union, distributes and resolves to the full `Response` union.
 */
export type ResponseFor<T extends Request> = T extends {
  type: infer K extends RequestType;
}
  ? RequestResponseMap[K]["response"]
  : Response;

/**
 * Like `ResponseFor` but includes progress event types for streaming operations.
 *
 * Operations that support progress (loadModel, downloadAsset, rag) include
 * their progress update type in the union. Non-progress operations resolve
 * identically to `ResponseFor<T>`.
 */
export type StreamResponseFor<T extends Request> = T extends {
  type: infer K extends RequestType;
}
  ? RequestResponseMap[K] extends { progress: infer P }
    ? RequestResponseMap[K]["response"] | P
    : RequestResponseMap[K]["response"]
  : Response;
