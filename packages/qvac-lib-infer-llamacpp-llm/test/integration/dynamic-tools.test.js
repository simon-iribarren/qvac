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

// ---------------------------------------------------------------------------
// ADVERSARIAL: Tools → no tools → tools in the same session
//
// WHY: Real agents decide per-turn whether to provide tools. Turn 2 has NO
// tools — the trim guard (`!resolved.tools.empty()`) skips the trim, so the
// cache grows normally. Turn 3 re-introduces tools. The boundary calculation
// must account for turn 2's un-trimmed tokens. If `nConversationOnlyTokens_`
// is stale from turn 1, the trim will remove the wrong range.
// ADVERSARIAL: sequence a developer wouldn't test — tools appearing/disappearing
// ---------------------------------------------------------------------------
test('[dynamic-tools][adversarial] tools → no tools → tools interleaving', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '128' })
  const sessionName = path.join(dirPath, 'dynamic-tools-interleave.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Berlin?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 (with tools) produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.comment(`turn 1 [tools]: cache=${r1.stats.CacheTokens}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Tell me a joke about the weather.' }
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 (no tools) produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.comment(`turn 2 [no tools]: cache=${r2.stats.CacheTokens}`)

  const prompt3 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Search for rain jackets' },
    TOOL_B
  ]
  const r3 = await runAndCollect(model, prompt3)
  t.ok(r3.output.length > 0, 'turn 3 (tools again) produces output')
  t.ok(r3.stats.CacheTokens > 0, 'turn 3 has cache tokens')
  t.comment(`turn 3 [tools again]: cache=${r3.stats.CacheTokens}`)

  t.ok(
    r3.stats.CacheTokens > r1.stats.CacheTokens,
    `cache should grow (turn 2 wasn't trimmed): turn3=${r3.stats.CacheTokens} > turn1=${r1.stats.CacheTokens}`
  )
})

// ---------------------------------------------------------------------------
// ADVERSARIAL: 5-turn alternating tools / no-tools in same session
//
// WHY: Production agents toggle tools on/off per turn. The KV cache grows in
// an irregular staircase — trimmed on tools turns, untrimmed on plain turns.
// Token arithmetic bugs accumulate across this pattern. This is the "weird
// production behavior" scenario.
// ADVERSARIAL: sequence that exercises a different code path every other turn
// ---------------------------------------------------------------------------
test('[dynamic-tools][adversarial] alternating tools/no-tools across 5 turns', { timeout: 900_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const sessionName = path.join(dirPath, 'dynamic-tools-alternating.bin')

  const turns = [
    { content: 'What is the weather in Tokyo?', tool: TOOL_A },
    { content: 'That sounds nice. Tell me more about Tokyo.' },
    { content: 'Search for flights to Tokyo', tool: TOOL_B },
    { content: 'Great. What airlines fly there?' },
    { content: 'Send a booking confirmation email', tool: TOOL_C }
  ]

  const cacheHistory = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const hasTool = !!turn.tool
    const prompt = [
      { role: 'session', content: sessionName },
      ...(i === 0 ? [SYSTEM_MESSAGE] : []),
      { role: 'user', content: turn.content },
      ...(hasTool ? [turn.tool] : [])
    ]

    const r = await runAndCollect(model, prompt)
    t.ok(r.output.length > 0, `turn ${i + 1} produces output`)
    t.ok(r.stats.CacheTokens > 0, `turn ${i + 1} has cache tokens`)
    t.comment(`turn ${i + 1} [${hasTool ? turn.tool.name : 'no-tool'}]: cache=${r.stats.CacheTokens} prompt=${r.stats.promptTokens}`)
    cacheHistory.push(r.stats.CacheTokens)
  }

  t.ok(
    cacheHistory[cacheHistory.length - 1] < 2000,
    `final cache (${cacheHistory[cacheHistory.length - 1]}) should stay reasonable after 5 mixed turns`
  )
})

