import { send, stream } from "@/client/rpc/rpc-client";
import type {
  Request,
  RequestResponseMap,
  RequestType,
  RPCOptions,
} from "@/schemas";

type MapEntry<K extends RequestType> = RequestResponseMap[K];

/**
 * Creates a typed caller for a specific RPC operation.
 *
 * Eliminates boilerplate in client API methods:
 * - Auto-injects the `type` discriminator field
 * - Returns the narrowed response type (no manual `response.type` check)
 * - Provides both `.call()` and `.stream()` based on the operation
 *
 * @example
 * ```typescript
 * const embedCaller = createCaller("embed");
 * const response = await embedCaller.call({ modelId, text });
 * // response is EmbedResponse — no cast, no type check
 * ```
 */
export function createCaller<K extends RequestType>(key: K) {
  type Req = MapEntry<K>["request"];
  type Res = MapEntry<K>["response"];

  return {
    async call(input: Omit<Req, "type">, options?: RPCOptions): Promise<Res> {
      const request = { ...input, type: key } as Req & Request;
      return send(request, options) as Promise<Res>;
    },

    async *stream(
      input: Omit<Req, "type">,
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

/**
 * Pre-defined typed callers for all RPC operations.
 *
 * Use `rpc.<operation>.call(input)` for request-response or
 * `rpc.<operation>.stream(input)` for streaming.
 *
 * @example
 * ```typescript
 * import { rpc } from "@/client/rpc/caller";
 *
 * const pong = await rpc.ping.call({});
 * const embedRes = await rpc.embed.call({ modelId, text });
 * ```
 */
export const rpc = {
  ping: createCaller("ping"),
  loadModel: createCaller("loadModel"),
  completionStream: createCaller("completionStream"),
  unloadModel: createCaller("unloadModel"),
  embed: createCaller("embed"),
  cancel: createCaller("cancel"),
  provide: createCaller("provide"),
  stopProvide: createCaller("stopProvide"),
  deleteCache: createCaller("deleteCache"),
  downloadAsset: createCaller("downloadAsset"),
  getModelInfo: createCaller("getModelInfo"),
  transcribeStream: createCaller("transcribeStream"),
  loggingStream: createCaller("loggingStream"),
  translate: createCaller("translate"),
  textToSpeech: createCaller("textToSpeech"),
  ocrStream: createCaller("ocrStream"),
  rag: createCaller("rag"),
  pluginInvoke: createCaller("pluginInvoke"),
  pluginInvokeStream: createCaller("pluginInvokeStream"),
  modelRegistryList: createCaller("modelRegistryList"),
  modelRegistrySearch: createCaller("modelRegistrySearch"),
  modelRegistryGetModel: createCaller("modelRegistryGetModel"),
};
