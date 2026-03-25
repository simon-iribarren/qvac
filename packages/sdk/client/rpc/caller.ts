import { send, stream } from "@/client/rpc/rpc-client";
import type {
  Request,
  RequestResponseMap,
  RequestType,
  RPCOptions,
} from "@/schemas";
import type { z } from "zod";

type MapEntry<K extends RequestType> = RequestResponseMap[K];

// Distributes Omit over union members so each branch retains its own properties.
// Standard Omit<A | B, K> collapses to only the common keys — this preserves both.
type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never;

export function createCaller<K extends RequestType>(key: K) {
  type Req = MapEntry<K>["request"];
  type Res = MapEntry<K>["response"];

  return {
    async call(
      input: DistributiveOmit<Req, "type">,
      options?: RPCOptions,
    ): Promise<Res> {
      const request = { ...input, type: key } as Req & Request;
      return send(request, options) as Promise<Res>;
    },

    async *stream(
      input: DistributiveOmit<Req, "type">,
      options?: RPCOptions,
    ): AsyncGenerator<
      MapEntry<K> extends { progress: infer P } ? Res | P : Res
    > {
      const request = { ...input, type: key } as Req & Request;
      for await (const chunk of stream(request, options)) {
        yield chunk as MapEntry<K> extends { progress: infer P }
          ? Res | P
          : Res;
      }
    },
  };
}

// --- Pre-defined typed callers for all RPC operations ---

export const rpc = {
  // Core (always available)
  ping: createCaller("ping"),
  loadModel: createCaller("loadModel"),
  unloadModel: createCaller("unloadModel"),
  cancel: createCaller("cancel"),
  getModelInfo: createCaller("getModelInfo"),
  deleteCache: createCaller("deleteCache"),
  downloadAsset: createCaller("downloadAsset"),
  loggingStream: createCaller("loggingStream"),

  // Provider
  provide: createCaller("provide"),
  stopProvide: createCaller("stopProvide"),

  // LLM plugin
  completionStream: createCaller("completionStream"),

  // Embedding plugin
  embed: createCaller("embed"),

  // Whisper plugin
  transcribeStream: createCaller("transcribeStream"),

  // NMT plugin
  translate: createCaller("translate"),

  // TTS plugin
  textToSpeech: createCaller("textToSpeech"),

  // OCR plugin
  ocrStream: createCaller("ocrStream"),

  // RAG (requires embedding plugin)
  rag: createCaller("rag"),

  // Generic plugin invoke
  pluginInvoke: createCaller("pluginInvoke"),
  pluginInvokeStream: createCaller("pluginInvokeStream"),

  // Registry
  modelRegistryList: createCaller("modelRegistryList"),
  modelRegistrySearch: createCaller("modelRegistrySearch"),
  modelRegistryGetModel: createCaller("modelRegistryGetModel"),
};

// --- Plugin-specific caller groups ---
// These re-export subsets of `rpc` grouped by the plugin they require.
// Useful for tree-shaking or documenting which addon must be loaded.

export const llmOps = {
  completionStream: rpc.completionStream,
} as const;

export const embeddingOps = {
  embed: rpc.embed,
} as const;

export const whisperOps = {
  transcribeStream: rpc.transcribeStream,
} as const;

export const nmtOps = {
  translate: rpc.translate,
} as const;

export const ttsOps = {
  textToSpeech: rpc.textToSpeech,
} as const;

export const ocrOps = {
  ocrStream: rpc.ocrStream,
} as const;

// --- Custom plugin caller factory ---

/**
 * Creates typed invoke/stream callers for a custom plugin handler.
 *
 * Wraps pluginInvoke/pluginInvokeStream with compile-time typed params
 * and runtime Zod validation on the response.
 *
 * @example
 * ```typescript
 * const sentiment = createPluginCaller({
 *   handler: "analyzeSentiment",
 *   params: z.object({ text: z.string() }),
 *   response: z.object({ score: z.number(), label: z.string() }),
 * });
 *
 * const result = await sentiment.invoke(modelId, { text: "Great!" });
 * // result: { score: number; label: string }
 * ```
 */
export function createPluginCaller<
  TParams extends z.ZodType,
  TResponse extends z.ZodType,
>(config: { handler: string; params: TParams; response: TResponse }) {
  type Params = z.infer<TParams>;
  type Res = z.infer<TResponse>;

  return {
    async invoke(
      modelId: string,
      params: Params,
      options?: RPCOptions,
    ): Promise<Res> {
      const response = await rpc.pluginInvoke.call(
        { modelId, handler: config.handler, params },
        options,
      );
      return config.response.parse(response.result) as Res;
    },

    async *stream(
      modelId: string,
      params: Params,
      options?: RPCOptions,
    ): AsyncGenerator<Res> {
      for await (const chunk of rpc.pluginInvokeStream.stream(
        { modelId, handler: config.handler, params },
        options,
      )) {
        if (!chunk.done) {
          yield config.response.parse(chunk.result) as Res;
        }
      }
    },
  };
}
