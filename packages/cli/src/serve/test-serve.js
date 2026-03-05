#!/usr/bin/env node

const BASE = process.argv[2] || 'http://127.0.0.1:11434'

let pass = 0
let fail = 0
let skip = 0

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

function check (label, condition, detail) {
  if (condition) {
    console.log(green(`  ✓ ${label}`))
    pass++
  } else {
    console.log(red(`  ✗ ${label}`))
    if (detail) console.log(dim(`    → ${detail}`))
    fail++
  }
}

function section (res, label) {
  if (res.status !== 200) {
    console.log(dim(`  [HTTP ${res.status}] ${res.text?.slice(0, 200)}`))
  }
}

async function request (path, options = {}) {
  const url = `${BASE}${path}`
  const res = await fetch(url, options)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, text, json, headers: res.headers }
}

async function post (path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function streamPost (path, body) {
  const url = `${BASE}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  const chunks = text.split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => l.slice(6))
  const events = chunks.filter(c => c !== '[DONE]').map(c => {
    try { return JSON.parse(c) } catch { return null }
  }).filter(Boolean)
  const hasDone = chunks.includes('[DONE]')
  return { status: res.status, text, events, hasDone }
}

async function run () {
  console.log(bold(`\nTesting: ${BASE}\n`))

  // ── 1. GET /v1/models ──────────────────────────────────────────
  console.log(bold('1. GET /v1/models'))
  const models = await request('/v1/models')
  check('returns 200', models.status === 200)
  check('object is "list"', models.json?.object === 'list')
  check('data is array', Array.isArray(models.json?.data))

  const allModels = models.json?.data ?? []
  const count = allModels.length
  console.log(dim(`  Found ${count} model(s): ${allModels.map(m => m.id).join(', ') || 'none'}`))

  // Probe models to discover which endpoints they support
  let llm = null
  let embed = null
  for (const m of allModels) {
    if (!llm) {
      const probe = await post('/v1/chat/completions', {
        model: m.id, messages: [{ role: 'user', content: 'hi' }]
      })
      if (probe.status !== 400) llm = m
    }
    if (!embed) {
      const probe = await post('/v1/embeddings', { model: m.id, input: 'hi' })
      if (probe.status !== 400) embed = m
    }
  }
  console.log(dim(`  Detected: chat=${llm?.id ?? 'none'} embedding=${embed?.id ?? 'none'}`))
  console.log()

  // ── 2. GET /v1/models/:id ──────────────────────────────────────
  console.log(bold('2. GET /v1/models/:id'))
  if (llm) {
    const detail = await request(`/v1/models/${llm.id}`)
    check('returns 200', detail.status === 200)
    check('object is "model"', detail.json?.object === 'model')
    check('id matches', detail.json?.id === llm.id)
  } else {
    console.log(yellow('  ⊘ skipped (no LLM model)'))
    skip++
  }

  const notFound = await request('/v1/models/nonexistent-xyz')
  check('404 for unknown model', notFound.status === 404)
  console.log()

  // ── 3. Chat completions (blocking) ─────────────────────────────
  console.log(bold('3. POST /v1/chat/completions (blocking)'))
  if (llm) {
    console.log(dim('  (waiting for blocking response — may take a while on first call...)'))
    const chat = await post('/v1/chat/completions', {
      model: llm.id,
      messages: [{ role: 'user', content: 'Reply with just: hello' }]
    })
    section(chat)
    check('returns 200', chat.status === 200, `got HTTP ${chat.status}: ${chat.text?.slice(0, 200)}`)
    check('object is "chat.completion"', chat.json?.object === 'chat.completion')
    check('has choices', Array.isArray(chat.json?.choices) && chat.json.choices.length > 0)
    check('choice has message', chat.json?.choices?.[0]?.message != null)
    check('message role is "assistant"', chat.json?.choices?.[0]?.message?.role === 'assistant')
    check('message has content', typeof chat.json?.choices?.[0]?.message?.content === 'string')
    check('has usage', chat.json?.usage != null)
    check('has finish_reason', chat.json?.choices?.[0]?.finish_reason != null)

    const content = chat.json?.choices?.[0]?.message?.content ?? ''
    console.log(dim(`  Response: ${content.slice(0, 120)}${content.length > 120 ? '...' : ''}`))
  } else {
    console.log(yellow('  ⊘ skipped (no LLM model)'))
    skip++
  }
  console.log()

  // ── 4. Chat completions (streaming) ────────────────────────────
  console.log(bold('4. POST /v1/chat/completions (streaming)'))
  if (llm) {
    const stream = await streamPost('/v1/chat/completions', {
      model: llm.id,
      messages: [{ role: 'user', content: 'Count from 1 to 3' }],
      stream: true
    })
    check('returns 200', stream.status === 200)
    check('has SSE events', stream.events.length > 0)
    check('events are chat.completion.chunk', stream.events.every(e => e.object === 'chat.completion.chunk'))
    check('has [DONE] sentinel', stream.hasDone)
    check('first event has role delta', stream.events[0]?.choices?.[0]?.delta?.role === 'assistant')

    const tokens = stream.events.filter(e => e.choices?.[0]?.delta?.content).length
    console.log(dim(`  Received ${stream.events.length} chunks (${tokens} with content)`))
  } else {
    console.log(yellow('  ⊘ skipped (no LLM model)'))
    skip++
  }
  console.log()

  // ── 5. Chat with system prompt ─────────────────────────────────
  console.log(bold('5. POST /v1/chat/completions (system prompt)'))
  if (llm) {
    const sys = await post('/v1/chat/completions', {
      model: llm.id,
      messages: [
        { role: 'system', content: 'Always respond with exactly one word.' },
        { role: 'user', content: 'What color is the sky?' }
      ]
    })
    check('returns 200', sys.status === 200)
    check('object is "chat.completion"', sys.json?.object === 'chat.completion')
    check('has content', typeof sys.json?.choices?.[0]?.message?.content === 'string')

    const content = sys.json?.choices?.[0]?.message?.content ?? ''
    console.log(dim(`  Response: ${content.slice(0, 100)}`))
  } else {
    console.log(yellow('  ⊘ skipped (no LLM model)'))
    skip++
  }
  console.log()

  // ── 6. Chat with tool calling ──────────────────────────────────
  console.log(bold('6. POST /v1/chat/completions (tool calling)'))
  if (llm) {
    const tool = await post('/v1/chat/completions', {
      model: llm.id,
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name' } },
            required: ['city']
          }
        }
      }]
    })
    check('returns 200', tool.status === 200)
    check('object is "chat.completion"', tool.json?.object === 'chat.completion')

    const choice = tool.json?.choices?.[0]
    const reason = choice?.finish_reason
    const calls = choice?.message?.tool_calls
    console.log(dim(`  finish_reason: ${reason}`))
    console.log(dim(`  tool_calls: ${calls ? JSON.stringify(calls) : 'none'}`))
    if (calls) {
      check('tool_calls has function type', calls[0]?.type === 'function')
      check('tool_calls has function name', typeof calls[0]?.function?.name === 'string')
      check('finish_reason is "tool_calls"', reason === 'tool_calls')
    }
  } else {
    console.log(yellow('  ⊘ skipped (no LLM model)'))
    skip++
  }
  console.log()

  // ── 7. Embeddings (single) ─────────────────────────────────────
  console.log(bold('7. POST /v1/embeddings (single)'))
  if (embed) {
    const emb = await post('/v1/embeddings', {
      model: embed.id,
      input: 'Hello world'
    })
    check('returns 200', emb.status === 200, `got ${emb.status}: ${emb.text?.slice(0, 150)}`)
    check('object is "list"', emb.json?.object === 'list')
    check('data has 1 embedding', emb.json?.data?.length === 1)
    check('embedding object', emb.json?.data?.[0]?.object === 'embedding')
    check('embedding is array of numbers', Array.isArray(emb.json?.data?.[0]?.embedding) && typeof emb.json?.data?.[0]?.embedding?.[0] === 'number')
    check('has usage', emb.json?.usage != null)

    const dim_ = emb.json?.data?.[0]?.embedding?.length ?? 0
    console.log(dim(`  Embedding dimension: ${dim_}`))
  } else {
    console.log(yellow('  ⊘ skipped (no embedding model)'))
    skip++
  }
  console.log()

  // ── 8. Embeddings (batch) ──────────────────────────────────────
  console.log(bold('8. POST /v1/embeddings (batch)'))
  if (embed) {
    const batch = await post('/v1/embeddings', {
      model: embed.id,
      input: ['Hello', 'World', 'Test']
    })
    check('returns 200', batch.status === 200, `got ${batch.status}: ${batch.text?.slice(0, 150)}`)
    check('object is "list"', batch.json?.object === 'list')
    check('returns 3 embeddings', batch.json?.data?.length === 3)
    check('indexes are 0,1,2', batch.json?.data?.map(d => d.index)?.join(',') === '0,1,2')
  } else {
    console.log(yellow('  ⊘ skipped (no embedding model)'))
    skip++
  }
  console.log()

  // ── 9. Error handling ──────────────────────────────────────────
  console.log(bold('9. Error handling'))

  const err1 = await post('/v1/chat/completions', {
    model: 'nonexistent-xyz',
    messages: [{ role: 'user', content: 'hi' }]
  })
  check('404 for unknown model', err1.status === 404)
  check('has error envelope', err1.json?.error != null)
  check('error has message', typeof err1.json?.error?.message === 'string')
  check('error has code', typeof err1.json?.error?.code === 'string')

  const err2 = await post('/v1/chat/completions', { model: 'test' })
  check('400 for missing messages', err2.status === 400)

  const err3 = await request('/v1/unknown-endpoint')
  check('404 for unknown endpoint', err3.status === 404)

  if (embed) {
    const err4 = await post('/v1/chat/completions', {
      model: embed.id,
      messages: [{ role: 'user', content: 'hi' }]
    })
    check('400 for wrong model type', err4.status === 400)
  }

  if (llm) {
    const err5 = await post('/v1/embeddings', {
      model: llm.id,
      input: 'test'
    })
    check('400 for wrong model type (llm as embed)', err5.status === 400)
  }
  console.log()

  // ── 10. DELETE /v1/models/:id ──────────────────────────────────
  console.log(bold('10. DELETE /v1/models/:id'))

  const del404 = await request('/v1/models/nonexistent-xyz', { method: 'DELETE' })
  check('404 for deleting unknown model', del404.status === 404)
  console.log(dim('  (skipping actual deletion to keep server usable)'))
  console.log()

  // ── Summary ────────────────────────────────────────────────────
  console.log(bold('═══════════════════════════════════════'))
  console.log(green(`  ${pass} passed`))
  if (fail > 0) console.log(red(`  ${fail} failed`))
  if (skip > 0) console.log(yellow(`  ${skip} skipped`))
  console.log(bold('═══════════════════════════════════════'))

  process.exit(fail > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error(red(`\nFatal: ${err.message}`))
  process.exit(2)
})
