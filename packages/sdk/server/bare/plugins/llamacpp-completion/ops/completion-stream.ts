import type { RunOptions } from "@qvac/llm-llamacpp";
import type {
  CompletionParams,
  CompletionStats,
  GenerationParams,
  Tool,
  ToolCall,
} from "@/schemas";
import type { ToolCallEvent } from "@/schemas/tools";
import {
  logCacheDisabled,
  logCacheInit,
  logCacheSave,
  logCacheSaveError,
  logCacheStatus,
  logMessagesToAddon,
} from "@/server/bare/plugins/llamacpp-completion/ops/cache-logger";
import {
  customCacheExists,
  extractSystemPrompt,
  findMatchingCache,
  generateConfigHash,
  getCacheFilePath,
  getCurrentCacheInfo,
  markCacheInitialized,
  renameCacheFile,
} from "@/server/bare/ops/kv-cache-utils";
import {
  getModel,
  getModelConfig,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  cachedMessageCounts,
  clearCachedMessageCounts as clearCachedMessageCountsFromState,
  decideCachedHistorySlice,
  noteCancelRequested as noteCancelRequestedFromState,
  shouldRecordSavedCount,
  snapshotCancelCount,
} from "@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state";
import {
  checkForToolEvents,
  insertToolsIntoHistory,
  setupToolGrammar,
} from "@/server/utils/tool-integration";
import { parseToolCalls } from "@/server/utils/tool-parser";
import { buildAutoCacheSaveHistory, type CacheMessage } from "@/server/utils";
import { getServerLogger } from "@/logging";
import { AttachmentNotFoundError } from "@/utils/errors-server";
import { nowMs } from "@/profiling";
import {
  buildStreamResult,
  hasDefinedValues,
} from "@/profiling/model-execution";
import type { LlmStats } from "@/server/bare/types/addon-responses";
import fs, { promises as fsPromises } from "bare-fs";

const logger = getServerLogger();

interface ResponseWithStats {
  stats?: LlmStats;
}

interface CompletionResult {
  modelExecutionMs: number;
  stats?: CompletionStats;
  toolCalls: ToolCall[];
}

interface ProcessModelResponseResult extends CompletionResult {
  responseText: string;
  /**
   * True if the model emitted at least one non-empty text token. Used by
   * `completion()` to decide whether to record a `savedCount` for the
   * kv-cache: a turn that produced nothing (legit early EOS or cancel
   * before any decode) must not leave a `history.length + 1` entry
   * behind, because that count will make the next turn slice its history
   * to an empty payload.
   */
  producedTokens: boolean;
}

interface ChatHistory {
  role?: string;
  content?: string;
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
}

type CompletionRunOptions = Pick<RunOptions, "cacheKey" | "saveCacheToDisk"> & {
  generationParams?: GenerationParams;
};

// Re-export so existing callers keep their import surface intact.
export const clearCachedMessageCounts = clearCachedMessageCountsFromState;
export const noteCancelRequested = noteCancelRequestedFromState;

// Verify the addon actually persisted the cache file before recording its
// message count. The addon currently swallows write errors silently, so a
// missing file means the next turn must resend the full history rather than
// slicing against a stale `savedCount`.
//
// TODO: once the addon surfaces save failures (e.g. throws
// `UnableToSaveSessionFile` when `llama_state_save_file` returns false),
// drop the `access()` probe and wrap the `model.run()` call in a real
// try/catch that forwards the error to `logCacheSaveError`.
async function recordCacheSaveCount(
  cachePath: string,
  messageCount: number,
): Promise<boolean> {
  try {
    await fsPromises.access(cachePath);
    cachedMessageCounts.set(cachePath, messageCount);
    return true;
  } catch (err) {
    cachedMessageCounts.delete(cachePath);
    logCacheSaveError(cachePath, err);
    return false;
  }
}

