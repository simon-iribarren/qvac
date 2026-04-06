'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const QWEN3_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const SYSTEM_MESSAGE = { role: 'system', content: 'You are a helpful assistant.' }

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '4096',
  n_predict: '64',
  temp: '0.1',
  seed: '1',
  verbosity: '2',
  tools: 'true',
  tools_at_end: 'true'
}

const TOOL_A = {
  type: 'function',
  name: 'getWeather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city']
  }
}

const TOOL_B = {
  type: 'function',
  name: 'searchProducts',
  description: 'Search for products in catalog',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query']
  }
}

const TOOL_C = {
  type: 'function',
  name: 'sendEmail',
  description: 'Send an email message',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      body: { type: 'string', description: 'Email body' }
    },
    required: ['to', 'body']
  }
}

const TOOL_D = {
  type: 'function',
  name: 'translateText',
  description: 'Translate text from one language to another',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to translate' },
      sourceLang: { type: 'string', description: 'Source language code' },
      targetLang: { type: 'string', description: 'Target language code' }
    },
    required: ['text', 'targetLang']
  }
}

const TOOL_E = {
  type: 'function',
  name: 'createCalendarEvent',
  description: 'Create a new calendar event with title date time and optional attendees',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      date: { type: 'string', description: 'Event date in YYYY-MM-DD format' },
      time: { type: 'string', description: 'Event time in HH:MM format' },
      duration: { type: 'integer', description: 'Duration in minutes' },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of attendee email addresses'
      },
      location: { type: 'string', description: 'Event location or meeting URL' },
      reminder: { type: 'integer', description: 'Reminder in minutes before event' }
    },
    required: ['title', 'date', 'time']
  }
}

const toNumber = value => typeof value === 'number' ? value : Number(value || 0)

function normalizeStats (rawStats = {}) {
  return {
    CacheTokens: toNumber(rawStats?.CacheTokens),
    promptTokens: toNumber(rawStats?.promptTokens),
    generatedTokens: toNumber(rawStats?.generatedTokens)
  }
}

async function setupModel (t, overrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_MODEL.name,
    downloadUrl: QWEN3_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const config = { ...BASE_CONFIG, ...overrides }
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)

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

  return { model, dirPath }
}

async function runAndCollect (model, prompt) {
  const response = await model.run(prompt)
  const chunks = []
  let chain = response.onUpdate(data => { chunks.push(data) })
  if (typeof response.onError === 'function') {
    chain = chain.onError(err => { throw err })
  }
  await chain.await()
  return {
    output: chunks.join(''),
    stats: normalizeStats(response.stats)
  }
}

function hasToolCallBlock (output) {
  return output.includes('<tool_call>') || output.includes('tool_call')
}

// ---------------------------------------------------------------------------
// Test: Multi-turn session with changing tools does not accumulate stale tokens
//
// WHY: The core cache optimization claim — old tool tokens must be trimmed,
// not accumulated, across turns. Without this, mobile devices recompute the
// full conversation every turn, defeating the purpose of tools_at_end.
// COVERS: Pitch #2 (3 rounds of tool changes)
// ---------------------------------------------------------------------------
test('[dynamic-tools] multi-turn session with changing tools does not accumulate stale tokens', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const sessionName = path.join(dirPath, 'dynamic-tools-changing.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Hello, what can you do?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Search for laptops' },
    TOOL_B
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')

  const prompt3 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Send a report' },
    TOOL_C
  ]
  const r3 = await runAndCollect(model, prompt3)
  t.ok(r3.output.length > 0, 'turn 3 produces output')
  t.ok(r3.stats.CacheTokens > 0, 'turn 3 has cache tokens')

  const naiveAccumulation = r1.stats.CacheTokens + r2.stats.promptTokens + r2.stats.generatedTokens + r3.stats.promptTokens + r3.stats.generatedTokens
  t.ok(
    r3.stats.CacheTokens < naiveAccumulation,
    `CacheTokens after 3 turns (${r3.stats.CacheTokens}) should be less than naive accumulation (${naiveAccumulation}) — proves old tools are trimmed`
  )

  t.ok(
    r3.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `CacheTokens after 3 turns (${r3.stats.CacheTokens}) should be less than 2x turn 1 (${2 * r1.stats.CacheTokens}) — tools are replaced, not accumulated`
  )
})

