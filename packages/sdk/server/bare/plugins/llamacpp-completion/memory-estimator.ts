import { LLM_CONFIG_DEFAULTS } from "@/schemas/llamacpp-config";

const BYTES_PER_MB = 1024 * 1024;
const OVERHEAD_BYTES = 512 * BYTES_PER_MB;
const MEMORY_USAGE_THRESHOLD = 0.80;
const MAX_CTX_SIZE = 131072;

interface KvBytesPerTokenBracket {
  maxFileSize: number;
  bytesPerToken: number;
}

const KV_BRACKETS: KvBytesPerTokenBracket[] = [
  { maxFileSize: 2 * 1024 * BYTES_PER_MB, bytesPerToken: 256 },
  { maxFileSize: 5 * 1024 * BYTES_PER_MB, bytesPerToken: 512 },
  { maxFileSize: 15 * 1024 * BYTES_PER_MB, bytesPerToken: 1024 },
  { maxFileSize: Infinity, bytesPerToken: 2048 },
];

export function estimateKvBytesPerToken(modelFileSize: number): number {
  for (const bracket of KV_BRACKETS) {
    if (modelFileSize < bracket.maxFileSize) return bracket.bytesPerToken;
  }
  return KV_BRACKETS[KV_BRACKETS.length - 1]!.bytesPerToken;
}

export function estimateMemoryRequired(
  modelFileSize: number,
  ctxSize: number,
): number {
  const kvBytesPerToken = estimateKvBytesPerToken(modelFileSize);
  const kvCacheBytes = ctxSize * kvBytesPerToken;
  return modelFileSize + kvCacheBytes + OVERHEAD_BYTES;
}

export function computeSafeCtxSize(
  availableMemory: number,
  modelFileSize: number,
): number {
  const kvBytesPerToken = estimateKvBytesPerToken(modelFileSize);
  const usableBudget = availableMemory * MEMORY_USAGE_THRESHOLD;
  const budgetForKv = usableBudget - modelFileSize - OVERHEAD_BYTES;

  if (budgetForKv <= 0) return LLM_CONFIG_DEFAULTS.ctx_size;

  const safeCtx = Math.floor(budgetForKv / kvBytesPerToken);
  return Math.min(Math.max(safeCtx, LLM_CONFIG_DEFAULTS.ctx_size), MAX_CTX_SIZE);
}

export interface MemoryValidationResult {
  safe: boolean;
  estimatedBytes: number;
  availableBytes: number;
  requestedCtxSize: number;
  suggestedCtxSize: number;
}

export function validateMemoryForModel(
  modelFileSize: number,
  ctxSize: number,
  availableMemory: number,
): MemoryValidationResult {
  const estimatedBytes = estimateMemoryRequired(modelFileSize, ctxSize);
  const threshold = availableMemory * MEMORY_USAGE_THRESHOLD;
  const safe = availableMemory <= 0 || estimatedBytes <= threshold;
  const suggestedCtxSize = safe
    ? ctxSize
    : computeSafeCtxSize(availableMemory, modelFileSize);

  return {
    safe,
    estimatedBytes,
    availableBytes: availableMemory,
    requestedCtxSize: ctxSize,
    suggestedCtxSize,
  };
}
