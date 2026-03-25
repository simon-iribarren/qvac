import type { z } from "zod";
import type { Request, Response, ProfilingRequestMeta } from "@/schemas";

export type DelegationOptions = {
  profilingMeta?: ProfilingRequestMeta;
};

// --- Procedure types ---
//
// Handler signatures use `any` for request + extra params because:
// 1. Handlers have specific request subtypes (contravariant with the wide Request union)
// 2. Extra params vary by mode (progress callbacks, delegation options)
// Type safety is enforced at registration time via the reply()/stream() helpers.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ReplyProcedure = {
  mode: "reply";
  input: z.ZodSchema;
  handler: (request: any, ...extra: any[]) => Promise<Response> | Response;
  delegatedHandler?: (
    request: any,
    ...extra: any[]
  ) => Promise<Response> | Response;
  isDelegated?: (request: Request) => boolean;
  supportsProgress?: boolean | ((request: Request) => boolean);
};

export type StreamProcedure = {
  mode: "stream";
  input: z.ZodSchema;
  handler: (request: any, ...extra: any[]) => AsyncGenerator<Response>;
  delegatedHandler?: (
    request: any,
    ...extra: any[]
  ) => AsyncGenerator<Response>;
  isDelegated?: (request: Request) => boolean;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type Procedure = ReplyProcedure | StreamProcedure;

// --- Type-safe definition helpers ---
//
// These verify the handler's primary contract (request → response) at the call
// site via generic inference, then widen to `Procedure` for storage. The `any`
// in extra params is intentional — it accommodates progress callbacks and
// delegation options without requiring handler signature changes.

export function reply<
  TInput extends Request,
  TOutput extends Response,
>(config: {
  input: z.ZodSchema<TInput>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (request: TInput, ...extra: any[]) => Promise<TOutput> | TOutput;
  // Delegated handlers may accept a narrower request subtype (e.g.
  // LoadModelSrcRequest vs full LoadModelRequest), so input is unconstrained.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegatedHandler?: (...args: any[]) => Promise<TOutput> | TOutput;
  isDelegated?: (request: Request) => boolean;
  supportsProgress?: boolean | ((request: Request) => boolean);
}): ReplyProcedure {
  return { mode: "reply", ...config } as ReplyProcedure;
}

export function stream<
  TInput extends Request,
  TOutput extends Response,
>(config: {
  input: z.ZodSchema<TInput>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (request: TInput, ...extra: any[]) => AsyncGenerator<TOutput>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegatedHandler?: (...args: any[]) => AsyncGenerator<TOutput>;
  isDelegated?: (request: Request) => boolean;
}): StreamProcedure {
  return { mode: "stream", ...config } as StreamProcedure;
}

export type Router = Record<string, Procedure>;
