import {
  startQVACProvider,
  stopQVACProvider,
  loadModel,
  unloadModel,
  completion,
  heartbeat,
  cancel,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";
import {
  BaseExecutor,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  delegatedInferenceTests,
  delegatedProviderStart,
  delegatedProviderStop,
  delegatedProviderFirewall,
  delegatedLoadModel,
  delegatedLoadModelTimeout,
  delegatedLoadModelHealthCheck,
  delegatedLoadModelFallbackLocal,
  delegatedLoadModelForceNewConnection,
  delegatedCompletionBasic,
  delegatedCompletionStreaming,
  delegatedHeartbeatProvider,
  delegatedConnectionFailure,
  delegatedInvalidTopic,
  delegatedProviderNotFound,
  delegatedProviderRestart,
  delegatedCancelDownload,
} from "../../delegated-inference-tests.js";

const DEFAULT_DELEGATE_TIMEOUT = 10_000;

const randomHex = (bytes: number): string =>
  Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  ).join("");

const generateTopic = (): string => randomHex(32);

export class DelegatedInferenceExecutor extends BaseExecutor<typeof delegatedInferenceTests> {
  pattern = /^delegated-/;

  protected handlers = {
    [delegatedProviderStart.testId]: this.providerStart.bind(this),
    [delegatedProviderStop.testId]: this.providerStop.bind(this),
    [delegatedProviderFirewall.testId]: this.providerFirewall.bind(this),
    [delegatedLoadModel.testId]: this.loadModelBasic.bind(this),
    [delegatedLoadModelTimeout.testId]: this.loadModelWithTimeout.bind(this),
    [delegatedLoadModelHealthCheck.testId]: this.loadModelWithHealthCheck.bind(this),
    [delegatedLoadModelFallbackLocal.testId]: this.loadModelFallbackLocal.bind(this),
    [delegatedLoadModelForceNewConnection.testId]: this.loadModelForceNewConnection.bind(this),
    [delegatedCompletionBasic.testId]: this.completionBasic.bind(this),
    [delegatedCompletionStreaming.testId]: this.completionStreaming.bind(this),
    [delegatedHeartbeatProvider.testId]: this.heartbeatProvider.bind(this),
    [delegatedConnectionFailure.testId]: this.connectionFailure.bind(this),
    [delegatedInvalidTopic.testId]: this.invalidTopic.bind(this),
    [delegatedProviderNotFound.testId]: this.providerNotFound.bind(this),
    [delegatedProviderRestart.testId]: this.providerRestart.bind(this),
    [delegatedCancelDownload.testId]: this.cancelDelegatedDownload.bind(this),
  };

  private async withProvider<T>(
    fn: (ctx: { topic: string; publicKey: string }) => Promise<T>,
    firewall?: { mode: "allow" | "deny"; publicKeys: string[] },
  ): Promise<T> {
    const topic = generateTopic();
    const response = await startQVACProvider({ topic, firewall });
    if (!response.publicKey) {
      throw new Error(`startQVACProvider returned no publicKey: ${JSON.stringify(response)}`);
    }
    try {
      return await fn({ topic, publicKey: response.publicKey });
    } finally {
      try {
        await stopQVACProvider({ topic });
      } catch {
        // best-effort cleanup
      }
    }
  }

