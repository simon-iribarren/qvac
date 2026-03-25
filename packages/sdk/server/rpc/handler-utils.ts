import {
  type QvacConfig,
  type Request,
  type Response,
  type RuntimeContext,
  type ProfilingRequestMeta,
  PROFILING_KEY,
} from "@/schemas";
import type RPC from "bare-rpc";
import {
  sendErrorResponse,
  sendStreamErrorResponse,
} from "@/server/error-handlers";
import { setSDKConfig } from "@/server/bare/registry/config-registry";
import { setRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import { type ServerProfiler } from "./profiling";
import type { Procedure, ReplyProcedure, StreamProcedure } from "./procedure";

function getProfilingMetaFromRequest(
  request: Request,
): ProfilingRequestMeta | undefined {
  if (PROFILING_KEY in request) {
    return (request as Record<string, unknown>)[
      PROFILING_KEY
    ] as ProfilingRequestMeta;
  }
  return undefined;
}

async function executeReplyHandler(
  req: RPC.IncomingRequest,
  request: Request,
  procedure: ReplyProcedure,
  profiler: ServerProfiler,
  isDelegated: boolean,
) {
  profiler.startHandler();
  try {
    const handler = isDelegated
      ? procedure.delegatedHandler!
      : procedure.handler;

    let response: Response;
    if (isDelegated) {
      const profilingMeta = getProfilingMetaFromRequest(request);
      response = await handler(
        request,
        profilingMeta ? { profilingMeta } : undefined,
      );
    } else {
      response = await handler(request);
    }
    profiler.endHandler();
    req.reply(profiler.serialize(response, true), "utf-8");
  } catch (error) {
    profiler.endHandler();
    sendErrorResponse(req, error, profiler);
  }
}

async function executeStreamHandler(
  req: RPC.IncomingRequest,
  request: Request,
  procedure: StreamProcedure,
  profiler: ServerProfiler,
  isDelegated: boolean,
) {
  const responseStream = req.createResponseStream();
  profiler.startHandler();

  try {
    const handler = isDelegated
      ? procedure.delegatedHandler!
      : procedure.handler;

    let generator: AsyncGenerator<Response>;
    if (isDelegated) {
      const profilingMeta = getProfilingMetaFromRequest(request);
      generator = handler(
        request,
        profilingMeta ? { profilingMeta } : undefined,
      );
    } else {
      generator = handler(request);
    }
    for await (const response of generator) {
      responseStream.write(profiler.serialize(response, false) + "\n", "utf-8");
    }
    profiler.endHandler();
    const trailer = profiler.serialize();
    if (trailer) {
      responseStream.write(trailer + "\n", "utf-8");
    }

    responseStream.end();
  } catch (error) {
    profiler.endHandler();
    sendStreamErrorResponse(responseStream, error, profiler);
  }
}

async function executeProgressHandler(
  req: RPC.IncomingRequest,
  request: Request,
  procedure: ReplyProcedure,
  profiler: ServerProfiler,
  isDelegated: boolean,
) {
  const responseStream = req.createResponseStream();
  profiler.startHandler();

  const progressCallback = (update: Response) => {
    responseStream.write(profiler.serialize(update, false) + "\n", "utf-8");
  };

  try {
    const handler = isDelegated
      ? procedure.delegatedHandler!
      : procedure.handler;

    let response: Response;
    if (isDelegated) {
      const profilingMeta = getProfilingMetaFromRequest(request);
      const options: {
        progressCallback: typeof progressCallback;
        profilingMeta?: ProfilingRequestMeta;
      } = { progressCallback };
      if (profilingMeta) {
        options.profilingMeta = profilingMeta;
      }
      response = await handler(request, options);
    } else {
      response = await handler(request, progressCallback);
    }
    profiler.endHandler();
    responseStream.write(profiler.serialize(response, true) + "\n", "utf-8");
    responseStream.end();
  } catch (error) {
    profiler.endHandler();
    sendStreamErrorResponse(responseStream, error, profiler);
  }
}

export async function executeHandler(
  req: RPC.IncomingRequest,
  request: Request,
  procedure: Procedure,
  profiler: ServerProfiler,
) {
  const isDelegated = !!(
    procedure.delegatedHandler && procedure.isDelegated?.(request)
  );

  if (procedure.mode === "stream") {
    await executeStreamHandler(req, request, procedure, profiler, isDelegated);
  } else {
    const wantsProgress =
      "withProgress" in request &&
      request.withProgress &&
      (typeof procedure.supportsProgress === "function"
        ? procedure.supportsProgress(request)
        : procedure.supportsProgress);

    if (wantsProgress) {
      await executeProgressHandler(
        req,
        request,
        procedure,
        profiler,
        isDelegated,
      );
    } else {
      await executeReplyHandler(req, request, procedure, profiler, isDelegated);
    }
  }
}

// Internal config initialization (bypasses schema)
type InitConfigMessage = {
  type: "__init_config";
  config: QvacConfig;
  runtimeContext?: RuntimeContext;
};

export function isInitConfigMessage(data: unknown): data is InitConfigMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "__init_config"
  );
}

export function handleInitConfig(
  req: RPC.IncomingRequest,
  data: InitConfigMessage,
) {
  try {
    if (data.config) {
      setSDKConfig(data.config);
    }
    if (data.runtimeContext) {
      setRuntimeContext(data.runtimeContext);
    }
    req.reply(JSON.stringify({ success: true }), "utf-8");
  } catch (error) {
    req.reply(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      "utf-8",
    );
  }
}