function transformMessage(
  message:
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool,
): ChatHistory[] {
  const transformed: ChatHistory[] = [];

  // Check if it's a tool definition (has type: "function")
  if ("type" in message && message.type === "function") {
    transformed.push({
      type: "function",
      name: message.name,
      description: message.description,
      parameters: message.parameters,
    } as ChatHistory);
    return transformed;
  }

  const msg = message as {
    role: string;
    content: string;
    attachments?: { path: string }[] | undefined;
  };

  if (msg.attachments && msg.attachments.length > 0) {
    for (const attachment of msg.attachments) {
      if (!fs.existsSync(attachment.path)) {
        throw new AttachmentNotFoundError(attachment.path);
      }

      transformed.push({
        role: msg.role,
        content: attachment.path,
        type: "media",
      });
    }
  }

  transformed.push({
    role: msg.role,
    content: msg.content,
  });

  return transformed;
}

function runModel(
  model: AnyModel,
  prompt: ChatHistory[],
  opts?: CompletionRunOptions,
) {
  const run = model.run.bind(model) as (
    prompt: ChatHistory[],
    opts?: CompletionRunOptions,
  ) => ReturnType<typeof model.run>;

  return run(prompt, opts);
}

function transformMessages(
  messages: Array<
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool
  >,
): ChatHistory[] {
  const transformed: ChatHistory[] = [];
  for (const message of messages) {
    transformed.push(...transformMessage(message));
  }
  return transformed;
}

async function initSystemPromptCache(
  model: AnyModel,
  cachePathToUse: string,
  systemPromptToUse: string,
  cacheKey: string,
  tools?: Tool[],
) {
  const primeMessages: ChatHistory[] = [
    { role: "system", content: systemPromptToUse },
  ];

  let toolCount = 0;
  if (tools && tools.length > 0) {
    const transformedTools = transformMessages(tools);
    primeMessages.push(...transformedTools);
    toolCount = tools.length;
  }

  logCacheInit(cacheKey, systemPromptToUse, toolCount);
  logMessagesToAddon(primeMessages, "CACHE_INIT");

  const primeResponse = await runModel(model, primeMessages, {
    cacheKey: cachePathToUse,
    saveCacheToDisk: true,
  });

  primeResponse.once("output", () => {
    void primeResponse.cancel();
  });

  await primeResponse.await();
}

function prepareMessagesForCache(
  cachePathToUse: string,
  cacheExists: boolean,
  history: {
    role: string;
    content: string;
    attachments?: { path: string }[] | undefined;
  }[],
): ChatHistory[] {
  const savedCount = cachedMessageCounts.get(cachePathToUse) ?? 0;
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    savedCount,
    cacheExists,
    history,
  );

  if (clearStaleCount) {
    cachedMessageCounts.delete(cachePathToUse);
  }

  return transformMessages(messages);
}

type CacheRunOptions = Pick<RunOptions, "cacheKey" | "saveCacheToDisk">;

async function* processModelResponse(
  model: AnyModel,
  messagesToSend: ChatHistory[],
  tools?: Tool[],
  generationParams?: GenerationParams,
  cacheOptions?: CacheRunOptions,
): AsyncGenerator<
  { token: string; toolCallEvent?: ToolCallEvent },
  ProcessModelResponseResult,
  unknown
