import type { ProvideRequest, ProvideResponse } from "@/schemas/provide";
import { getSwarm, registerProvider } from "@/server/bare/hyperswarm";
import { setupConnectionHandlers } from "./connection";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// Consumers reach the provider by calling `dht.connect(publicKey)` directly,
// so the provider only needs its DHT server bound on its keyPair — no topic
// announce required. `swarm.listen()` is the minimal operation that makes
// the keyPair reachable on the DHT.
export async function provideHandler(
  request: ProvideRequest,
): Promise<ProvideResponse> {
  const swarm = getSwarm({
    firewallConfig: request.firewall,
  });

  logger.debug("🚀 Provide request received:", request);

  try {
    const pubKey = swarm.keyPair.publicKey;
    logger.debug("🔑 Provider public key:", pubKey.toString("hex"));

    logger.info("🌐 Binding DHT server on provider keyPair...");
    await swarm.listen();
    logger.info("🎯 Provider is listening and ready to accept connections");

    setupConnectionHandlers(swarm);
    registerProvider();

    return {
      type: "provide" as const,
      success: true,
      publicKey: pubKey.toString("hex"),
    };
  } catch (error) {
    logger.error("❌ Error in provide handler:", error);
    logger.error(
      "❌ Error stack:",
      error instanceof Error ? error.stack : "No stack trace",
    );
    return {
      type: "provide" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
