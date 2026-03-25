import type { RPCOptions } from "@/schemas";
import { rpc } from "@/client/rpc/caller";

export interface InvokePluginOptions<TParams = unknown> {
  modelId: string;
  handler: string;
  params: TParams;
}

/**
 * Invoke a non-streaming plugin handler.
 */
export async function invokePlugin<TResponse = unknown, TParams = unknown>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions,
): Promise<TResponse> {
  const response = await rpc.pluginInvoke.call(
    {
      modelId: options.modelId,
      handler: options.handler,
      params: options.params,
    },
    rpcOptions,
  );

  return response.result as TResponse;
}

/**
 * Invoke a streaming plugin handler.
 */
export async function* invokePluginStream<
  TResponse = unknown,
  TParams = unknown,
>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions,
): AsyncGenerator<TResponse> {
  for await (const chunk of rpc.pluginInvokeStream.stream(
    {
      modelId: options.modelId,
      handler: options.handler,
      params: options.params,
    },
    rpcOptions,
  )) {
    if (!chunk.done) {
      yield chunk.result as TResponse;
    }
  }
}