> {
  const runOptions: CacheRunOptions & { generationParams?: GenerationParams } =
    {
      ...(generationParams && { generationParams }),
      ...(cacheOptions?.cacheKey !== undefined && {
        cacheKey: cacheOptions.cacheKey,
      }),
      ...(cacheOptions?.saveCacheToDisk !== undefined && {
        saveCacheToDisk: cacheOptions.saveCacheToDisk,
      }),
    };
  const hasRunOptions = Object.keys(runOptions).length > 0;

  const modelStart = nowMs();
  const response = await runModel(
    model,
    messagesToSend,
    hasRunOptions ? runOptions : undefined,
  );

  let accumulatedText = "";
  let producedTokens = false;
  const emittedToolCallPositions = new Set<number>();
  let toolCallsResult: ToolCall[] = [];

  for await (const token of response.iterate()) {
    const tokenStr = token as string;
    if (tokenStr.length > 0) producedTokens = true;
    accumulatedText += tokenStr;

    yield { token: tokenStr };

    if (tools && tools.length > 0) {
      const toolEvents = checkForToolEvents(
        accumulatedText,
        tokenStr,
        tools,
        emittedToolCallPositions,
      );

      for (const toolEvent of toolEvents) {
        yield { token: "", toolCallEvent: toolEvent };
      }
    }
  }
  const modelExecutionMs = nowMs() - modelStart;

  if (cacheOptions?.saveCacheToDisk && cacheOptions.cacheKey) {
    logCacheSave(cacheOptions.cacheKey);
  }

  if (tools && tools.length > 0) {
    const { toolCalls } = parseToolCalls(accumulatedText, tools);
    toolCallsResult = toolCalls;
  }

  const responseWithStats = response as unknown as ResponseWithStats;
  const stats: CompletionStats = {
    ...(responseWithStats.stats?.TTFT !== undefined && {
      timeToFirstToken: responseWithStats.stats.TTFT,
    }),
    ...(responseWithStats.stats?.TPS !== undefined && {
      tokensPerSecond: responseWithStats.stats.TPS,
    }),
    ...(responseWithStats.stats?.CacheTokens !== undefined && {
      cacheTokens: responseWithStats.stats.CacheTokens,
    }),
    ...(responseWithStats.stats?.backendDevice !== undefined && {
      backendDevice: responseWithStats.stats.backendDevice,
    }),
  };

  return {
    ...buildStreamResult(
      modelExecutionMs,
      hasDefinedValues(stats) ? stats : undefined,
    ),
    toolCalls: toolCallsResult,
    responseText: accumulatedText,
    producedTokens,
  };
}

export async function* completion(
  params: CompletionParams & {
    tools?: Tool[];
    generationParams?: GenerationParams;
  },
): AsyncGenerator<
  { token: string; toolCallEvent?: ToolCallEvent },
  CompletionResult,
  unknown
