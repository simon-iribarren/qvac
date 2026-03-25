import {
  translateResponseSchema,
  normalizeModelType,
  ModelType,
  type TranslateClientParams,
  type TranslationStats,
  type RPCOptions,
} from "@/schemas";
import { rpc } from "@/client/rpc/caller";
import { detectOne } from "@qvac/langdetect-text-cld2";
import { TranslationFailedError } from "@/utils/errors-client";

async function detectSourceLanguage(
  text: string,
  providedLanguage: string | undefined,
  isLlm: boolean,
): Promise<string | undefined> {
  if (!isLlm) return undefined;
  if (providedLanguage) return providedLanguage;

  const detected = await detectOne(text);
  if (detected.code === "und" || detected.language === "Undetermined") {
    throw new TranslationFailedError(
      "Could not detect the source language. Please specify the 'from' parameter explicitly.",
    );
  }
  return detected.language;
}

/**
 * Translates text from one language to another using a specified translation model.
 * Supports both NMT (Neural Machine Translation) and LLM models.
 *
 * @param params - Translation configuration object
 * @param params.modelId - The identifier of the translation model to use
 * @param params.text - The input text to translate
 * @param params.from - Source language code (optional)
 * @param params.to - Target language code
 * @param params.stream - Whether to stream tokens (true) or return complete response (false). Defaults to true.
 * @returns Object with tokenStream generator and text/stats properties
 * @throws {QvacErrorBase} When translation fails with an error message or when language detection fails
 * @example
 * ```typescript
 * // Streaming mode (default)
 * const result = translate({
 *   modelId: "modelId",
 *   text: "Hello world",
 *   from: "en",
 *   to: "es"
 *   modelType: "llm",
 * });
 *
 * for await (const token of result.tokenStream) {
 *   console.log(token);
 * }
 *
 * // Non-streaming mode
 * const response = translate({
 *   modelId: "modelId",
 *   text: "Hello world",
 *   from: "en",
 *   to: "es"
 *   modelType: "llm",
 *   stream: false,
 * });
 *
 * console.log(await response.text);
 * ```
 */
export function translate(
  params: TranslateClientParams,
  options?: RPCOptions,
): {
  tokenStream: AsyncGenerator<string>;
  stats: Promise<TranslationStats | undefined>;
  text: Promise<string>;
} {
  const canonicalModelType = normalizeModelType(params.modelType);
  const isLlm = canonicalModelType === ModelType.llamacppCompletion;

  let stats: TranslationStats | undefined;
  let statsResolver: (value: TranslationStats | undefined) => void = () => {};
  const statsPromise = new Promise<TranslationStats | undefined>((resolve) => {
    statsResolver = resolve;
  });

  async function buildInput() {
    const sourceLanguage = await detectSourceLanguage(
      params.text as string,
      isLlm ? (params as { from?: string }).from : undefined,
      isLlm,
    );
    return {
      ...params,
      ...(isLlm && { from: sourceLanguage }),
    };
  }

  if (params.stream) {
    const tokenStream = (async function* () {
      const input = await buildInput();

      for await (const response of rpc.translate.stream(input, options)) {
        const streamResponse = translateResponseSchema.parse(response);
        if (!streamResponse.done) {
          yield streamResponse.token;
        } else {
          stats = streamResponse.stats;
          statsResolver(stats);
        }
      }
    })();

    return {
      tokenStream,
      text: Promise.resolve(""),
      stats: statsPromise,
    };
  }

  const tokenStream = (async function* () {
    // empty generator for non-streaming mode
  })();

  const textPromise = (async () => {
    const input = await buildInput();
    let buffer = "";

    for await (const response of rpc.translate.stream(input, options)) {
      const streamResponse = translateResponseSchema.parse(response);
      buffer += streamResponse.token;
      if (streamResponse.done) {
        stats = streamResponse.stats;
        statsResolver(stats);
      }
    }

    return buffer;
  })();

  return {
    tokenStream,
    text: textPromise,
    stats: statsPromise,
  };
}
