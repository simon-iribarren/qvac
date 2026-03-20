# CLI Serve — Architecture & Reference

Technical reference for the `qvac serve openai` command in `@qvac/cli`.

## Purpose

Exposes an OpenAI-compatible HTTP REST API that translates requests into `@qvac/sdk` calls. Any tool compatible with the OpenAI API can point at `http://localhost:11434/v1/` as a drop-in replacement.

## Package Location

```
repos/qvac/packages/cli/src/serve/
├── index.ts                    # HTTP server, middleware, startup logging
├── config.ts                   # Config parsing, model constant resolution, ENDPOINT_CATEGORY map
├── http.ts                     # HTTP helpers: sendJson, sendError, sendSSE, initSSE, endSSE, sendText
├── multipart.ts                # multipart/form-data parser (25 MB limit, single file)
├── core/
│   ├── sdk.ts                  # SDK wrapper: getSDK() (lazy load + version check), sdkCompletion, sdkEmbed, sdkTranscribe
│   ├── model-registry.ts       # In-memory model state tracking (alias → state/sdkModelId)
│   └── lifecycle.ts            # Model preload/load/unload/shutdown via SDK
├── adapters/
│   ├── types.ts                # APIAdapter interface, RouteContext
│   └── openai/
│       ├── index.ts            # Route dispatch: maps HTTP method+path to handler
│       ├── translate.ts        # Format translation: OpenAI ↔ SDK (messages, tools, generation params)
│       └── routes/
│           ├── models.ts       # GET/DELETE /v1/models[/:id]
│           ├── chat.ts         # POST /v1/chat/completions (blocking + SSE streaming)
│           ├── embeddings.ts   # POST /v1/embeddings (single + batch)
│           └── transcriptions.ts  # POST /v1/audio/transcriptions (multipart/form-data)
└── bundle-sdk/
    └── constants.ts            # Plugin export names for each addon type
```

## Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/v1/models` | `models.ts` | List all loaded models |
| GET | `/v1/models/:id` | `models.ts` | Get specific model info |
| DELETE | `/v1/models/:id` | `models.ts` | Unload a model |
| POST | `/v1/chat/completions` | `chat.ts` | Chat completions (blocking + SSE) |
| POST | `/v1/embeddings` | `embeddings.ts` | Text embeddings (single + batch) |
| POST | `/v1/audio/transcriptions` | `transcriptions.ts` | Audio transcription (multipart) |

## Config: `qvac.config.json`

Models are declared under `serve.models`. Each key is an **alias** (the `model` value in HTTP requests).

### Entry formats

**Constant model entry** (most common):
```json
{
  "my-llm": {
    "model": "QWEN3_600M_INST_Q4",
    "default": true,
    "preload": true,
    "config": { "ctx_size": 8192, "tools": true }
  }
}
```

**Shorthand** (just the constant name):
```json
{ "my-llm": "QWEN3_600M_INST_Q4" }
```

**Explicit entry** (no SDK constant needed):
```json
{
  "my-llm": {
    "src": "https://...",
    "type": "llamacpp-completion",
    "preload": false,
    "config": {}
  }
}
```

### Field behavior

| Field | Default (constant) | Default (explicit) | Notes |
|-------|-------------------|--------------------|-------|
| `preload` | `true` | `false` | Constant entries preload by default |
| `default` | `false` | `false` | Only used for internal categorization/logging. Does NOT auto-select on missing `model` field |
| `config` | `{}` | `{}` | Passed to SDK `loadModel()`. Keys vary by addon type |

### Important config keys

- `ctx_size`: Context window size for LLMs (default: 1024 in llama.cpp). Increase for large prompts (tool calling with many tools needs ~8192+).
- `tools`: Boolean. **Must be `true`** for tool/function calling to work. Without it, the model responds with text instead of tool calls (silent failure, no error).
- `language`, `strategy`, `audio_format`: Whisper config keys set at load time (not per-request).

## Model Type to Endpoint Category Mapping

Defined in `config.ts` `ENDPOINT_CATEGORY`:

| SDK addon type | Endpoint category | HTTP endpoint |
|----------------|-------------------|---------------|
| `llm`, `llamacpp-completion` | `chat` | `/v1/chat/completions` |
| `embeddings`, `embedding`, `llamacpp-embedding` | `embedding` | `/v1/embeddings` |
| `whisper`, `whispercpp-transcription`, `parakeet`, `parakeet-transcription` | `transcription` | `/v1/audio/transcriptions` |
| `nmt`, `nmtcpp-translation` | `translation` | No endpoint yet |
| `tts`, `onnx-tts` | `speech` | No endpoint yet |
| `ocr`, `onnx-ocr` | `ocr` | No endpoint yet |

## Generation Parameters (Chat Completions)

Translated in `translate.ts` `extractGenerationParams()`:

