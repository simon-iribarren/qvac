import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const downloadParallel: TestDefinition = {
  testId: "download-parallel",
  params: {},
  expectation: { validation: "type", expectedType: "array" },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 180000,
    expectedCount: 2,
  },
  skip: {
    reason: "Download test not suitable for mobile (OOM/bandwidth)",
    platforms: ["mobile-ios", "mobile-android"],
  },
};

export const downloadCancelIsolation: TestDefinition = {
  testId: "download-cancel-isolation",
  params: { cancelAtPercent: 1 },
  expectation: { validation: "custom" },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
  skip: {
    reason: "Download test not suitable for mobile (OOM/bandwidth)",
    platforms: ["mobile-ios", "mobile-android"],
  },
};

export const downloadTests = [downloadParallel, downloadCancelIsolation];
