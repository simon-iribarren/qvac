import { ModelType } from "./model-types";
import type { QvacModelRegistryEntryAddon } from "./registry";

// Canonical engine names (from ModelType) → addon alias
// This is the primary mapping. Registry engine field should use these values.
const CANONICAL_ENGINE_TO_ADDON: Record<string, QvacModelRegistryEntryAddon> = {
  [ModelType.llamacppCompletion]: "llm",
  [ModelType.whispercppTranscription]: "whisper",
  [ModelType.llamacppEmbedding]: "embeddings",
  [ModelType.nmtcppTranslation]: "nmt",
  [ModelType.onnxTts]: "tts",
  [ModelType.onnxOcr]: "ocr",
  "onnx-vad": "vad",
};

// Legacy engine names → canonical engine name
// Used for backward compatibility with old registry data that uses @qvac/* package names
const LEGACY_ENGINE_TO_CANONICAL: Record<string, string> = {
  "@qvac/llm-llamacpp": ModelType.llamacppCompletion,
  "@qvac/transcription-whispercpp": ModelType.whispercppTranscription,
  "@qvac/embed-llamacpp": ModelType.llamacppEmbedding,
  "@qvac/translation-nmtcpp": ModelType.nmtcppTranslation,
  "@qvac/translation-llamacpp": ModelType.nmtcppTranslation,
  "@qvac/vad-silero": "onnx-vad",
  "@qvac/tts-onnx": ModelType.onnxTts,
  "@qvac/tts": ModelType.onnxTts,
  "@qvac/ocr-onnx": ModelType.onnxOcr,
  // Tag-style names (used by some older registry entries)
  generation: ModelType.llamacppCompletion,
  transcription: ModelType.whispercppTranscription,
  embedding: ModelType.llamacppEmbedding,
  translation: ModelType.nmtcppTranslation,
  vad: "onnx-vad",
  tts: ModelType.onnxTts,
  ocr: ModelType.onnxOcr,
};

// Combined lookup: canonical + legacy → addon
export const ENGINE_TO_ADDON: Record<string, QvacModelRegistryEntryAddon> = {
  ...CANONICAL_ENGINE_TO_ADDON,
  ...Object.fromEntries(
    Object.entries(LEGACY_ENGINE_TO_CANONICAL).map(([legacy, canonical]) => [
      legacy,
      CANONICAL_ENGINE_TO_ADDON[canonical] ?? "other",
    ]),
  ),
};

export function resolveCanonicalEngine(engine: string): string {
  if (engine in CANONICAL_ENGINE_TO_ADDON) return engine;
  return LEGACY_ENGINE_TO_CANONICAL[engine] ?? engine;
}

export function getAddonFromEngine(
  engine: string | undefined,
): QvacModelRegistryEntryAddon {
  if (!engine) return "other";

  // Direct lookup (canonical or legacy)
  if (ENGINE_TO_ADDON[engine]) return ENGINE_TO_ADDON[engine];

  // Case-insensitive fallback
  const engineLower = engine.toLowerCase();
  if (ENGINE_TO_ADDON[engineLower]) return ENGINE_TO_ADDON[engineLower];

  // Substring match fallback
  for (const [key, value] of Object.entries(ENGINE_TO_ADDON)) {
    if (engine.includes(key) || key.includes(engine)) return value;
  }

  return "other";
}
