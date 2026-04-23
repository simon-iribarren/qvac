import { getSwarm } from "./hyperswarm";
import RPC from "bare-rpc";
import type { Connection } from "hyperswarm";
import type { Duplex } from "bare-stream";
import { withTimeout } from "@/utils/withTimeout";
import type { RPCOptions } from "@/schemas";
import { DelegateConnectionFailedError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { nowMs } from "@/profiling";
import {
  cacheDelegationConnectionTime,
  clearPeerConnectionTracking,
} from "@/server/rpc/profiling/delegation-profiler";
import { getNextCommandId } from "@/server/rpc/rpc-utils";

const logger = getServerLogger();

// This needs to run on Bare, hence why it's in server and not in client

type PeerPublicKey = string;

const activeRPCs = new Map<PeerPublicKey, RPC>();
const activeConnections = new Map<PeerPublicKey, Connection>();

const HEALTH_CHECK_TIMEOUT_MS = 1500;

function isHeartbeatResponse(payload: unknown): payload is { type: "heartbeat" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>)["type"] === "heartbeat"
  );
}

async function isRPCConnectionHealthy(
  rpc: RPC,
  timeout: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const req = rpc.request(getNextCommandId());
    req.send(JSON.stringify({ type: "heartbeat" }), "utf-8");
    const response = await withTimeout(req.reply("utf-8"), timeout);
    const payload: unknown = JSON.parse(response?.toString() || "{}");
    return isHeartbeatResponse(payload);
  } catch (error: unknown) {
    logger.debug("RPC health check failed", { error });
    return false;
  }
}

function trackConnection(publicKey: string, conn: Connection, rpc: RPC): void {
  activeRPCs.set(publicKey, rpc);
  activeConnections.set(publicKey, conn);

  conn.on("close", () => {
    logger.debug(`Connection closed for peer: ${publicKey}`);
    if (activeConnections.get(publicKey) === conn) {
      activeConnections.delete(publicKey);
      activeRPCs.delete(publicKey);
      clearPeerConnectionTracking(publicKey);
    }
  });

  conn.on("error", (err) => {
    logger.error(`Connection error for peer ${publicKey}:`, err);
    if (activeConnections.get(publicKey) === conn) {
      activeConnections.delete(publicKey);
      activeRPCs.delete(publicKey);
      clearPeerConnectionTracking(publicKey);
    }
  });
}

async function closeConnection(publicKey: string): Promise<void> {
  const existingConnection = activeConnections.get(publicKey);
  if (!existingConnection) return;

  logger.info(`🔌 Closing existing connection for peer: ${publicKey}`);

  // Wait for the close event before returning so any pending cleanup
  // in the underlying DHT stream completes before we reconnect.
  await new Promise<void>((resolve) => {
    existingConnection.once("close", () => resolve());
    existingConnection.destroy();
  });

  if (activeConnections.get(publicKey) === existingConnection) {
    activeConnections.delete(publicKey);
    activeRPCs.delete(publicKey);
    clearPeerConnectionTracking(publicKey);
  }
}

// Open a direct DHT connection to a peer by public key. Bypasses topic
// discovery entirely — we already know who we're talking to, so we skip
// swarm.join()/flush() and let the DHT route by public key.
function openDhtConnection(publicKey: string): Connection {
  const swarm = getSwarm();
  const relayThrough = swarm.relayThrough
    ? swarm.relayThrough(false, swarm)
    : null;

  return swarm.dht.connect(Buffer.from(publicKey, "hex"), {
    keyPair: swarm.keyPair,
    relayThrough,
  });
}

function waitForOpen(conn: Connection, timeout?: number): Promise<void> {
  const opened = new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      conn.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      conn.removeListener("open", onOpen);
      reject(err);
    };
    conn.once("open", onOpen);
    conn.once("error", onError);
  });

  return withTimeout(opened, timeout);
}

async function ensureRPCConnection(
  publicKey: string,
  timeout?: number,
  healthCheckTimeout?: number,
): Promise<RPC> {
  const healthCheckCap = healthCheckTimeout ?? HEALTH_CHECK_TIMEOUT_MS;
  const operationStart = nowMs();
  const getRemainingTimeout = (): number | undefined => {
    if (timeout === undefined) return undefined;
    return Math.max(timeout - (nowMs() - operationStart), 0);
  };

  const existingRpc = activeRPCs.get(publicKey);
  if (existingRpc) {
    const remainingTimeout = getRemainingTimeout();
    const probeTimeout =
      remainingTimeout === undefined
        ? healthCheckCap
        : Math.min(remainingTimeout / 2, healthCheckCap);
    const isHealthy = await isRPCConnectionHealthy(existingRpc, probeTimeout);
    if (isHealthy) {
      return existingRpc;
    }
    logger.info(
      `🧹 Cached RPC failed health check for peer ${publicKey}, reconnecting`,
    );
    cleanupStaleConnection(publicKey);
  }

  const connectionStart = nowMs();
  let conn: Connection | undefined;

  try {
    logger.info(
      `🔗 Establishing direct DHT connection to peer: ${publicKey}${timeout ? `, timeout: ${timeout}ms` : ""}`,
    );

    conn = openDhtConnection(publicKey);
    await waitForOpen(conn, getRemainingTimeout());

    logger.info(`🍺 Peer connection opened: ${publicKey}`);

    const rpc = new RPC(conn as unknown as Duplex, () => {
      // No-op handler since we're only sending requests, not receiving them
    });

    trackConnection(publicKey, conn, rpc);

    const connectionDuration = nowMs() - connectionStart;
    cacheDelegationConnectionTime(publicKey, connectionDuration);

    return rpc;
  } catch (error: unknown) {
    if (conn && !conn.destroyed) {
      conn.destroy();
    }
    cleanupStaleConnection(publicKey);

    logger.error("Failed to establish RPC connection:", error);
    throw new DelegateConnectionFailedError(
      `RPC connection failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

// Create an RPC instance for a specific HyperSwarm peer.
// Connects directly via the DHT using the peer's public key — no topic
// discovery required.
export async function getRPC(
  publicKey: string,
  options: RPCOptions = {},
): Promise<RPC> {
  if (options.forceNewConnection) {
    await closeConnection(publicKey);
  }

  return await ensureRPCConnection(
    publicKey,
    options.timeout,
    options.healthCheckTimeout,
  );
}

/**
 * Remove a stale RPC connection for a peer.
 * Called when a delegation request fails (e.g., timeout) so the next
 * attempt creates a fresh connection instead of reusing a dead RPC.
 */
export function cleanupStaleConnection(publicKey: string): void {
  logger.info(
    `🗑️ Removing stale connection for peer: ${publicKey} after failed delegation`,
  );
  activeRPCs.delete(publicKey);
  const conn = activeConnections.get(publicKey);
  if (conn) {
    conn.destroy();
    activeConnections.delete(publicKey);
  }
  clearPeerConnectionTracking(publicKey);
}
