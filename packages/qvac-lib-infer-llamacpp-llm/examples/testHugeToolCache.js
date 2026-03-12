'use strict'

const LlmLlamacpp = require('../index')
const FilesystemDL = require('@qvac/dl-filesystem')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const os = require('bare-os')
const { downloadModel } = require('./utils')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Qwen3-1.7B-Q4_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf'
}

const NUM_TURNS = 10

// ─── Generate a massive tool definition (~3000 tokens) ─────────────────────

function generateHugeTool () {
  // ~60 properties with verbose descriptions to hit ~3000 tokens
  const properties = {}
  const fields = [
    'user_name', 'user_id', 'user_email', 'user_phone', 'user_address',
    'user_city', 'user_state', 'user_zip', 'user_country', 'user_status',
    'account_id', 'account_type', 'account_tier', 'account_balance',
    'order_id', 'order_status', 'order_total', 'order_currency', 'order_date',
    'product_id', 'product_name', 'product_category', 'product_price',
    'shipping_method', 'shipping_address', 'shipping_tracking',
    'billing_name', 'billing_address', 'billing_card_last4',
    'payment_method', 'payment_status', 'payment_amount',
    'ticket_id', 'ticket_subject', 'ticket_priority', 'ticket_status',
    'subscription_plan', 'subscription_renewal', 'subscription_active',
    'discount_code', 'discount_percent', 'discount_expires',
    'report_type', 'report_start_date', 'report_end_date', 'report_format',
    'notification_type', 'notification_channel', 'notification_message',
    'inventory_sku', 'inventory_quantity', 'inventory_warehouse',
    'analytics_metric', 'analytics_period', 'analytics_segment',
    'webhook_url', 'webhook_event', 'webhook_secret',
    'audit_action', 'audit_timestamp', 'audit_actor'
  ]

  for (const field of fields) {
    const isNum = field.includes('amount') || field.includes('price') || field.includes('total') || field.includes('quantity') || field.includes('balance') || field.includes('percent')
    properties[field] = {
      type: isNum ? 'number' : 'string',
      description: `The ${field.replace(/_/g, ' ')} field used for enterprise data management operations including filtering, processing, and reporting.`
    }
  }

  return {
    type: 'function',
    name: 'enterpriseDataManager',
    description: 'A comprehensive enterprise data management tool that handles user management, billing, shipping, orders, payments, inventory, analytics, reporting, notifications, subscriptions, discounts, support tickets, webhooks, and audit logging.',
    parameters: {
      type: 'object',
      properties,
      required: ['user_name', 'user_id', 'order_id']
    }
  }
}

const HUGE_TOOL = generateHugeTool()

const CONVERSATION_TURNS = [
  'Hello, what can you help me with?',
  'Look up user john@example.com',
  'What is order 12345 status?',
  'Update the shipping address for that order',
  'Show me the billing summary',
  'Create a support ticket for this issue',
  'What analytics do we have for last month?',
  'Generate a report of all active subscriptions',
  'Apply discount code SAVE20 to order 12345',
  'Send a notification to the customer about the update'
]

function stripInternalBlocks (text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim()
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadModel (dirPath, modelName, config) {
  const loader = new FilesystemDL({ dirPath })
  const model = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)
  await model.load()
  return { model, loader }
}

async function runAndCollect (model, prompt) {
  const response = await model.run(prompt)
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return { output: chunks.join(''), stats: response.stats }
}

function hrMs (hrtime) {
  return (hrtime[0] * 1e3 + hrtime[1] / 1e6).toFixed(2)
}

// ─── Scenario: tools_at_end ─────────────────────────────────────────────────

async function runToolsAtEnd (dirPath, modelName) {
  console.log('\n' + '='.repeat(70))
  console.log('SCENARIO A: tools_at_end = true (huge tool ~3000 tokens)')
  console.log('='.repeat(70))

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '8192',
    n_predict: '128',
    temp: '0.1',
    seed: '1',
    verbosity: '0',
    tools: 'true',
    tools_at_end: 'true'
  }

  const { model, loader } = await loadModel(dirPath, modelName, config)
  const cachePath = path.join(dirPath, 'huge-tool-at-end.bin')
  try { fs.unlinkSync(cachePath) } catch (_) {}

  const stats = []
  let lastResponse = null

  try {
    for (let i = 0; i < NUM_TURNS; i++) {
      const prompt = [
        { role: 'session', content: cachePath },
        ...(i === 0
          ? [{ role: 'system', content: 'You are a helpful enterprise assistant.' }, { role: 'user', content: CONVERSATION_TURNS[i] }]
          : [
            ...(lastResponse ? [{ role: 'assistant', content: lastResponse }] : []),
            { role: 'user', content: CONVERSATION_TURNS[i] }
          ]),
        HUGE_TOOL
      ]

      const t0 = process.hrtime()
      const result = await runAndCollect(model, prompt)
      const elapsed = process.hrtime(t0)
      lastResponse = stripInternalBlocks(result.output)

      const s = result.stats || {}
      stats.push({
        turn: i + 1,
        wallMs: hrMs(elapsed),
        promptTokens: s.promptTokens || 0,
        cacheTokens: s.CacheTokens || 0,
        generatedTokens: s.generatedTokens || 0,
        ttft: s.TTFT || 0
      })

      console.log(
        `  Turn ${i + 1}: wall=${hrMs(elapsed)}ms  prompt=${stats[i].promptTokens}  ` +
        `cache=${stats[i].cacheTokens}  gen=${stats[i].generatedTokens}  TTFT=${stats[i].ttft}ms`
      )
    }
  } finally {
    await model.unload()
    await loader.close()
    try { fs.unlinkSync(cachePath) } catch (_) {}
  }

  return stats
}

