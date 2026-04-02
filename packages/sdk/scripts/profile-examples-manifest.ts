export type ProfileTier = "smoke" | "standard" | "heavy";

export type ExampleProfileManifestEntry =
  | {
      relativePath: string;
      mode: "harness";
      tier: ProfileTier;
      args?: string[];
    }
  | {
      relativePath: string;
      mode: "skip";
      reason: string;
    };

export const EXAMPLE_PROFILE_MANIFEST: ExampleProfileManifestEntry[] = [
  { relativePath: "cache-management.ts", mode: "harness", tier: "standard" },
  {
    relativePath: "config-reload.ts",
    mode: "harness",
    tier: "standard",
    args: ["examples/audio/sample-16khz.wav"],
  },
  { relativePath: "default-config-usage.ts", mode: "harness", tier: "smoke" },
  {
    relativePath: "delegated-inference/consumer-profiled.ts",
    mode: "skip",
    reason: "Requires topic and provider public key argv",
  },
  {
    relativePath: "delegated-inference/consumer.ts",
    mode: "skip",
    reason: "Requires topic, provider key, and optional consumer seed argv",
  },
  {
    relativePath: "delegated-inference/provider.ts",
    mode: "skip",
    reason: "Long-running service (stdin resume + SIGINT)",
  },
  {
    relativePath: "download-with-blind-relays.ts",
    mode: "skip",
    reason: "Placeholder relay keys in config; needs real Hyperswarm relay keys",
  },
  {
    relativePath: "download-with-cancel.ts",
    mode: "harness",
    tier: "standard",
  },
  { relativePath: "embed-p2p.ts", mode: "harness", tier: "heavy" },
  { relativePath: "kv-cache-cleanup.ts", mode: "harness", tier: "standard" },
  {
    relativePath: "kv-cache-custom-key.ts",
    mode: "harness",
    tier: "standard",
  },
  { relativePath: "kv-cache-example.ts", mode: "harness", tier: "standard" },
  {
    relativePath: "llamacpp-filesystem.ts",
    mode: "skip",
    reason: "Requires local GGUF path argv",
  },
  {
    relativePath: "llamacpp-http.ts",
    mode: "harness",
    tier: "heavy",
  },
  {
    relativePath: "llamacpp-multimodal.ts",
    mode: "harness",
    tier: "heavy",
    args: ["examples/image/basic_test.bmp"],
  },
  {
    relativePath: "llamacpp-native-tools.ts",
    mode: "harness",
    tier: "standard",
  },
  { relativePath: "llamacpp-p2p.ts", mode: "harness", tier: "heavy" },
  { relativePath: "llamacpp-sharded.ts", mode: "harness", tier: "standard" },
  {
    relativePath: "logging-file-transport.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "logging-streaming.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "mcp-websearch.ts",
    mode: "skip",
    reason: "Optional @modelcontextprotocol/sdk peer dependency",
  },
  { relativePath: "multi-model-demo.ts", mode: "harness", tier: "heavy" },
  {
    relativePath: "ocr-fasttext.ts",
    mode: "harness",
    tier: "standard",
  },
  { relativePath: "parallel-download.ts", mode: "harness", tier: "heavy" },
  {
    relativePath: "plugins.ts",
    mode: "skip",
    reason: "Spawns npx @qvac/cli bundle (side effects, not a pure SDK import)",
  },
  { relativePath: "profiling/basic.ts", mode: "harness", tier: "smoke" },
  { relativePath: "profiling/per-call.ts", mode: "harness", tier: "smoke" },
  { relativePath: "quickstart.ts", mode: "harness", tier: "smoke" },
  {
    relativePath: "rag/rag-chromadb.ts",
    mode: "skip",
    reason: "Requires ChromaDB server on localhost:8000",
  },
  {
    relativePath: "rag/rag-hyperdb/cancellation.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "rag/rag-hyperdb/ingest.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "rag/rag-hyperdb/pipeline.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "rag/rag-hyperdb/workspaces.ts",
    mode: "harness",
    tier: "standard",
  },
  { relativePath: "rag/rag-lancedb.ts", mode: "harness", tier: "standard" },
  { relativePath: "rag/rag-sqlite.ts", mode: "harness", tier: "standard" },
  { relativePath: "registry-query.ts", mode: "harness", tier: "smoke" },
  {
    relativePath: "seed-p2p.ts",
    mode: "skip",
    reason: "Long-running P2P seeder (stdin resume + SIGINT)",
  },
  {
    relativePath: "transcription/parakeet-ctc-filesystem.ts",
    mode: "harness",
    tier: "standard",
    args: ["examples/audio/sample-16khz.wav"],
  },
  {
    relativePath: "transcription/parakeet-microphone-record.ts",
    mode: "skip",
    reason: "Microphone capture + interactive",
  },
  {
    relativePath: "transcription/parakeet-sortformer.ts",
    mode: "harness",
    tier: "heavy",
  },
  {
    relativePath: "transcription/parakeet-tdt-filesystem.ts",
    mode: "harness",
    tier: "standard",
    args: ["examples/audio/sample-16khz.wav"],
  },
  {
    relativePath: "transcription/whispercpp-filesystem.ts",
    mode: "harness",
    tier: "standard",
    args: ["examples/audio/sample-16khz.wav"],
  },
  {
    relativePath: "transcription/whispercpp-microphone-record.ts",
    mode: "skip",
    reason: "Microphone capture + interactive",
  },
  {
    relativePath: "transcription/whispercpp-prompt.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-bergamot-batch.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-bergamot-pivot.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-bergamot.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-indic.ts",
    mode: "skip",
    reason: "Known broken on nmtcpp 0.1.6 (IndicTrans model loading fails)",
  },
  {
    relativePath: "translation/translation-llm-afriquegemma.ts",
    mode: "harness",
    tier: "heavy",
  },
  {
    relativePath: "translation/translation-llm-context.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-llm.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-opus.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "translation/translation-stream.ts",
    mode: "harness",
    tier: "standard",
  },
  {
    relativePath: "tts/chatterbox.ts",
    mode: "harness",
    tier: "heavy",
    args: ["examples/audio/sample-16khz.wav"],
  },
  { relativePath: "tts/supertonic.ts", mode: "harness", tier: "heavy" },
];

const TIER_RANK: Record<ProfileTier, number> = {
  smoke: 0,
  standard: 1,
  heavy: 2,
};

export function shouldRunHarness(
  entry: ExampleProfileManifestEntry,
  tierCeiling: ProfileTier,
): entry is ExampleProfileManifestEntry & { mode: "harness" } {
  if (entry.mode !== "harness") {
    return false;
  }
  return TIER_RANK[entry.tier] <= TIER_RANK[tierCeiling];
}
