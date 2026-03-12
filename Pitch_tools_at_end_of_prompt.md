

| Approved by Technical Lead | WIP |
| :---- | :---- |
| Approved by Technical Architect | **WIP** |
| \[optional\] Review from Subash | **WIP** |

# Tools at End of Prompt for KV-Cache Optimization

# Pitch

## Problem

In the current architecture, tool definitions are placed at the beginning of the prompt (typically inside or right after the system prompt), following default chat templates. This means that whenever tools change between conversation turns — e.g. when an agent selects different tools for a new user query — the KV-cache is invalidated from the point of the tool definitions onward, forcing a full recomputation of the entire conversation history that follows.

On mobile devices with limited compute, this is especially costly. The conversation history can grow long, and reprocessing it on every turn with changed tools eliminates the benefit of prompt caching. Since we control the KV-cache in our setup, we have an opportunity to optimize: if tools are placed at the **end** of the prompt (after the conversation history, right before generation), we can cache everything up to the tools and only recompute the new query + new tools on each turn. This dramatically reduces per-turn computation.

**Current layout (tools at the beginning):**
```
<system><tools-1><user-q-1><model-response-1>|<user-q-2><tools-2>  <-- cache invalidated from tools onward
```

**Desired layout (tools at the end):**
```
<system><user-q-1>|<model-response-1><user-q-2><tools-2>  <-- response + new query + tools recomputed as prefill
```

Each token in the KV-cache depends on all previous tokens, so tokens can only be removed/changed at the end without invalidating the rest. By placing tools last, we can strip old tools *and* the model's response from the cache tail, then recompute them together with the new query and new tools in a single prefill pass. Since all response tokens are already known, prefill is fully parallel and significantly cheaper than autoregressive generation. The cached system prompt and conversation history up to the last user query is preserved and never recomputed.

## Solution

The solution has two parts:

### 1. Modified Chat Templates

Model chat templates (Jinja2-based) control where tool definitions appear in the final prompt. We need to modify these templates to extract tool definitions from their default position (usually inside the system prompt) and place them at the end of the prompt, just before the generation token.

POC results (PR [#232](https://github.com/tetherto/qvac/pull/232)):
- **Qwen3 family**: Successfully tested with modified chat template. Tools placed at the end are picked up correctly — the model calls tools properly with no degradation in quality. Tested on a heavy scenario (1 prompt, 20+ tool calls for code review).
- **LFM (Liquid AI)**: Requires tools in the system prompt — fundamentally different architecture. Would likely need fine-tuning/retraining to support tools at a different position. Out of scope for now.

### 2. KV-Cache Strategy Update

The current caching implementation expects an exact prefix match: it caches the full prompt and on the next turn checks if the new prompt starts with the cached prefix. With tools at the end, the conversation turns are inserted *before* the tools, which breaks this assumption.

We need a new cache strategy:
- After each model response, **trim both the tool tokens and the response tokens from the end of the KV-cache** (we know the exact token counts since we control the prompt construction).
- On the next turn, **recompute the previous response tokens + new user query tokens + new tool tokens as a single prefill pass**. Since all these tokens are already known (the response already happened, the new query and tools are provided), this is a fully parallel operation — no autoregressive generation needed.
- The system prompt + conversation history up to the last user query remains cached and is never recomputed.

This is possible because we have full control over the KV-cache in our inference stack (llama.cpp / custom server). The key insight is that removing tokens from the end of the cache does not invalidate any preceding tokens, and prefilling known tokens is significantly cheaper than recomputing the full conversation from scratch.

This approach also avoids any correctness concerns: since the response KV entries are always recomputed alongside the current tool definitions, there is no stale state in the cache. Each turn's response KV is consistent with the tools that were in context when it was generated.

## Risks

1. **Model-specific behavior**: Not all models support tools at arbitrary positions. The chat template is model-defined and some models (like LFM) embed tool handling into training. We must test each target model individually. Mitigation: maintain a registry of supported models and fall back to default template for unsupported ones.

2. **Prefill overhead**: Recomputing response tokens as prefill on each turn adds some per-turn cost compared to keeping them cached. However, prefill is fully parallel and in practice much cheaper than recomputing the full conversation history from scratch, especially for conversations with large payloads (e.g., image tokens in VLM scenarios). Mitigation: benchmark prefill cost vs. full-recompute cost across different conversation lengths to quantify the savings.

3. **Chat template maintenance**: Modified chat templates need to be kept in sync when models are updated. Mitigation: automate template modification or contribute upstream patches.

4. **Inference server compatibility**: The current MLX-based server and llama.cpp handle caching differently. The cache trimming strategy needs to work across both. Mitigation: implement the cache strategy at our abstraction layer, not at the server level.

## Out of scope

- Fine-tuning or retraining models that don't natively support tools at the end of the prompt (e.g., LFM from Liquid AI).
- Orchestrator/multi-agent architecture for tool management (separate pitch).
- Embedding tool capabilities via fine-tuning (separate pitch).

## Nice to haves

- Benchmark suite comparing inference latency with tools-at-beginning vs. tools-at-end across different conversation lengths.
- Automatic chat template modification tool that takes a model's default template and produces the tools-at-end variant.
- Support for partial tool caching (keeping common/unchanged tools in cache, only recomputing added/removed ones).

## Estimate

* \[1 dev day\] Implement modified chat templates for Qwen3 family models and validate tool calling accuracy.
* \[2 dev days\] Implement KV-cache trimming strategy — trim tool tokens from cache tail and append new query + tools.
* \[1 dev day\] Integrate cache strategy with llama.cpp inference backend.
* \[1 dev day\] Quality validation — run multi-turn benchmarks comparing full-recompute vs. cache-trimmed responses; measure latency improvements.
* \[0.5 dev days\] Add model compatibility registry and fallback logic for unsupported models.
* \[0.5 dev days\] Documentation and testing.

**Total: ~6 dev days**
