import { rpc } from "@/client/rpc/caller";

export async function ping() {
  return rpc.ping.call({});
}
