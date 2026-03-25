import type { GetModelInfoParams } from "@/schemas";
import { rpc } from "@/client/rpc/caller";

export async function getModelInfo(params: GetModelInfoParams) {
  const response = await rpc.getModelInfo.call({ name: params.name });
  return response.modelInfo;
}