> {
  const { history, modelId, kvCache, tools, generationParams } = params;

  const modelConfig = getModelConfig(modelId);
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true;

  let historyWithTools: Array<
    | {
        role: string;
        content: string;
        attachments?: { path: string }[] | undefined;
      }
    | Tool
  > = history;

  if (tools && tools.length > 0 && toolsEnabled) {
    historyWithTools = insertToolsIntoHistory(history, tools);
    setupToolGrammar(modelConfig as Record<string, unknown>, tools);
  }

  const transformedHistory = transformMessages(historyWithTools);
  const model = getModel(modelId);

  if (kvCache) {
    const modelConfig = getModelConfig(modelId);
    const systemPromptFromHistory = extractSystemPrompt(history);
    const configHash = generateConfigHash(systemPromptFromHistory, tools);

    const systemPromptToUse =
      systemPromptFromHistory ||
      (modelConfig as { system_prompt?: string }).system_prompt ||
      "You are a helpful assistant.";

    let cachePathToUse: string;

    if (typeof kvCache === "string") {
      cachePathToUse = await getCacheFilePath(modelId, configHash, kvCache);
      let cacheExists = await customCacheExists(modelId, configHash, kvCache);
      logCacheStatus(kvCache, cacheExists);

      if (!cacheExists) {
        await initSystemPromptCache(
          model,
          cachePathToUse,
          systemPromptToUse,
          kvCache,
          tools && toolsEnabled ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, kvCache);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const cancelCountBefore = snapshotCancelCount(modelId);
      const result = yield* processModelResponse(
        model,
        messagesToSend,
        tools,
        generationParams,
        { cacheKey: cachePathToUse, saveCacheToDisk: true },
      );
      const wasCancelled = snapshotCancelCount(modelId) > cancelCountBefore;

      // Only record the saved count when the turn actually completed and
      // produced content. Recording `history.length + 1` on a cancelled or
      // empty turn poisons `cachedMessageCounts` and causes the next turn
      // to slice its history down to an empty payload.
      if (shouldRecordSavedCount(wasCancelled, result.producedTokens)) {
        await recordCacheSaveCount(cachePathToUse, history.length + 1);
      } else {
        cachedMessageCounts.delete(cachePathToUse);
      }
      return result;
    } else {
      // Auto-generate cache key based on conversation history
      const cacheMessages: CacheMessage[] = history.map((msg) => ({
        role: msg.role,
        content: msg.content,
        attachments: msg.attachments ?? undefined,
      }));

      const existingCache = await findMatchingCache(
        modelId,
        configHash,
        cacheMessages,
      );
      const preResponseCacheInfo = await getCurrentCacheInfo(
        modelId,
        configHash,
        cacheMessages,
      );

      cachePathToUse =
        existingCache !== null
          ? existingCache.cachePath
          : preResponseCacheInfo.cachePath;

      let cacheExists = existingCache !== null;
      logCacheStatus("auto", cacheExists);

      if (!cacheExists) {
        await initSystemPromptCache(
          model,
          cachePathToUse,
          systemPromptToUse,
          "auto",
          tools && toolsEnabled ? tools : undefined,
        );
        markCacheInitialized(modelId, configHash, preResponseCacheInfo.cacheKey);
        cacheExists = true;
      }

      const messagesToSend = prepareMessagesForCache(
        cachePathToUse,
        cacheExists,
        history,
      );
      logMessagesToAddon(messagesToSend, "PROMPT_SEND");

      const cancelCountBefore = snapshotCancelCount(modelId);
      const result = yield* processModelResponse(
        model,
        messagesToSend,
        tools,
        generationParams,
        { cacheKey: cachePathToUse, saveCacheToDisk: true },
      );
      const wasCancelled = snapshotCancelCount(modelId) > cancelCountBefore;

      // TODO: support auto-cache for tool-call turns by keying off the
      // structured assistant/tool messages callers push into history,
      // not result.responseText (which is raw tool-call markup here).
      // Until then, remove any cache file the addon wrote so it doesn't
      // leak on disk (the next turn would compute a different key and
      // never reach it).
      if (result.toolCalls.length > 0) {
        logger.warn(
          `[kv-cache] Auto cache tool-call turn; removing orphaned cache to avoid disk leak. path=${cachePathToUse}`,
        );
        try {
          await fsPromises.unlink(cachePathToUse);
        } catch (unlinkError) {
          logger.warn(
            `[kv-cache] Failed to remove orphaned tool-turn cache file; disk leak likely. path=${cachePathToUse} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }
        cachedMessageCounts.delete(cachePathToUse);
        return result;
      }

      // A cancelled or zero-token turn cannot be promoted to a post-response
      // cache: the post-response key is derived from `result.responseText`,
      // which is empty/partial in those cases, and the on-disk cache the
      // addon wrote is not aligned with the current-history hash. Treat it
      // like the tool-call branch — drop the cache file and clear the count.
      if (!shouldRecordSavedCount(wasCancelled, result.producedTokens)) {
        try {
          await fsPromises.unlink(cachePathToUse);
        } catch (unlinkError) {
          logger.warn(
            `[kv-cache] Failed to remove cache file after cancelled or empty turn; disk leak possible. path=${cachePathToUse} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }
        cachedMessageCounts.delete(cachePathToUse);
        return result;
      }

      const savedHistory = buildAutoCacheSaveHistory(
        cacheMessages,
        result.responseText,
      );
      const postResponseCacheInfo = await getCurrentCacheInfo(
        modelId,
        configHash,
        savedHistory,
      );

      if (
        !(await renameCacheFile(
          cachePathToUse,
          postResponseCacheInfo.cachePath,
        ))
      ) {
        logger.warn(
          `[kv-cache] Auto cache rename failed; removing stale cache to avoid disk leak. from=${cachePathToUse} to=${postResponseCacheInfo.cachePath}`,
        );
        try {
          await fsPromises.unlink(cachePathToUse);
        } catch (unlinkError) {
          logger.warn(
            `[kv-cache] Failed to remove stale cache file; disk leak likely. path=${cachePathToUse} error=${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }
        cachedMessageCounts.delete(cachePathToUse);
        return result;
      }

      cachedMessageCounts.delete(cachePathToUse);
      await recordCacheSaveCount(
        postResponseCacheInfo.cachePath,
        savedHistory.length,
      );

      return result;
    }
  } else {
    logCacheDisabled();
    logMessagesToAddon(transformedHistory, "NO_CACHE");
    return yield* processModelResponse(
      model,
      transformedHistory,
      tools,
      generationParams,
    );
  }
}
