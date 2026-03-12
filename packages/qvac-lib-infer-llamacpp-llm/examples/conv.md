# Strip tool_call blocks & benchmark — session notes

## What was done

### 1. Strip internal blocks from re-sent assistant responses
Added `stripInternalBlocks()` helper to both example files. It removes `<tool_call>` and `<think>` blocks from assistant responses before they're re-sent in conversation history, preventing the model from pattern-matching on old tool calls and hallucinating removed tools.

**Files modified:**
- `examples/testToolRemoval.js` — strips `lastResponse` (4 turns) and `history` assistant entries (3 pushes in `mainInSystem()`)
- `examples/benchToolsPlacement.js` — strips `lastAssistantResponse` and `conversationHistory` entries in `runScenario()`

### 2. testToolRemoval.js — all 8 tests PASS
```
bare examples/testToolRemoval.js
```
Both `tools_at_end` and `tools_in_system` sections pass all 4 turns, including turn 4 which previously failed.

### 3. benchToolsPlacement.js — 20-turn benchmark
Updated `NUM_TURNS` to 20, added 10 more entries to `DYNAMIC_TOOLS_PER_TURN` and `CONVERSATION_TURNS_DYNAMIC`.

Run with:
```
bare examples/benchToolsPlacement.js
```

**Results (CPU-only, no GPU):**
- tools_at_end (C) is **58.2% faster** — saved 1281s across 20 turns
- All 40 turns PASS — zero stale tool leaks
- D's prompt tokens grow 285→3526, TTFT grows 13s→143s
- C stays relatively flat (15-80s wall time), cache grows 26→1991 tokens
- D gets zero cache hits after turn 1

### 4. HTML chart
`examples/benchmark_chart.html` — open in browser, has 4 bar charts (wall time, TTFT, prompt tokens, cache tokens).

## GPU / Vulkan issue
The benchmark ran on CPU only. The machine has Intel Iris Xe (Raptor Lake-P) but it was booted in **recovery mode with `nomodeset`**, which disables kernel GPU drivers.

**Fix:** Reboot normally (not recovery mode). The grub config is fine (`quiet splash`). After normal boot:
- `i915` or `xe` module should load automatically
- `/dev/dri/renderD128` should appear
- Vulkan will pick up the Intel GPU
- Benchmark should be significantly faster with bigger gap between C and D

Verify after reboot:
```
ls /dev/dri/render*
vulkaninfo --summary 2>&1 | grep deviceName
```

Then re-run the 20-turn benchmark to get GPU numbers.