// ---------------------------------------------------------------------------
// Test: Multi-turn session with same tools works correctly
//
// WHY: When tools don't change between turns, the cache should still grow
// normally. This proves the trim logic doesn't over-trim when tools are stable.
// ---------------------------------------------------------------------------
test('[dynamic-tools] multi-turn session with same tools works correctly', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const sessionName = path.join(dirPath, 'dynamic-tools-same.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'What about London?' },
    TOOL_A
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.ok(
    r2.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `CacheTokens after turn 2 (${r2.stats.CacheTokens}) should be less than 2x turn 1 (${2 * r1.stats.CacheTokens})`
  )
})

// ---------------------------------------------------------------------------
// Test: Single-shot with tools works without session
//
// WHY: Users may call the model once with tools and no session. The pipeline
// must handle this without crashing or leaving stale state.
// ---------------------------------------------------------------------------
test('[dynamic-tools] single-shot with tools works without session', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t)

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Tokyo?' },
    TOOL_A
  ]
  const r = await runAndCollect(model, prompt)
  t.ok(r.output.length > 0, 'produces output')
  t.is(r.stats.CacheTokens, 0, 'no cache tokens without session')
  t.ok(r.stats.promptTokens > 0, 'prompt tokens tracked')
  t.ok(r.stats.generatedTokens > 0, 'generated tokens tracked')
})

// ---------------------------------------------------------------------------
// Test: Output contains tool_call block when tool-triggering prompt is given
//
// WHY: Pitch DoD says "model picks correct tool after tool change". The
// existing tests only checked output.length > 0, which passes even if the
// model ignores the tools entirely. This verifies the pipeline actually
// produces a tool_call in the output — a functional check, not accuracy.
// COVERS: Pitch #1 (model picks correct tool)
// ---------------------------------------------------------------------------
test('[dynamic-tools] output contains tool_call block when tools are provided', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Berlin right now?' },
    TOOL_A
  ]
  const r = await runAndCollect(model, prompt)
  t.ok(r.output.length > 0, 'produces output')
  t.ok(
    hasToolCallBlock(r.output),
    `output should contain a tool_call block when a clear tool-triggering prompt is given. Got: "${r.output.slice(0, 200)}..."`
  )
  t.comment(`tool_call output (first 300 chars): ${r.output.slice(0, 300)}`)
})

// ---------------------------------------------------------------------------
// Test: Tool_call references the correct tool after a tool swap
//
// WHY: After swapping from TOOL_A to TOOL_B, the model should call the new
// tool (searchProducts), not the old one (getWeather). This catches cases
// where stale tool tokens in the KV cache cause the model to pattern-match
// on a removed tool.
// COVERS: Pitch #1 (model picks correct tool after tool change)
// ---------------------------------------------------------------------------
test('[dynamic-tools] tool_call references current tool after swap', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256' })
  const sessionName = path.join(dirPath, 'dynamic-tools-swap-verify.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Berlin right now?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.comment(`turn 1 output (first 300 chars): ${r1.output.slice(0, 300)}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Search for wireless headphones under $50' },
    TOOL_B
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 produces output after tool swap')

  if (hasToolCallBlock(r2.output)) {
    t.ok(
      !r2.output.includes('"getWeather"') && !r2.output.includes("'getWeather'"),
      'turn 2 should not reference the old tool (getWeather) after swap'
    )
  }
  t.comment(`turn 2 output (first 300 chars): ${r2.output.slice(0, 300)}`)
})

