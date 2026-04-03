import type { TestDefinition } from "@tetherto/qvac-test-suite";

// --- Provider Lifecycle ---

export const delegatedProviderStart: TestDefinition = {
  testId: "delegated-provider-start",
  params: {},
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 15000,
  },
};

export const delegatedProviderStop: TestDefinition = {
  testId: "delegated-provider-stop",
  params: {},
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 15000,
  },
};

export const delegatedProviderFirewall: TestDefinition = {
  testId: "delegated-provider-firewall",
  params: {
    firewall: { mode: "allow", publicKeys: [] },
  },
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 15000,
  },
};

// --- Delegated Model Loading ---

export const delegatedLoadModel: TestDefinition = {
  testId: "delegated-load-model",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 90000,
  },
};

export const delegatedLoadModelTimeout: TestDefinition = {
  testId: "delegated-load-model-timeout",
  params: { timeout: 5000 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 90000,
  },
};

export const delegatedLoadModelHealthCheck: TestDefinition = {
  testId: "delegated-load-model-health-check",
  params: { healthCheckTimeout: 2000 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 90000,
  },
};

export const delegatedLoadModelFallbackLocal: TestDefinition = {
  testId: "delegated-load-model-fallback-local",
  params: { fallbackToLocal: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 90000,
  },
};

export const delegatedLoadModelForceNewConnection: TestDefinition = {
  testId: "delegated-load-model-force-new-connection",
  params: { forceNewConnection: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 90000,
  },
};

// --- Delegated Completion ---

export const delegatedCompletionBasic: TestDefinition = {
  testId: "delegated-completion-basic",
  params: {
    history: [
      { role: "user", content: "What is 2+2? Answer with only the number." },
    ],
    stream: false,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
};

export const delegatedCompletionStreaming: TestDefinition = {
  testId: "delegated-completion-streaming",
  params: {
    history: [
      { role: "user", content: "What is 3+3? Answer with only the number." },
    ],
    stream: true,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
};

// --- Delegated Heartbeat ---

export const delegatedHeartbeatProvider: TestDefinition = {
  testId: "delegated-heartbeat-provider",
  params: {},
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 15000,
  },
};

// --- Provider Stability ---

export const delegatedProviderRestart: TestDefinition = {
  testId: "delegated-provider-restart",
  params: {},
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 20000,
  },
};

// --- Delegated Cancel Download ---

export const delegatedCancelDownload: TestDefinition = {
  testId: "delegated-cancel-download",
  params: {},
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 30000,
  },
};

// --- Error Handling ---

export const delegatedConnectionFailure: TestDefinition = {
  testId: "delegated-connection-failure",
  params: { timeout: 3000 },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 15000,
  },
};

export const delegatedInvalidTopic: TestDefinition = {
  testId: "delegated-invalid-topic",
  params: {},
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const delegatedProviderNotFound: TestDefinition = {
  testId: "delegated-provider-not-found",
  params: { timeout: 3000 },
  expectation: { validation: "throws-error", errorContains: "" },
  metadata: {
    category: "delegated-inference",
    dependency: "none",
    estimatedDurationMs: 15000,
  },
};

export const delegatedInferenceTests = [
  // Provider lifecycle
  delegatedProviderStart,
  delegatedProviderStop,
  delegatedProviderFirewall,

  // Delegated model loading
  delegatedLoadModel,
  delegatedLoadModelTimeout,
  delegatedLoadModelHealthCheck,
  delegatedLoadModelFallbackLocal,
  delegatedLoadModelForceNewConnection,

  // Delegated completion
  delegatedCompletionBasic,
  delegatedCompletionStreaming,

  // Delegated heartbeat
  delegatedHeartbeatProvider,

  // Provider stability
  delegatedProviderRestart,

  // Delegated cancel download
  delegatedCancelDownload,

  // Error handling
  delegatedConnectionFailure,
  delegatedInvalidTopic,
  delegatedProviderNotFound,
];