// ─── Scenario: tools_in_system (same tool every turn, no reset needed) ──────

async function runToolsInSystem (dirPath, modelName) {
  console.log('\n' + '='.repeat(70))
  console.log('SCENARIO B: tools_at_end = false (huge tool ~3000 tokens, cached in system)')
  console.log('='.repeat(70))

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '8192',
    n_predict: '128',
    temp: '0.1',
    seed: '1',
    verbosity: '0',
    tools: 'true',
    tools_at_end: 'false'
  }

  const { model, loader } = await loadModel(dirPath, modelName, config)
  const cachePath = path.join(dirPath, 'huge-tool-in-system.bin')
  try { fs.unlinkSync(cachePath) } catch (_) {}

  const stats = []

  try {
    for (let i = 0; i < NUM_TURNS; i++) {
      // Same tool every turn — no reset needed, tool is cached from turn 1
      const prompt = [
        { role: 'session', content: cachePath },
        ...(i === 0
          ? [{ role: 'system', content: 'You are a helpful enterprise assistant.' }, { role: 'user', content: CONVERSATION_TURNS[i] }]
          : [{ role: 'user', content: CONVERSATION_TURNS[i] }]),
        ...(i === 0 ? [HUGE_TOOL] : [])
      ]

      const t0 = process.hrtime()
      const result = await runAndCollect(model, prompt)
      const elapsed = process.hrtime(t0)

      const s = result.stats || {}
      stats.push({
        turn: i + 1,
        wallMs: hrMs(elapsed),
        promptTokens: s.promptTokens || 0,
        cacheTokens: s.CacheTokens || 0,
        generatedTokens: s.generatedTokens || 0,
        ttft: s.TTFT || 0
      })

      console.log(
        `  Turn ${i + 1}: wall=${hrMs(elapsed)}ms  prompt=${stats[i].promptTokens}  ` +
        `cache=${stats[i].cacheTokens}  gen=${stats[i].generatedTokens}  TTFT=${stats[i].ttft}ms`
      )
    }
  } finally {
    await model.unload()
    await loader.close()
    try { fs.unlinkSync(cachePath) } catch (_) {}
  }

  return stats
}

// ─── Summary ────────────────────────────────────────────────────────────────

function printSummary (statsA, statsB) {
  console.log('\n' + '='.repeat(80))
  console.log('COMPARISON: tools_at_end (A) vs tools_in_system (B) — SAME huge tool, no tool changes')
  console.log('='.repeat(80))
  console.log('')
  console.log('Turn | Wall A    | Wall B    | Cache A | Cache B | Prompt A | Prompt B | TTFT A  | TTFT B')
  console.log('-----|-----------|-----------|---------|---------|----------|----------|---------|--------')

  for (let i = 0; i < statsA.length; i++) {
    const a = statsA[i]
    const b = statsB[i]
    const ttftA = typeof a.ttft === 'number' ? a.ttft.toFixed(0) : String(a.ttft)
    const ttftB = typeof b.ttft === 'number' ? b.ttft.toFixed(0) : String(b.ttft)

    console.log(
      `  ${String(a.turn).padStart(2)} ` +
      `| ${(a.wallMs + 'ms').padStart(9)} ` +
      `| ${(b.wallMs + 'ms').padStart(9)} ` +
      `| ${String(a.cacheTokens).padStart(7)} ` +
      `| ${String(b.cacheTokens).padStart(7)} ` +
      `| ${String(a.promptTokens).padStart(8)} ` +
      `| ${String(b.promptTokens).padStart(8)} ` +
      `| ${ttftA.padStart(7)} ` +
      `| ${ttftB.padStart(7)}`
    )
  }

  console.log('')
  console.log('Key insight: Cache column shows the difference')
  console.log('  - tools_at_end (A): tool tokens are trimmed & re-appended each turn — NOT in cache')
  console.log('  - tools_in_system (B): tool tokens are baked into cache from turn 1 — ~3000 extra tokens cached')
  console.log('')

  const lastA = statsA[statsA.length - 1]
  const lastB = statsB[statsB.length - 1]
  const cacheDiff = lastB.cacheTokens - lastA.cacheTokens
  console.log(`  Final cache: A=${lastA.cacheTokens} tokens, B=${lastB.cacheTokens} tokens`)
  console.log(`  Difference: B has ${cacheDiff} MORE tokens in cache (the huge tool definition)`)
  console.log(`  That's ${((cacheDiff / lastB.cacheTokens) * 100).toFixed(1)}% of B's cache wasted on tool tokens`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main () {
  console.log('Test: huge tool definition (~3000 tokens) — cache impact')
  console.log(`Model: ${MODEL.name}`)
  console.log(`Turns: ${NUM_TURNS}`)
  console.log('')

  const toolJson = JSON.stringify(HUGE_TOOL)
  console.log(`Tool definition size: ${toolJson.length} chars`)

  const [modelName, dirPath] = await downloadModel(MODEL.url, MODEL.name)

  const statsA = await runToolsAtEnd(dirPath, modelName)
  const statsB = await runToolsInSystem(dirPath, modelName)

  printSummary(statsA, statsB)
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
