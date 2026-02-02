'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isMobile = platform === 'ios' || platform === 'android'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

// Prompt designed to elicit long output so generation hits the context limit
const STORY_PROMPT = [
  { role: 'system', content: 'You are a storyteller. Write extremely long, detailed stories with many characters.' },
  { role: 'user', content: 'Tell a very long story about a brave knight on many adventures.' }
]

function createTestLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function setupModel (t, overrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  function releaseLogger () {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '128',
    n_predict: '512',
    temp: '0.9',
    top_p: '0.95',
    seed: '42',
    verbosity: '3'
  }

  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: createTestLogger(),
    opts: { stats: true }
  }, { ...baseConfig, ...overrides })

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    await loader.close().catch(() => {})
    throw err
  }

  t.teardown(async () => {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
    releaseLogger()
  })

  return { model, dirPath, logs: specLogger.logs }
}

async function runAndCollect (model, prompt) {
  const response = await model.run(prompt)
  const chunks = []
  response.onUpdate(data => { chunks.push(data) })
  await response.await()
  return { text: chunks.join(''), stats: response.stats }
}

function countDiscardLogs (logs) {
  return logs.filter(entry =>
    entry.includes('discarded') && entry.includes('tokens after the first message')
  ).length
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: With n_discarded > 0, generation slides past the context limit
// instead of throwing a context overflow error.
//
// Note: llama.cpp may round up ctx_size (e.g. 128 → 256 actual n_ctx).
// With ~42 prompt tokens, n_predict must exceed available generation space
// to trigger sliding. n_predict=512 ensures overflow regardless of rounding.
// ──────────────────────────────────────────────────────────────────────────────
test('Sliding context allows generation beyond context limit', {
  timeout: 900_000,
  skip: isMobile
}, async t => {
  const { model, logs } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '512',
    n_discarded: '32'
  })

  const { text } = await runAndCollect(model, STORY_PROMPT)

  t.ok(text.length > 0, `produced output (length=${text.length})`)

  const discardCount = countDiscardLogs(logs)
  t.ok(discardCount > 0, `sliding context activated (${discardCount} discard events)`)
})

// ──────────────────────────────────────────────────────────────────────────────
// Test 2: With n_discarded=0 (disabled), generation that exceeds ctx_size
// triggers a context overflow error from the C++ layer.
// ──────────────────────────────────────────────────────────────────────────────
test('Generation fails with context overflow when sliding context is disabled', {
  timeout: 900_000,
  skip: isMobile
}, async t => {
  const { model, logs } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '512',
    n_discarded: '0'
  })

  try {
    await runAndCollect(model, STORY_PROMPT)
    t.fail('expected context overflow error but generation completed without error')
  } catch (err) {
    const msg = err?.message || String(err)
    t.ok(
      /context|overflow/i.test(msg),
      `context overflow error surfaced: "${msg.slice(0, 120)}"`
    )
  }

  t.is(countDiscardLogs(logs), 0, 'no discard events when n_discarded=0')
})

// ──────────────────────────────────────────────────────────────────────────────
// Test 3: With a small n_discarded relative to n_predict, sliding activates
// many times during a single generation. Each activation discards 16 tokens,
// so with n_predict=1024, sliding must activate at least twice.
// ──────────────────────────────────────────────────────────────────────────────
test('Sliding context activates multiple times during long generation', {
  timeout: 900_000,
  skip: isMobile
}, async t => {
  const { model, logs } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '1024',
    n_discarded: '16'
  })

  const { text } = await runAndCollect(model, STORY_PROMPT)

  t.ok(text.length > 0, 'generated output despite multiple context slides')

  const discardCount = countDiscardLogs(logs)
  t.ok(discardCount >= 2, `multiple sliding activations (${discardCount} discard events)`)
})

// ──────────────────────────────────────────────────────────────────────────────
// Test 4: When n_discarded exceeds the available context space (ctx_size -
// firstMsgTokens), the C++ layer clamps it to (ctx_size - firstMsgTokens - 1)
// so that at least one token remains after discarding. The inference must
// succeed without crashing.
// ──────────────────────────────────────────────────────────────────────────────
test('Large n_discarded is clamped to fit available context space', {
  timeout: 900_000,
  skip: isMobile
}, async t => {
  const { model, logs } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '512',
    n_discarded: '99999'
  })

  const { text } = await runAndCollect(model, STORY_PROMPT)

  t.ok(text.length > 0, 'inference succeeded with oversized n_discarded (auto-clamped)')

  // Clamped value still allows sliding when generation exceeds available space
  const discardCount = countDiscardLogs(logs)
  t.ok(discardCount > 0, `sliding activated after clamping (${discardCount} discard events)`)
})

// ──────────────────────────────────────────────────────────────────────────────
// Test 5: The n_discarded setting persists across resetState calls. Running
// two consecutive inferences on the same model instance (without session
// caching, so state resets between runs) should trigger sliding in both runs.
// ──────────────────────────────────────────────────────────────────────────────
test('Sliding context persists across consecutive inference runs', {
  timeout: 900_000,
  skip: isMobile
}, async t => {
  const { model, logs } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '512',
    n_discarded: '32'
  })

  // First inference
  const first = await runAndCollect(model, STORY_PROMPT)
  t.ok(first.text.length > 0, 'first inference produced output')

  const discardCountAfterFirst = countDiscardLogs(logs)
  t.ok(discardCountAfterFirst > 0, `first run triggered sliding (${discardCountAfterFirst} discards)`)

  // Second inference on same instance — n_discarded survives resetState
  const second = await runAndCollect(model, STORY_PROMPT)
  t.ok(second.text.length > 0, 'second inference produced output')

  const discardCountAfterSecond = countDiscardLogs(logs)
  t.ok(
    discardCountAfterSecond > discardCountAfterFirst,
    `second run also triggered sliding (total ${discardCountAfterSecond} discards)`
  )
})

// ──────────────────────────────────────────────────────────────────────────────
// Test 6: Edge case with n_discarded=1 (minimal sliding). Each time the
// context fills, only 1 token is discarded. This exercises the sliding path
// under maximum repetition with minimum freed space per activation.
// ──────────────────────────────────────────────────────────────────────────────
test('Sliding context works with minimal n_discarded of 1', {
  timeout: 900_000,
  skip: isMobile
}, async t => {
  const { model, logs } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '512',
    n_discarded: '1'
  })

  const { text } = await runAndCollect(model, STORY_PROMPT)

  t.ok(text.length > 0, 'inference succeeded with n_discarded=1')

  // With n_discarded=1, the sliding path fires once per generated token
  // after the context fills, resulting in many more discard events
  const discardCount = countDiscardLogs(logs)
  t.ok(discardCount > 0, `minimal sliding activated (${discardCount} discard events)`)
})
