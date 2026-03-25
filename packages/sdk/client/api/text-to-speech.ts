import {
  ttsResponseSchema,
  type TtsClientParams,
  type RPCOptions,
} from "@/schemas";
import { rpc } from "@/client/rpc/caller";

export function textToSpeech(
  params: TtsClientParams,
  options?: RPCOptions,
): {
  bufferStream: AsyncGenerator<number>;
  buffer: Promise<number[]>;
  done: Promise<boolean>;
} {
  const input = {
    modelId: params.modelId,
    inputType: params.inputType,
    text: params.text,
    stream: params.stream,
  };

  let doneResolver: (value: boolean) => void = () => {};
  const donePromise = new Promise<boolean>((resolve) => {
    doneResolver = resolve;
  });

  if (params.stream) {
    const bufferStream = (async function* () {
      for await (const response of rpc.textToSpeech.stream(input, options)) {
        const streamResponse = ttsResponseSchema.parse(response);
        if (streamResponse.buffer.length > 0) {
          yield* streamResponse.buffer;
        }
        if (streamResponse.done) {
          doneResolver(true);
        }
      }
    })();

    return {
      bufferStream,
      buffer: Promise.resolve([]),
      done: donePromise,
    };
  }

  const bufferStream = (async function* () {
    // empty generator for non-streaming mode
  })();

  const bufferPromise = (async () => {
    let buffer: number[] = [];
    for await (const response of rpc.textToSpeech.stream(input, options)) {
      const streamResponse = ttsResponseSchema.parse(response);
      buffer = buffer.concat(streamResponse.buffer);
      if (streamResponse.done) {
        doneResolver(true);
      }
    }
    return buffer;
  })();

  return {
    bufferStream,
    buffer: bufferPromise,
    done: donePromise,
  };
}