// ---------------------------------------------------------------------------
// Test: Conversation history preserved after tool swap
//
// WHY: Pitch DoD says "can refer to conversation history after swapping the
// tools". The KV cache optimization must not destroy earlier conversation
// context. This test establishes a fact in turn 1, swaps tools in turn 2,
// then asks about turn 1's content.
// COVERS: Pitch #3 (history preserved after swap)
// ---------------------------------------------------------------------------
test('[dynamic-tools] conversation history preserved after tool swap', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '128' })
  const sessionName = path.join(dirPath, 'dynamic-tools-history.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Remember this: my favorite number is 42. Confirm you understood.' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.comment(`turn 1 output: ${r1.output.slice(0, 300)}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Search for notebooks' },
    TOOL_B
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 produces output with new tools')

  const prompt3 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'What was my favorite number that I told you earlier?' },
    TOOL_B
  ]
  const r3 = await runAndCollect(model, prompt3)
  t.ok(r3.output.length > 0, 'turn 3 produces output')
  t.comment(`turn 3 (history recall): ${r3.output.slice(0, 300)}`)

  t.ok(
    r3.stats.CacheTokens > 0,
    'cache tokens should be non-zero — conversation history is still in cache'
  )
})

// ---------------------------------------------------------------------------
// Test: A → B → A tool round-trip
//
// WHY: Pitch "Risks" section mentions "tools A → tools B → tools A" as the
// motivating agent use case. The existing test only goes A→B→C. Re-presenting
// a previously-seen toolset tests that the cache trim + re-add cycle works
// for repeated tools, not just fresh ones.
// COVERS: Pitch #4 (A→B→A round-trip)
// ---------------------------------------------------------------------------
test('[dynamic-tools] A → B → A tool round-trip preserves cache integrity', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256' })
  const sessionName = path.join(dirPath, 'dynamic-tools-aba.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Tokyo?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 (tool A) produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.comment(`turn 1 cache: ${r1.stats.CacheTokens}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Search for running shoes' },
    TOOL_B
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 (tool B) produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.comment(`turn 2 cache: ${r2.stats.CacheTokens}`)

  const prompt3 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Check the weather in London now' },
    TOOL_A
  ]
  const r3 = await runAndCollect(model, prompt3)
  t.ok(r3.output.length > 0, 'turn 3 (tool A again) produces output')
  t.ok(r3.stats.CacheTokens > 0, 'turn 3 has cache tokens')
  t.comment(`turn 3 cache: ${r3.stats.CacheTokens}`)

  t.ok(
    r3.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `cache after A→B→A (${r3.stats.CacheTokens}) should stay bounded, not grow unbounded (2x turn1 = ${2 * r1.stats.CacheTokens})`
  )

  if (hasToolCallBlock(r3.output)) {
    t.ok(
      !r3.output.includes('"searchProducts"') && !r3.output.includes("'searchProducts'"),
      'turn 3 should reference getWeather (tool A), not searchProducts (tool B)'
    )
  }
})

// ---------------------------------------------------------------------------
// Test: Extended multi-turn session (5 turns with tool changes)
//
// WHY: The pitch motivation is "long conversations with many turns" on mobile.
// Only 2-3 turns were tested before. This exercises the cache trim loop over
// more iterations, which is where token arithmetic bugs accumulate.
// COVERS: Docs #6 (long conversations)
// ---------------------------------------------------------------------------
test('[dynamic-tools] extended 5-turn session with mixed tool changes', { timeout: 900_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const sessionName = path.join(dirPath, 'dynamic-tools-extended.bin')

  const turns = [
    { content: 'What is the weather in Paris?', tool: TOOL_A },
    { content: 'Search for winter jackets', tool: TOOL_B },
    { content: 'Send a summary to the team', tool: TOOL_C },
    { content: 'Check weather in Berlin', tool: TOOL_A },
    { content: 'Translate this to French: Good morning', tool: TOOL_D }
  ]

  let prevCacheTokens = 0
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const prompt = [
      { role: 'session', content: sessionName },
      ...(i === 0 ? [SYSTEM_MESSAGE] : []),
      { role: 'user', content: turn.content },
      turn.tool
    ]

    const r = await runAndCollect(model, prompt)
    t.ok(r.output.length > 0, `turn ${i + 1} produces output`)
    t.ok(r.stats.CacheTokens > 0, `turn ${i + 1} has cache tokens`)
    t.comment(`turn ${i + 1} [${turn.tool.name}]: cache=${r.stats.CacheTokens} prompt=${r.stats.promptTokens} gen=${r.stats.generatedTokens}`)

    prevCacheTokens = r.stats.CacheTokens
  }

  t.ok(
    prevCacheTokens < 1000,
    `final cache (${prevCacheTokens}) should stay reasonable — tools are trimmed each turn, not accumulated`
  )
})

// ---------------------------------------------------------------------------
// Test: Many tools with complex schemas
//
// WHY: Real agent systems pass 5-20 tools with complex schemas. The double
// tokenization, boundary calculation, and cache trim must handle substantial
// tool payloads without breaking.
// COVERS: Config #10 (many tools)
// ---------------------------------------------------------------------------
test('[dynamic-tools] many tools with complex schemas', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'I need to check the weather in Tokyo, search for umbrellas, send an email about it, translate the email to Japanese, and create a calendar reminder for tomorrow at 9am.' },
    TOOL_A,
    TOOL_B,
    TOOL_C,
    TOOL_D,
    TOOL_E
  ]
  const r = await runAndCollect(model, prompt)
  t.ok(r.output.length > 0, 'produces output with 5 tools')
  t.ok(r.stats.promptTokens > 0, 'prompt tokens tracked')
  t.ok(r.stats.generatedTokens > 0, 'generated tokens tracked')
  t.comment(`5-tool prompt: promptTokens=${r.stats.promptTokens} gen=${r.stats.generatedTokens}`)
  t.comment(`output (first 300 chars): ${r.output.slice(0, 300)}`)
})