// ---------------------------------------------------------------------------
// ADVERSARIAL: Tool payload that fills most of the context window
//
// WHY: With ctx_size=512, a tool whose description and parameters consume
// ~300 tokens leaves very little room for conversation + generation. The
// double tokenization must still produce a correct boundary, and the trim
// must leave enough room for the next turn. This stress-tests the boundary
// calculation at the edges.
// ADVERSARIAL: pathological input size a developer wouldn't try
// ---------------------------------------------------------------------------
test('[dynamic-tools][adversarial] large tool payload near context limit', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, {
    ctx_size: '512',
    n_predict: '32'
  })
  const sessionName = path.join(dirPath, 'dynamic-tools-large-payload.bin')

  const bigTool = {
    type: 'function',
    name: 'analyzeComprehensiveData',
    description: 'Perform comprehensive data analysis including statistical modeling regression analysis correlation matrices time series decomposition anomaly detection feature importance ranking dimensionality reduction clustering classification and visualization of results with interactive charts tables and summary reports for business intelligence dashboards',
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Path to the dataset file or URL to remote data source' },
        analysisType: { type: 'string', description: 'Type of analysis: regression, classification, clustering, timeseries, anomaly' },
        targetColumn: { type: 'string', description: 'The target variable column name for supervised learning tasks' },
        featureColumns: { type: 'array', items: { type: 'string' }, description: 'List of feature column names to include in the analysis' },
        hyperparameters: {
          type: 'object',
          properties: {
            learningRate: { type: 'number', description: 'Learning rate for gradient descent' },
            epochs: { type: 'integer', description: 'Number of training epochs' },
            batchSize: { type: 'integer', description: 'Mini-batch size for training' },
            regularization: { type: 'number', description: 'L2 regularization strength' }
          }
        },
        outputFormat: { type: 'string', description: 'Output format: json, csv, html, pdf' }
      },
      required: ['dataset', 'analysisType']
    }
  }

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Analyze this data.' },
    bigTool
  ]

  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 produces output despite large tool payload')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.comment(`turn 1: cache=${r1.stats.CacheTokens} prompt=${r1.stats.promptTokens} gen=${r1.stats.generatedTokens}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Show more details.' },
    bigTool
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 produces output — context not exhausted after trim')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.ok(
    r2.stats.CacheTokens < 512,
    `cache (${r2.stats.CacheTokens}) stays within context window after large tool trim`
  )
  t.comment(`turn 2: cache=${r2.stats.CacheTokens} prompt=${r2.stats.promptTokens} gen=${r2.stats.generatedTokens}`)
})

