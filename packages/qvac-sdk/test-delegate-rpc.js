/**
 * Integration test for delegate-rpc-client.ts (PR #402)
 *
 * Tests the specific bug fixes:
 * 1. Event listener leak — ensureConnectionHandler registers only once
 * 2. closeConnection awaits the close event (with 5s safety timeout)
 * 3. Post-flush connection waiting via onConnection listener
 * 4. Listener cleanup on timeout
 *
 * Run with: bare ./scripts/bare-bootstrap.js test-delegate-rpc.js
 */

import Hyperswarm from "hyperswarm";
import crypto from "bare-crypto";
import RPC from "bare-rpc";
import process from "bare-process";

import {
  getRPC,
  cleanupStaleConnection,
} from "./dist/server/bare/delegate-rpc-client.js";
import { getSwarm } from "./dist/server/bare/hyperswarm.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL: ${message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Server setup ---
// Create an independent Hyperswarm server (not using the SDK singleton)
const serverSeed = crypto.randomBytes(32);
const serverSwarm = new Hyperswarm({ seed: serverSeed });
const topic = crypto.randomBytes(32);
const topicHex = topic.toString("hex");

serverSwarm.join(topic, { server: true, client: false });

let serverConnectionCount = 0;

serverSwarm.on("connection", (conn) => {
  serverConnectionCount++;
  console.log(
    `  [server] Connection #${serverConnectionCount} from: ${conn.remotePublicKey?.toString("hex")?.substring(0, 16)}...`,
  );

  // RPC echo handler — replies with whatever was sent
  new RPC(conn, async (req) => {
    const data = req.data?.toString() || "{}";
    try {
      const parsed = JSON.parse(data);
      const reply = JSON.stringify({
        type: parsed.type || "echo",
        success: true,
        echo: parsed,
      });
      req.reply(reply, "utf-8");
    } catch {
      req.reply(JSON.stringify({ type: "error", message: "parse error" }), "utf-8");
    }
  });
});

await serverSwarm.flush();

const serverPubKey = serverSwarm.keyPair.publicKey.toString("hex");
console.log(`\n🖥️  Server started`);
console.log(`   Topic:  ${topicHex.substring(0, 16)}...`);
console.log(`   PubKey: ${serverPubKey.substring(0, 16)}...`);

// Small delay to let the DHT propagate
await sleep(500);

// =====================================================================
// Test 1: Basic getRPC() connection
// =====================================================================
console.log("\n🧪 Test 1: Basic getRPC() connection");
try {
  const rpc = await getRPC(topicHex, serverPubKey, { timeout: 15_000 });
  assert(rpc != null, "getRPC() returns an RPC instance");
} catch (err) {
  assert(false, `getRPC() should not throw: ${err.message}`);
}

// =====================================================================
// Test 2: No listener leak on repeated getRPC() calls
// =====================================================================
console.log("\n🧪 Test 2: No event listener leak on repeated getRPC() calls");
const clientSwarm = getSwarm();
const listenersBefore = clientSwarm.listenerCount("connection");

// Call getRPC 5 more times — should reuse cached RPC, not add listeners
for (let i = 0; i < 5; i++) {
  await getRPC(topicHex, serverPubKey, { timeout: 5_000 });
}

const listenersAfter = clientSwarm.listenerCount("connection");
assert(
  listenersAfter === listenersBefore,
  `Listener count stable after 5 extra getRPC() calls: before=${listenersBefore}, after=${listenersAfter}`,
);

// =====================================================================
// Test 3: Cached RPC instance reuse
// =====================================================================
console.log("\n🧪 Test 3: getRPC() returns cached RPC for same peer");
const rpcA = await getRPC(topicHex, serverPubKey, { timeout: 5_000 });
const rpcB = await getRPC(topicHex, serverPubKey, { timeout: 5_000 });
assert(rpcA === rpcB, "Same RPC instance returned for same peer");

// =====================================================================
// Test 4: forceNewConnection closes old connection and reconnects
// =====================================================================
console.log("\n🧪 Test 4: forceNewConnection closes old + reconnects");
const connCountBefore = serverConnectionCount;
try {
  const rpcNew = await getRPC(topicHex, serverPubKey, {
    timeout: 15_000,
    forceNewConnection: true,
  });
  assert(rpcNew != null, "forceNewConnection returns new RPC instance");

  // Give the server a moment to register the new connection
  await sleep(1_000);
  assert(
    serverConnectionCount > connCountBefore,
    `Server saw new connection: before=${connCountBefore}, after=${serverConnectionCount}`,
  );
} catch (err) {
  assert(false, `forceNewConnection should not throw: ${err.message}`);
}

// =====================================================================
// Test 5: Timeout with unreachable peer (and listener cleanup)
// =====================================================================
console.log("\n🧪 Test 5: Timeout with unreachable peer + listener cleanup");
const listenersBeforeTimeout = clientSwarm.listenerCount("connection");
const fakePubKey = crypto.randomBytes(32).toString("hex");

const timeoutStart = Date.now();
try {
  await getRPC(topicHex, fakePubKey, { timeout: 2_000 });
  assert(false, "Should have timed out for unreachable peer");
} catch (err) {
  const elapsed = Date.now() - timeoutStart;
  assert(
    elapsed >= 1_500 && elapsed < 5_000,
    `Timed out in ~2s (actual: ${elapsed}ms)`,
  );
  assert(
    err.message.includes("timeout") || err.message.includes("Timeout") || err.message.includes("RPC connection failed"),
    `Error mentions timeout/failure: ${err.message.substring(0, 80)}`,
  );
}

// Verify the per-request onConnection listener was cleaned up
await sleep(200);
const listenersAfterTimeout = clientSwarm.listenerCount("connection");
assert(
  listenersAfterTimeout <= listenersBeforeTimeout,
  `No listener leak after timeout: before=${listenersBeforeTimeout}, after=${listenersAfterTimeout}`,
);

// =====================================================================
// Test 6: cleanupStaleConnection removes RPC + connection
// =====================================================================
console.log("\n🧪 Test 6: cleanupStaleConnection removes cached RPC");
// First, ensure we have a connection
await getRPC(topicHex, serverPubKey, { timeout: 10_000 });
// Now clean it up
cleanupStaleConnection(serverPubKey);
// Next getRPC should create a new connection
const connsBefore6 = serverConnectionCount;
await sleep(500);
const rpcAfterCleanup = await getRPC(topicHex, serverPubKey, {
  timeout: 15_000,
});
assert(rpcAfterCleanup != null, "getRPC() succeeds after cleanupStaleConnection");
await sleep(1_000);
assert(
  serverConnectionCount > connsBefore6,
  `New connection created after cleanup: before=${connsBefore6}, after=${serverConnectionCount}`,
);

// =====================================================================
// Cleanup
// =====================================================================
console.log("\n🧹 Cleaning up...");
await serverSwarm.destroy();

console.log(
  `\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`,
);
if (failed > 0) {
  console.log("❌ SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL TESTS PASSED");
  process.exit(0);
}
