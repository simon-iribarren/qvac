import type { EmbedParams, RPCOptions } from "@/schemas";
import { rpc } from "@/client/rpc/caller";

export async function embed(
  params: { modelId: string; text: string },
  options?: RPCOptions,
): Promise<number[]>;

export async function embed(
  params: { modelId: string; text: string[] },
  options?: RPCOptions,
): Promise<number[][]>;

export async function embed(
  params: EmbedParams,
  options?: RPCOptions,
): Promise<number[] | number[][]> {
  const response = await rpc.embed.call(params, options);
  return response.embedding;
}