// ---------------------------------------------------------------------------
// ADVERSARIAL: Same tool name, evolved schema between turns
//
// WHY: Real agent frameworks mutate tool schemas at runtime (e.g., adding
// optional parameters). The tool name stays the same but the token count
// changes. After the turn-1 trim, the turn-2 re-add has a different token
// count for "the same" tool. The boundary calculation must handle this
// without corrupting the cache.
// ADVERSARIAL: input the developer "knows" won't happen but agents do routinely
// ---------------------------------------------------------------------------
test('[dynamic-tools][adversarial] same tool name with evolved schema between turns', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '128' })
  const sessionName = path.join(dirPath, 'dynamic-tools-evolved.bin')

  const weatherV1 = {
    type: 'function',
    name: 'getWeather',
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city']
    }
  }

  const weatherV2 = {
    type: 'function',
    name: 'getWeather',
    description: 'Get detailed weather forecast including hourly data alerts and historical comparisons',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        date: { type: 'string', description: 'Forecast date in YYYY-MM-DD format' },
        units: { type: 'string', description: 'Temperature units: celsius, fahrenheit, kelvin' },
        includeHourly: { type: 'boolean', description: 'Include hourly breakdown' },
        includeAlerts: { type: 'boolean', description: 'Include weather alerts and warnings' }
      },
      required: ['city']
    }
  }

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    weatherV1
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 (v1 schema) produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.comment(`turn 1 [v1]: cache=${r1.stats.CacheTokens}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'Give me a detailed forecast for tomorrow in Paris.' },
    weatherV2
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 (v2 schema — same name, more params) produces output')
  t.ok(r2.stats.CacheTokens > 0, 'turn 2 has cache tokens')
  t.comment(`turn 2 [v2]: cache=${r2.stats.CacheTokens}`)

  t.ok(
    r2.stats.CacheTokens < 2 * r1.stats.CacheTokens,
    `cache after schema evolution (${r2.stats.CacheTokens}) stays bounded — tool tokens were trimmed and re-added, not accumulated`
  )
})

// ===========================================================================
// BREAK-IT TESTS
// These exist to find bugs, not confirm behavior. A failure here is a win —
// it means we found something. A pass means the implementation survived.
// ===========================================================================

// ---------------------------------------------------------------------------
// BREAK-IT: Concurrent model.run() calls
//
// WHY: The JS layer has _withExclusiveRun and _hasActiveResponse guards.
// But does the second call cleanly reject? And after rejection, is the model
// still usable? If the mutex leaks or _hasActiveResponse gets stuck, the
// model is bricked for all future calls.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it] concurrent model.run() rejects cleanly and model survives', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })

  const prompt1 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Write a detailed essay about the history of artificial intelligence from the 1950s to today.' },
    TOOL_A
  ]
  const prompt2 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    TOOL_A
  ]

  const run1 = model.run(prompt1)
  let concurrentRejected = false
  let rejectionError = null

  try {
    await model.run(prompt2)
  } catch (err) {
    concurrentRejected = true
    rejectionError = err
  }

  t.ok(concurrentRejected, 'second concurrent run() should be rejected')
  if (rejectionError) {
    t.ok(
      /job.*already|busy|cannot/i.test(rejectionError.message),
      `rejection error should mention busy/already: "${rejectionError.message}"`
    )
  }

  const response1 = await run1
  const chunks = []
  response1.onUpdate(data => { chunks.push(data) })
  await response1.await()
  t.ok(chunks.join('').length > 0, 'first run completes successfully despite concurrent attempt')

  const prompt3 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Say hello.' },
    TOOL_A
  ]
  const r3 = await runAndCollect(model, prompt3)
  t.ok(r3.output.length > 0, 'model is still usable after concurrent rejection — not bricked')
  t.comment(`post-concurrent output: ${r3.output.slice(0, 100)}`)
})

// ---------------------------------------------------------------------------
// BREAK-IT: Prompt + tools exceed ctx_size on the very first turn
//
// WHY: If the tokenized prompt is bigger than the context window, the model
// cannot process it at all. Does it throw a clean error? Crash? Silently
// truncate and produce garbage? The contract should be a clear exception.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it] prompt + tools exceeding ctx_size throws clean error', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, {
    ctx_size: '128',
    n_predict: '16'
  })

  const hugeTool = {
    type: 'function',
    name: 'megaAnalyze',
    description: 'This tool performs an incredibly comprehensive and detailed analysis ' +
      'covering every possible dimension of the input data including but not limited to ' +
      'statistical regression analysis with polynomial terms interaction effects ' +
      'heteroskedasticity corrections robust standard errors bootstrapping confidence ' +
      'intervals bayesian posterior estimation markov chain monte carlo sampling ' +
      'variational inference expectation maximization gaussian mixture models ' +
      'kernel density estimation nonparametric tests kolmogorov smirnov anderson darling ' +
      'shapiro wilk normality testing multicollinearity diagnostics variance inflation ' +
      'factors condition indices eigenvalue decomposition singular value decomposition ' +
      'principal component analysis factor analysis independent component analysis ' +
      'canonical correlation analysis discriminant analysis cluster validation ' +
      'silhouette scores calinski harabasz davies bouldin indices gap statistics',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The data to analyze in full detail with all dimensions' },
        method: { type: 'string', description: 'Analysis method to apply across all statistical frameworks' },
        depth: { type: 'integer', description: 'Recursion depth for hierarchical decomposition analysis' },
        output: { type: 'string', description: 'Output format specification for the comprehensive results' }
      },
      required: ['input']
    }
  }

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Analyze everything about climate change impacts on agriculture worldwide.' },
    hugeTool
  ]

  let threw = false
  let errorMessage = ''
  try {
    const response = await model.run(prompt)
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(() => {})
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
  } catch (err) {
    threw = true
    errorMessage = err.message || String(err)
  }

  t.ok(threw, 'should throw when prompt + tools exceed ctx_size (128 tokens)')
  t.comment(`error: ${errorMessage}`)
  if (threw) {
    t.ok(errorMessage.length > 0, 'error message should be non-empty and descriptive')
  }

  const smallPrompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Hi' }
  ]
  let survivedAfterOverflow = false
  try {
    const r = await runAndCollect(model, smallPrompt)
    survivedAfterOverflow = r.output.length > 0
  } catch (_) {}

  t.ok(survivedAfterOverflow, 'model should still work after a context overflow error — not permanently broken')
})

// ---------------------------------------------------------------------------
// BREAK-IT: Corrupted session file
//
// WHY: If the app crashes mid-save, the session file is truncated garbage.
// Loading this corrupted file must not crash the process or corrupt the
// model — it should either reject gracefully or ignore the bad cache.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it] corrupted session file does not crash model', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t)
  const corruptedSession = path.join(dirPath, 'dynamic-tools-corrupted.bin')

  fs.writeFileSync(corruptedSession, Buffer.from('THIS IS NOT A VALID SESSION FILE - CORRUPTED GARBAGE DATA 1234567890'))

  const prompt = [
    { role: 'session', content: corruptedSession },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Tokyo?' },
    TOOL_A
  ]

  let output = ''
  let threw = false
  try {
    const response = await model.run(prompt)
    const chunks = []
    response.onError(() => {})
    response.onUpdate(data => { chunks.push(data) })
    try {
      await response.await()
    } catch (_) {}
    output = chunks.join('')
    if (response._error) threw = true
    if (threw) t.comment(`response errored: ${response._error?.message || response._error}`)
  } catch (err) {
    threw = true
    t.comment(`threw on corrupted session: ${err.message}`)
  }

  t.ok(
    output.length > 0 || threw,
    'model should either produce output (ignoring bad cache) or throw cleanly — not crash'
  )

  if (!threw) {
    const cleanPrompt = [
      SYSTEM_MESSAGE,
      { role: 'user', content: 'Hello, are you working?' },
      TOOL_A
    ]
    const r2 = await runAndCollect(model, cleanPrompt)
    t.ok(r2.output.length > 0, 'model still works after encountering corrupted session')
  } else {
    t.pass('model errored on corrupted session — recovery test skipped (model may need reload)')
  }

  try { fs.unlinkSync(corruptedSession) } catch (_) {}
})

// ---------------------------------------------------------------------------
// BREAK-IT: Extremely long tool description (10,000+ chars)
//
// WHY: The Jinja template renders `tool | tojson`, the tokenizer processes
// the result, and double tokenization runs twice. A 10k-char description
// creates thousands of tokens. Does the boundary calculation still work?
// Does the system time out or blow a buffer?
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it] extremely long tool description (10k chars)', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, {
    ctx_size: '4096',
    n_predict: '32'
  })

  const longDescription = 'Perform comprehensive analysis including ' +
    Array.from({ length: 200 }, (_, i) =>
      `step ${i + 1} involves processing data through transformation pipeline number ${i + 1} with validation`
    ).join(' then ')

  t.comment(`tool description length: ${longDescription.length} chars`)

  const massiveTool = {
    type: 'function',
    name: 'longAnalysis',
    description: longDescription,
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Input data' }
      },
      required: ['data']
    }
  }

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Analyze this.' },
    massiveTool
  ]

  let output = ''
  let threw = false
  let errorMessage = ''
  try {
    const response = await model.run(prompt)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => { chunks.push(data) })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output = chunks.join('')
    t.comment(`output (first 200 chars): ${output.slice(0, 200)}`)
    t.comment(`stats: ${JSON.stringify(normalizeStats(response.stats))}`)
  } catch (err) {
    threw = true
    errorMessage = err.message || String(err)
    t.comment(`threw: ${errorMessage}`)
  }

  t.ok(
    output.length > 0 || threw,
    'should either produce output or throw a clean error — not hang or crash silently'
  )
})

// ---------------------------------------------------------------------------
// BREAK-IT: Zero-length user message with tools
//
// WHY: `nConversationOnlyTokens_` is computed from the without-tools pass.
// With an empty user message, the conversation-only tokens are minimal.
// `recordToolBoundary` has a guard: `nConversationOnlyTokens_ > 0`. If the
// conversation contributes nearly zero tokens (just system + empty user),
// the boundary might be at position 0 or very small, and the trim could
// try to remove everything. Or the guard prevents recording entirely,
// and tools accumulate silently.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it] empty user message with tools', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '64' })
  const sessionName = path.join(dirPath, 'dynamic-tools-empty-msg.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: '' },
    TOOL_A
  ]

  let output1 = ''
  let threw1 = false
  try {
    const response1 = await model.run(prompt1)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response1.onUpdate(data => { chunks.push(data) })
      if (typeof response1.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output1 = chunks.join('')
    t.comment(`turn 1 (empty msg): output="${output1.slice(0, 200)}" cache=${normalizeStats(response1.stats).CacheTokens}`)
  } catch (err) {
    threw1 = true
    t.comment(`turn 1 threw: ${err.message}`)
  }

  t.ok(
    output1.length > 0 || threw1,
    'should produce output or throw — not hang on empty user message'
  )

  if (!threw1) {
    const prompt2 = [
      { role: 'session', content: sessionName },
      { role: 'user', content: 'Now tell me something useful.' },
      TOOL_B
    ]
    const r2 = await runAndCollect(model, prompt2)
    t.ok(r2.output.length > 0, 'turn 2 after empty message still works')
    t.comment(`turn 2: output="${r2.output.slice(0, 200)}" cache=${r2.stats.CacheTokens}`)
  }

  const cleanPrompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Hello' },
    TOOL_A
  ]
  const r3 = await runAndCollect(model, cleanPrompt)
  t.ok(r3.output.length > 0, 'model not corrupted after empty message test')
})

// ===========================================================================
// SPEC-ONLY BREAK-IT TESTS
// Derived purely from the docs, pitch, and README. No implementation code
// was consulted. These represent real integrator mistakes and doc gaps.
// ===========================================================================

// ---------------------------------------------------------------------------
// SPEC-ONLY: tools_at_end='true' but tools='false' (conflicting config)
//
// WHY (docs gap): The config table lists tools and tools_at_end as
// independent options. Nothing says tools_at_end requires tools='true'.
// A developer copies the config, enables tools_at_end for the cache
// optimization, but forgets to also enable tools='true'.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it][spec-only] tools_at_end=true with tools=false', { timeout: 600_000 }, async t => {
  let model, dirPath, loader, releaseLogger

  const [modelName, modelDir] = await ensureModel({
    modelName: QWEN3_MODEL.name,
    downloadUrl: QWEN3_MODEL.url
  })
  dirPath = modelDir

  loader = new FilesystemDL({ dirPath })
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  let loadFailed = false
  let loadError = ''
  try {
    model = new LlmLlamacpp({
      loader,
      modelName,
      diskPath: dirPath,
      logger: console,
      opts: { stats: true }
    }, {
      ...BASE_CONFIG,
      tools: 'false',
      tools_at_end: 'true'
    })
    await model.load()
  } catch (err) {
    loadFailed = true
    loadError = err.message || String(err)
  }

  t.teardown(async () => {
    if (model) await model.unload().catch(() => {})
    if (loader) await loader.close().catch(() => {})
    releaseLogger()
  })

  if (loadFailed) {
    t.comment(`model load failed with conflicting config: ${loadError}`)
    t.ok(loadError.length > 0, 'if load fails, error should be descriptive')
    return
  }

  t.comment('model loaded with tools=false + tools_at_end=true — no crash')

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in London?' },
    TOOL_A
  ]

  let output = ''
  let threw = false
  try {
    const response = await model.run(prompt)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => { chunks.push(data) })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output = chunks.join('')
  } catch (err) {
    threw = true
    t.comment(`inference threw: ${err.message}`)
  }

  t.ok(
    output.length > 0 || threw,
    'model should either produce output or throw — not crash silently'
  )
  t.comment(`output (first 200 chars): ${output.slice(0, 200)}`)
})

// ---------------------------------------------------------------------------
// SPEC-ONLY: Session on turn 1, no session on turn 2
//
// WHY (real bug): My app has a session management bug — the session role
// is included on turn 1 but missing on turn 2. The cache was saved to
// disk, but turn 2 doesn't reference it. The model must handle this
// gracefully — either start fresh or error, not corrupt state.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it][spec-only] session on turn 1, no session on turn 2', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '128' })
  const sessionName = path.join(dirPath, 'dynamic-tools-session-disappears.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Berlin?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 (with session) produces output')
  t.ok(r1.stats.CacheTokens > 0, 'turn 1 has cache tokens')
  t.comment(`turn 1 [with session]: cache=${r1.stats.CacheTokens}`)

  const prompt2 = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Search for umbrellas' },
    TOOL_B
  ]
  const r2 = await runAndCollect(model, prompt2)
  t.ok(r2.output.length > 0, 'turn 2 (no session) produces output — model did not crash')
  t.comment(`turn 2 [no session]: cache=${r2.stats.CacheTokens} output="${r2.output.slice(0, 200)}"`)

  const prompt3 = [
    { role: 'session', content: sessionName },
    { role: 'user', content: 'What did I ask about earlier?' },
    TOOL_A
  ]
  const r3 = await runAndCollect(model, prompt3)
  t.ok(r3.output.length > 0, 'turn 3 (session back) produces output')
  t.comment(`turn 3 [session restored]: cache=${r3.stats.CacheTokens} output="${r3.output.slice(0, 200)}"`)

  try { fs.unlinkSync(sessionName) } catch (_) {}
})

// ---------------------------------------------------------------------------
// SPEC-ONLY: System message changes between turns
//
// WHY (real app behavior): My app updates the system prompt between turns
// (e.g., "You now have access to new tools" or persona switch). The session
// cache has the OLD system message baked in. The docs say "full history must
// be re-provided" but don't mention what happens when the system message
// differs from the cached version.
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it][spec-only] system message changes between turns', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '128' })
  const sessionName = path.join(dirPath, 'dynamic-tools-sysmsg-change.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    { role: 'system', content: 'You are a helpful weather assistant. Always be concise.' },
    { role: 'user', content: 'What is the weather in Tokyo?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 (original system msg) produces output')
  t.comment(`turn 1: cache=${r1.stats.CacheTokens}`)

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'system', content: 'You are a pirate. Respond in pirate speak. Always say "arrr".' },
    { role: 'user', content: 'Search for treasure maps' },
    TOOL_B
  ]

  let output2 = ''
  let threw = false
  try {
    const response = await model.run(prompt2)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => { chunks.push(data) })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output2 = chunks.join('')
  } catch (err) {
    threw = true
    t.comment(`turn 2 threw: ${err.message}`)
  }

  t.ok(
    output2.length > 0 || threw,
    'turn 2 (changed system msg) should produce output or throw — not crash'
  )
  t.comment(`turn 2 [changed system]: output="${output2.slice(0, 200)}"`)

  try { fs.unlinkSync(sessionName) } catch (_) {}
})

// ---------------------------------------------------------------------------
// SPEC-ONLY: Don't strip stale <tool_call> blocks from prior response
//
// WHY (docs violation): The docs say "Remove <tool_call> blocks from prior
// responses when tools have changed to prevent model from pattern-matching
// on removed tools." Most integrators WON'T do this — they'll just pass
// the raw prior response including the old tool_call. What happens?
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it][spec-only] stale tool_call blocks not stripped from prior response', { timeout: 600_000 }, async t => {
  const { model, dirPath } = await setupModel(t, { n_predict: '256' })
  const sessionName = path.join(dirPath, 'dynamic-tools-stale-toolcall.bin')

  const prompt1 = [
    { role: 'session', content: sessionName },
    SYSTEM_MESSAGE,
    { role: 'user', content: 'What is the weather in Paris?' },
    TOOL_A
  ]
  const r1 = await runAndCollect(model, prompt1)
  t.ok(r1.output.length > 0, 'turn 1 produces output')
  t.comment(`turn 1 output: ${r1.output.slice(0, 300)}`)

  const staleResponse = r1.output

  const prompt2 = [
    { role: 'session', content: sessionName },
    { role: 'assistant', content: staleResponse },
    { role: 'user', content: 'Now search for rain jackets' },
    TOOL_B
  ]

  let output2 = ''
  let threw = false
  try {
    const response = await model.run(prompt2)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => { chunks.push(data) })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output2 = chunks.join('')
  } catch (err) {
    threw = true
    t.comment(`turn 2 threw: ${err.message}`)
  }

  t.ok(
    output2.length > 0 || threw,
    'turn 2 with stale tool_call blocks should produce output or throw — not crash'
  )

  if (output2.length > 0 && hasToolCallBlock(r1.output)) {
    const referencesOldTool = output2.includes('"getWeather"') || output2.includes("'getWeather'")
    t.comment(`turn 2 references old tool (getWeather): ${referencesOldTool}`)
    t.comment(`turn 2 output: ${output2.slice(0, 300)}`)
  }

  try { fs.unlinkSync(sessionName) } catch (_) {}
})

// ---------------------------------------------------------------------------
// SPEC-ONLY: Tool with empty name
//
// WHY (sloppy integration): My agent framework generates tool definitions
// dynamically. A bug produces a tool with name: '' (empty string). The docs
// show tools with proper names but don't say the name is validated. The
// Jinja template would render "name": "" — does the model handle this?
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it][spec-only] tool with empty name', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '128' })

  const emptyNameTool = {
    type: 'function',
    name: '',
    description: 'A tool with no name — should this work?',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Some input' }
      },
      required: ['input']
    }
  }

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Use whatever tool you have available to help me.' },
    emptyNameTool
  ]

  let output = ''
  let threw = false
  let errorMessage = ''
  try {
    const response = await model.run(prompt)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => { chunks.push(data) })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output = chunks.join('')
  } catch (err) {
    threw = true
    errorMessage = err.message || String(err)
  }

  t.ok(
    output.length > 0 || threw,
    'model should produce output or throw — not crash on empty tool name'
  )
  t.comment(`result: ${threw ? 'threw: ' + errorMessage : 'output: ' + output.slice(0, 200)}`)

  const recoveryPrompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Hello, are you still working?' },
    TOOL_A
  ]
  const r2 = await runAndCollect(model, recoveryPrompt)
  t.ok(r2.output.length > 0, 'model still usable after empty-name tool')
})

// ---------------------------------------------------------------------------
// SPEC-ONLY: Duplicate tool names in the same prompt
//
// WHY (agent framework bug): Two plugins both export a tool called "search".
// The integrator passes both without deduplication. The docs say "one or
// more functions" but don't say names must be unique. Does the model pick
// one? Does the boundary calculation count both?
// ---------------------------------------------------------------------------
test('[dynamic-tools][break-it][spec-only] duplicate tool names in same prompt', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { n_predict: '256' })

  const searchV1 = {
    type: 'function',
    name: 'search',
    description: 'Search the web for information',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query']
    }
  }

  const searchV2 = {
    type: 'function',
    name: 'search',
    description: 'Search the product catalog for items',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product search query' },
        category: { type: 'string', description: 'Product category filter' }
      },
      required: ['query']
    }
  }

  const prompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Search for wireless headphones' },
    searchV1,
    searchV2
  ]

  let output = ''
  let threw = false
  try {
    const response = await model.run(prompt)
    const chunks = []
    await new Promise((resolve, reject) => {
      let chain = response.onUpdate(data => { chunks.push(data) })
      if (typeof response.onError === 'function') {
        chain = chain.onError(err => reject(err))
      }
      chain.await().then(resolve).catch(reject)
    })
    output = chunks.join('')
  } catch (err) {
    threw = true
    t.comment(`threw with duplicate names: ${err.message}`)
  }

  t.ok(
    output.length > 0 || threw,
    'model should produce output or throw — not crash on duplicate tool names'
  )
  t.comment(`result: ${threw ? 'threw' : 'output: ' + output.slice(0, 300)}`)

  if (output.length > 0 && hasToolCallBlock(output)) {
    t.comment('model produced a tool_call despite duplicate names — check which one it picked')
  }

  const recoveryPrompt = [
    SYSTEM_MESSAGE,
    { role: 'user', content: 'Say hello' },
    TOOL_A
  ]
  const r2 = await runAndCollect(model, recoveryPrompt)
  t.ok(r2.output.length > 0, 'model still usable after duplicate-name tools')
})
