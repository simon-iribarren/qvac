import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  completion,
  loadModel,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const providerScript = join(__dirname, "provider.ts");
const topic =
  "66646f696865726f6569686a726530776a66646f696865726f6569686a726530";

let provider: ChildProcess | undefined;

function killProvider(): void {
  if (provider && !provider.killed) {
    provider.kill("SIGTERM");
  }
}

try {
  console.log("🔧 Spawning provider as child process...");
  provider = spawn("bun", ["run", providerScript, topic], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  provider.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const publicKey = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Provider startup timeout (30 s)")),
      30_000,
    );
    provider!.stdout!.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      output += str;
      process.stdout.write(str);
      const match = output.match(
        /Provider Public Key \(unique\): ([a-f0-9]+)/i,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]!);
      }
    });
    provider!.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    provider!.on("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Provider exited with code ${String(code)}`));
    });
  });

  console.log(`\n📡 Provider ready — public key: ${publicKey}`);
  console.log(`📡 Topic: ${topic}\n`);

  console.log("→ Loading delegated model...");
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    delegate: {
      topic,
      providerPublicKey: publicKey,
      timeout: 30_000,
    },
    onProgress: (progress) => {
      console.log(`  Download: ${progress.percentage.toFixed(1)}%`);
    },
  });

  console.log(`✅ Model loaded: ${modelId}\n`);

  console.log("→ Running delegated completion...");
  const response = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in exactly 5 words." }],
    stream: true,
  });

  process.stdout.write("  Response: ");
  for await (const token of response.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await response.stats;
  console.log(`\n📊 Stats: ${JSON.stringify(stats)}`);

  void close();
} finally {
  killProvider();
}

process.exit(0);