| OpenAI param | SDK param | Type |
|-------------|-----------|------|
| `temperature` | `temp` | `number` |
| `max_tokens` | `predict` | `number` |
| `max_completion_tokens` | `predict` | `number` (alias, overrides `max_tokens`) |
| `top_p` | `top_p` | `number` |
| `seed` | `seed` | `number` |
| `frequency_penalty` | `frequency_penalty` | `number` |
| `presence_penalty` | `presence_penalty` | `number` |

Params are forwarded via `sdkCompletion({ generationParams })` which passes them through the SDK's completion RPC.

### Unsupported params (accepted, logged as warning)

`n`, `logprobs`, `response_format`, `stop`, `top_logprobs`, `logit_bias`, `parallel_tool_calls`, `stream_options`

## Tool Calling Flow

1. Client sends `tools` array in OpenAI format
2. `translate.ts` `openaiToolsToSdk()` converts to SDK format
3. `normalizeToolParameters()` handles composite JSON Schema types (e.g., `["string", "null"]` to `"string"`) for compatibility with clients like Deep Agents
4. SDK runs completion with tools
5. Response: `sdkToolCallsToOpenai()` (blocking) or `sdkToolCallsToOpenaiDeltas()` (streaming) converts back

**Requires**: `"tools": true` in model config.

## Transcription Flow

1. Client sends `multipart/form-data` with `file` (audio) and `model` fields
2. `multipart.ts` parses the form data (max 25 MB)
3. `sdk.ts` `sdkTranscribe()` writes the audio buffer to a temp file (prevents f32 sample errors from raw buffer), passes file path to SDK
4. Temp file cleaned up in `finally` block
5. Response: `{ "text": "..." }` (JSON) or plain text

### Transcription per-request params

| Param | Behavior |
|-------|----------|
| `model` | Required. Must match a transcription model alias in config |
| `file` | Required. Audio file |
| `response_format` | `json` (default) or `text`. `srt`/`vtt`/`verbose_json` return 400 |
| `prompt` | Forwarded to SDK as `prompt` |
| `language` | **Not per-request**. Warns user, must be set in model config |
| `temperature` | Ignored with warning |

## SDK Wrapper (`core/sdk.ts`)

`getSDK()` lazily imports `@qvac/sdk`, validates minimum version compatibility, and caches the module. This avoids hard dependency — the CLI can be installed without the SDK (for bundling use cases).

Key functions:
- `sdkCompletion({ modelId, history, stream, tools?, generationParams? })` — Chat completion
- `sdkEmbed({ modelId, text })` — Embeddings
- `sdkTranscribe({ modelId, audioChunk, fileName, prompt? })` — Transcription (writes temp file)

## Request Lifecycle

```
HTTP request
  → CORS handling (if --cors)
  → API key check (if --api-key)
  → Adapter routing (openai/index.ts matches method+path)
    → Route handler (validates body, resolves model alias, checks model state)
      → SDK call (via core/sdk.ts)
      → Format response (OpenAI JSON or SSE)
  → 404 if no adapter matches
```

## Error Handling

- All handlers catch errors and call `sendError()`
- If headers already sent (streaming), `sendError` writes an SSE error event and closes the stream
- SSE output is sanitized (HTML entities escaped as unicode) to prevent reflected XSS

## CLI Flags

```
qvac serve openai [options]
  -c, --config <path>    Config file path (default: auto-detect qvac.config.*)
  -p, --port <number>    Port (default: 11434)
  -H, --host <address>   Host (default: 127.0.0.1)
  --model <alias>        Model alias to preload (repeatable)
  --api-key <key>        Require Bearer token auth
  --cors                 Enable CORS headers
  -v, --verbose          Verbose logging
```

## Verified Compatible Tools

| Tool | Tested features |
|------|----------------|
| Continue.dev | Streaming chat completions, model listing |
| LangChain | Chat completions, embeddings, tool calling, model listing |
| Open Interpreter | Streaming chat with tool calls |
| Deep Agents CLI | Streaming chat with tool calls (required `normalizeToolParameters` fix and `ctx_size` increase) |

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Tool calls return text instead of function call | Missing `"tools": true` in model config | Add `"config": { "tools": true }` |
| Context overflow with many tools | Default `ctx_size` is 1024, too small | Increase `ctx_size` to 8192+ |
| `max_tokens` not respected | Stale SDK dist or missing `generationParams` forwarding | Rebuild SDK, ensure `completion-stream.ts` forwards params |
| `Permission denied` on `qvac` binary | Execute permission lost after rebuild | `chmod +x node_modules/.bin/qvac` |
| `f32 sample` error in transcription | Raw buffer passed to SDK instead of file path | Fixed in v0.2.0 — temp file approach |
| `Invalid tool schema` with composite types | Client sends `["string", "null"]` as type | Fixed in v0.2.0 — `normalizeToolParameters` |

## Release History

| Version | Key changes |
|---------|-------------|
| 0.1.2 | Initial release |
| 0.2.0 | OpenAI server (Part I), TypeScript migration, transcription endpoint, generation params, tool schema normalization |
| 0.2.2 | Workflow fix for release |