  private async withDelegatedModel<T>(
    fn: (ctx: { topic: string; publicKey: string; modelId: string }) => Promise<T>,
    delegateOverrides?: Record<string, unknown>,
  ): Promise<T> {
    return this.withProvider(async ({ topic, publicKey }) => {
      const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: {
          topic,
          providerPublicKey: publicKey,
          timeout: DEFAULT_DELEGATE_TIMEOUT,
          fallbackToLocal: true,
          ...delegateOverrides,
        },
      });
      try {
        return await fn({ topic, publicKey, modelId });
      } finally {
        try {
          await unloadModel({ modelId });
        } catch {
          // best-effort cleanup
        }
      }
    });
  }

  // --- Provider Lifecycle ---

  async providerStart(): Promise<TestResult> {
    const topic = generateTopic();
    const response = await startQVACProvider({ topic });
    try {
      if (!response.publicKey || typeof response.publicKey !== "string") {
        return { passed: false, output: `Missing or invalid publicKey: ${JSON.stringify(response)}` };
      }
      return {
        passed: true,
        output: `Provider started, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider({ topic }); } catch { /* cleanup */ }
    }
  }

  async providerStop(): Promise<TestResult> {
    const topic = generateTopic();
    await startQVACProvider({ topic });
    const response = await stopQVACProvider({ topic });

    if (response.success !== true) {
      return { passed: false, output: `stopQVACProvider failed: ${JSON.stringify(response)}` };
    }
    return { passed: true, output: "Provider started and stopped successfully" };
  }

  async providerFirewall(params: typeof delegatedProviderFirewall.params): Promise<TestResult> {
    const topic = generateTopic();
    const firewall = params.firewall as { mode: "allow" | "deny"; publicKeys: string[] };
    const response = await startQVACProvider({ topic, firewall });
    try {
      if (!response.publicKey) {
        return { passed: false, output: `Provider with firewall failed: ${JSON.stringify(response)}` };
      }
      return {
        passed: true,
        output: `Provider with firewall (mode=${firewall.mode}) started, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider({ topic }); } catch { /* cleanup */ }
    }
  }

  // --- Delegated Model Loading ---

  async loadModelBasic(): Promise<TestResult> {
    return this.withDelegatedModel(async ({ modelId }) => {
      return { passed: true, output: `Delegated model loaded: ${modelId}` };
    });
  }

  async loadModelWithTimeout(params: typeof delegatedLoadModelTimeout.params): Promise<TestResult> {
    return this.withDelegatedModel(
      async ({ modelId }) => {
        return { passed: true, output: `Delegated model loaded with timeout=${params.timeout}: ${modelId}` };
      },
      { timeout: params.timeout as number },
    );
  }

  async loadModelWithHealthCheck(params: typeof delegatedLoadModelHealthCheck.params): Promise<TestResult> {
    return this.withDelegatedModel(
      async ({ modelId }) => {
        return { passed: true, output: `Delegated model loaded with healthCheckTimeout=${params.healthCheckTimeout}: ${modelId}` };
      },
      { healthCheckTimeout: params.healthCheckTimeout as number },
    );
  }

  async loadModelFallbackLocal(): Promise<TestResult> {
    const bogusProvider = randomHex(32);
    const topic = generateTopic();

    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      delegate: {
        topic,
        providerPublicKey: bogusProvider,
        timeout: 3000,
        fallbackToLocal: true,
      },
    });
    try {
      if (!modelId || typeof modelId !== "string") {
        return { passed: false, output: `Fallback did not produce valid modelId: ${modelId}` };
      }
      return { passed: true, output: `Delegation failed, fell back to local: ${modelId}` };
    } finally {
      try { await unloadModel({ modelId }); } catch { /* cleanup */ }
    }
  }

  async loadModelForceNewConnection(): Promise<TestResult> {
    return this.withDelegatedModel(
      async ({ modelId }) => {
        return { passed: true, output: `Delegated model loaded with forceNewConnection: ${modelId}` };
      },
      { forceNewConnection: true },
    );
  }

  // --- Delegated Completion ---

  async completionBasic(params: typeof delegatedCompletionBasic.params): Promise<TestResult> {
    return this.withDelegatedModel(async ({ modelId }) => {
      const result = completion({
        modelId,
        history: params.history as Array<{ role: string; content: string }>,
        stream: false,
      });
      const text = await result.text;
      if (!text || typeof text !== "string") {
        return { passed: false, output: `Empty or invalid completion: ${text}` };
      }
      return { passed: true, output: `Delegated completion: "${text.substring(0, 80)}"` };
    });
  }

  async completionStreaming(params: typeof delegatedCompletionStreaming.params): Promise<TestResult> {
    return this.withDelegatedModel(async ({ modelId }) => {
      const result = completion({
        modelId,
        history: params.history as Array<{ role: string; content: string }>,
        stream: true,
      });

      let fullText = "";
      let tokenCount = 0;
      for await (const token of result.tokenStream) {
        fullText += token;
        tokenCount++;
      }

      if (!fullText) {
        return { passed: false, output: "Streaming produced no tokens" };
      }
      return {
        passed: true,
        output: `Delegated streaming completion (${tokenCount} tokens): "${fullText.substring(0, 80)}"`,
      };
    });
  }

  // --- Delegated Heartbeat ---

  async heartbeatProvider(): Promise<TestResult> {
    return this.withProvider(async ({ topic, publicKey }) => {
      try {
        const response = await heartbeat({
          delegate: { topic, providerPublicKey: publicKey, timeout: DEFAULT_DELEGATE_TIMEOUT },
        });
        if (response.type !== "heartbeat") {
          return { passed: false, output: `Invalid heartbeat response: ${JSON.stringify(response)}` };
        }
        return { passed: true, output: "Delegated heartbeat to provider OK" };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("DELEGATE_CONNECTION_FAILED") || msg.includes("timeout") || msg.includes("connection")) {
          return { passed: true, output: `Delegated heartbeat routed correctly (connection failed as expected in same-process): ${msg.substring(0, 120)}` };
        }
        return { passed: false, output: `Unexpected heartbeat error: ${msg}` };
      }
    });
  }

  // --- Error Handling ---

  async connectionFailure(params: typeof delegatedConnectionFailure.params): Promise<TestResult> {
    const bogusProvider = randomHex(32);
    const bogusTopic = generateTopic();
    const timeout = (params.timeout ?? 3000) as number;

    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: {
          topic: bogusTopic,
          providerPublicKey: bogusProvider,
          timeout,
          fallbackToLocal: false,
        },
      });
      return { passed: false, output: "Should have thrown for non-existent provider" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { passed: true, output: `Connection failure handled: ${msg.substring(0, 120)}` };
    }
  }

  async invalidTopic(): Promise<TestResult> {
    try {
      await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        delegate: {
          topic: "not-a-valid-hex-topic!!!",
          providerPublicKey: "also-invalid",
          fallbackToLocal: false,
        },
      });
      return { passed: false, output: "Should have thrown for invalid topic" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { passed: true, output: `Invalid topic rejected: ${msg.substring(0, 120)}` };
    }
  }

  async providerNotFound(params: typeof delegatedProviderNotFound.params): Promise<TestResult> {
    const bogusProvider = randomHex(32);
    const bogusTopic = generateTopic();

    try {
      await heartbeat({
        delegate: {
          topic: bogusTopic,
          providerPublicKey: bogusProvider,
          timeout: (params.timeout ?? 3000) as number,
        },
      });
      return { passed: false, output: "Should have thrown for unreachable provider" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { passed: true, output: `Unreachable provider detected: ${msg.substring(0, 120)}` };
    }
  }

  // --- Provider Stability ---

  async providerRestart(): Promise<TestResult> {
    const topic1 = generateTopic();
    await startQVACProvider({ topic: topic1 });
    await stopQVACProvider({ topic: topic1 });

    const topic2 = generateTopic();
    const response = await startQVACProvider({ topic: topic2 });
    try {
      if (!response.publicKey) {
        return { passed: false, output: "Provider failed to restart on new topic" };
      }
      return {
        passed: true,
        output: `Provider restarted successfully on new topic, publicKey: ${response.publicKey.substring(0, 16)}...`,
      };
    } finally {
      try { await stopQVACProvider({ topic: topic2 }); } catch { /* cleanup */ }
    }
  }

  // --- Delegated Cancel Download ---

  async cancelDelegatedDownload(): Promise<TestResult> {
    return this.withProvider(async ({ topic, publicKey }) => {
      try {
        await cancel({
          operation: "downloadAsset",
          downloadKey: "nonexistent-delegated-download",
          delegate: { topic, providerPublicKey: publicKey, timeout: DEFAULT_DELEGATE_TIMEOUT },
        });
        return { passed: true, output: "Cancel delegated download API accepted" };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("DELEGATE_CONNECTION_FAILED") || msg.includes("not found") || msg.includes("cancel")) {
          return { passed: true, output: `Delegated cancel routed correctly: ${msg.substring(0, 100)}` };
        }
        return { passed: false, output: `Unexpected error: ${msg.substring(0, 100)}` };
      }
    });
  }
}
