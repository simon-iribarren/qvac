import { ModelType } from "./model-types";
import {
  qvacModelRegistryEngineSchema,
  type QvacModelRegistryEngine,
  type QvacModelRegistryEntryAddon,
} from "./registry";

// Canonical engine → addon mapping (exhaustive).
// TypeScript enforces that every QvacModelRegistryEngine has an entry.
export const ENGINE_TO_ADDON: Record<
  QvacModelRegistryEngine,
  QvacModelRegistryEntryAddon
> = {
  [ModelType.llamacppCompletion]: "llm",
  [ModelType.whispercppTranscription]: "whisper",
  [ModelType.llamacppEmbedding]: "embeddings",
  [ModelType.nmtcppTranslation]: "nmt",
  [ModelType.onnxTts]: "tts",
  [ModelType.onnxOcr]: "ocr",
  "onnx-vad": "vad",
};

// Legacy engine names → canonical engine.
// Used for backward compatibility with old registry data that uses @qvac/* package names.
const LEGACY_ENGINE_TO_CANONICAL: Record<string, QvacModelRegistryEngine> = {
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

// Resolves any engine string (legacy or canonical) to a validated canonical engine.
// Returns null if the engine is not recognized.
export function resolveCanonicalEngine(
  engine: string,
): QvacModelRegistryEngine | null {
  const direct = qvacModelRegistryEngineSchema.safeParse(engine);
  if (direct.success) return direct.data;

  const canonical = LEGACY_ENGINE_TO_CANONICAL[engine];
  if (canonical) return canonical;

  return null;
}

// Returns the addon type for a validated canonical engine.
export function getAddonFromEngine(
  engine: QvacModelRegistryEngine,
): QvacModelRegistryEntryAddon {
  return ENGINE_TO_ADDON[engine];
}
