# SDK KV Cache System

## What

Reference for the KV Cache (Key-Value Cache) system that caches transformer attention context during LLM inference, enabling conversation context reuse across completion requests.

## When to Use

- Implementing or debugging KV cache for LLM completion
- Working with string-keyed or auto-generated cache sessions
- Debugging cache misses, context overflow, or sliding window behavior
- Understanding cache persistence, deletion, or MCP compatibility
- Modifying completion-stream.ts or kv-cache-utils.ts

## References

| File | Content |
|------|---------|
| `references/kv-cache-system.md` | Full KV cache reference: usage, cache flow, persistence, context overflow, debug logging, common issues |