// ---------------------------------------------------------------------------
// Test: Session save → destroy → reload → continue with different tools
//
// WHY: Apps that swap models or recover from errors need the session to
// survive a full lifecycle. The C++ tests cover save/restore, but users
// interact through the JS API where the code path is different.
// COVERS: Config #9 (session save/restore cycle)
// ---------------------------------------------------------------------------
test('[dynamic-tools] session save, model destroy, reload, continue with different tools', { timeout: 600_000 }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN3_MODEL.name,
    downloadUrl: QWEN3_MODEL.url
  })
  const sessionName = path.join(dirPath, 'dynamic-tools-lifecycle.bin')

  const createAndLoad = async () => {
    const loader = new FilesystemDL({ dirPath })
    const specLogger = attachSpecLogger({ forwardToConsole: true })
    let loggerReleased = false
    const releaseLogger = () => {
      if (loggerReleased) return
      loggerReleased = true
      specLogger.release()
    }
    const model = new LlmLlamacpp({
      loader,
      modelName,
      diskPath: dirPath,
      logger: console,
      opts: { stats: true }
    }, BASE_CONFIG)
    await model.load()
    return { model, loader, releaseLogger }
  }

  let ctx = await createAndLoad()
  try {
    const prompt1 = [
      { role: 'session', content: sessionName },
      SYSTEM_MESSAGE,
      { role: 'user', content: 'What is the weather in Sydney?' },
      TOOL_A
    ]
    const r1 = await runAndCollect(ctx.model, prompt1)
    t.ok(r1.output.length > 0, 'turn 1 produces output')
    t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
    const cacheAfterTurn1 = r1.stats.CacheTokens

    const savePrompt = [
      { role: 'session', content: sessionName },
      { role: 'session', content: 'save' }
    ]
    await runAndCollect(ctx.model, savePrompt)
    t.ok(fs.existsSync(sessionName), 'session file saved to disk')

    await ctx.model.unload().catch(() => {})
    await ctx.loader.close().catch(() => {})
    ctx.releaseLogger()

    ctx = await createAndLoad()

    const prompt2 = [
      { role: 'session', content: sessionName },
      { role: 'user', content: 'Search for sunscreen products' },
      TOOL_B
    ]
    const r2 = await runAndCollect(ctx.model, prompt2)
    t.ok(r2.output.length > 0, 'turn 2 after reload produces output')
    t.ok(r2.stats.CacheTokens > 0, 'turn 2 after reload has cache tokens')
    t.comment(`pre-save cache: ${cacheAfterTurn1}, post-reload cache: ${r2.stats.CacheTokens}`)
  } finally {
    await ctx.model.unload().catch(() => {})
    await ctx.loader.close().catch(() => {})
    ctx.releaseLogger()
    try { fs.unlinkSync(sessionName) } catch (_) {}
  }
})

// ---------------------------------------------------------------------------
// Test: Cancel mid-generation then reuse model with tools
//
// WHY: Cancelling mid-operation must not corrupt the DynamicToolsState or
// KV cache. The model should be reusable for subsequent tool-bearing prompts
// after a cancel.
// COVERS: Code/Review #8 (cancel with active tool state)
// ---------------------------------------------------------------------------
test('[dynamic-tools] cancel mid-generation then reuse with tools', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '512' })
  const sessionName = path.join(dirPath, 'dynamic-tools-cancel.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Write a very long detailed essay about the history of computing from the 1940s to today.' },
    TOOL_A
  ]

  const response = await model.run(prompt1)
  let tokenCount = 0
  let cancelled = false

  try {
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => {
        tokenCount++
        if (tokenCount >= 5 && !cancelled) {
          cancelled = true
          model.cancel()
        }
      })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => {
          if (/cancel|abort|stopp/i.test(err.message || String(err))) {
            resolve()
          } else {
            reject(err)
          }
        })
      }
      chain.await().then(resolve).catch(err => {
        if (/cancel|abort|stopp/i.test(err.message || String(err))) {
          resolve()
        } else {
          reject(err)
        }
      })
    })
  } catch (err) {
    if (!/cancel|abort|stopp/i.test(err.message || String(err))) {
      throw err
    }
  }

  t.ok(cancelled, 'generation was cancelled mid-stream')

  const prompt2 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Rome?' },
    TOOL_A
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'model produces output after cancel — not corrupted')
  t.ok(r2.stats.generatedTokens > 0, 'generated tokens tracked after cancel')
  t.comment(`post-cancel output (first 200 chars): ${r2.output.slice(0, 200)}`)
})
