import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTestClient, generateSilentWav } from './helpers.js'

const E2E_PORT = 19900
const BASE = `http://127.0.0.1:${E2E_PORT}`
const { req, multipartReq, sseReq } = createTestClient(BASE)

const LLM_ALIAS = 'test-llm'
const EMBED_ALIAS = 'test-embed'
const WHISPER_ALIAS = 'test-whisper'

let server: http.Server

describe('e2e: OpenAI API with real models', { timeout: 600_000 }, () => {
  before(async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'qvac-e2e-test-'))
    const config = {
      serve: {
        models: {
          [LLM_ALIAS]: {
            model: 'QWEN3_600M_INST_Q4',
            preload: true,
            config: { ctx_size: 2048 }
          },
          [EMBED_ALIAS]: {
            model: 'EMBEDDINGGEMMA_300M_Q4_0',
            preload: true
          },
          [WHISPER_ALIAS]: {
            model: 'WHISPER_EN_TINY_Q8_0',
            preload: true
          }
        }
      }
    }
    writeFileSync(path.join(projectRoot, 'qvac.config.json'), JSON.stringify(config))

    const { startServer } = await import('../src/serve/index.js')
    server = await startServer({
      projectRoot,
      port: E2E_PORT,
      host: '127.0.0.1',
      cors: true,
      verbose: false
    })
  })

  after(() => { server?.close() })

  // ── Models ──────────────────────────────────────────────────────────

  describe('GET /v1/models', () => {
    it('lists all loaded models', async () => {
      const res = await req('GET', '/v1/models')
      assert.equal(res.status, 200)
      const data = res.body as { object: string; data: Array<{ id: string; object: string; owned_by: string }> }
      assert.equal(data.object, 'list')
      assert.equal(data.data.length, 3)
      const ids = data.data.map(m => m.id).sort()
      assert.deepEqual(ids, [EMBED_ALIAS, LLM_ALIAS, WHISPER_ALIAS])
      for (const model of data.data) {
        assert.equal(model.object, 'model')
        assert.equal(model.owned_by, 'qvac')
      }
    })
  })

  describe('GET /v1/models/:id', () => {
    it('returns details for a loaded model', async () => {
      const res = await req('GET', `/v1/models/${LLM_ALIAS}`)
      assert.equal(res.status, 200)
      const data = res.body as { id: string; object: string; owned_by: string; created: number }
      assert.equal(data.id, LLM_ALIAS)
      assert.equal(data.object, 'model')
      assert.equal(typeof data.created, 'number')
    })
  })

  // ── Chat completions ───────────────────────────────────────────────

  describe('POST /v1/chat/completions (blocking)', { timeout: 120_000 }, () => {
    it('returns a valid chat completion', async () => {
      const res = await req('POST', '/v1/chat/completions', {
        model: LLM_ALIAS,
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        max_tokens: 16
      })
      assert.equal(res.status, 200)
      const data = res.body as {
        id: string
        object: string
        model: string
        choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }
      assert.ok(data.id.startsWith('chatcmpl-'))
      assert.equal(data.object, 'chat.completion')
      assert.equal(data.model, LLM_ALIAS)
      assert.equal(data.choices.length, 1)
      assert.equal(data.choices[0]!.index, 0)
      assert.equal(data.choices[0]!.message.role, 'assistant')
      assert.equal(typeof data.choices[0]!.message.content, 'string')
      assert.ok(data.choices[0]!.message.content!.length > 0)
      assert.equal(data.choices[0]!.finish_reason, 'stop')
      assert.equal(typeof data.usage.completion_tokens, 'number')
    })

    it('respects max_tokens / max_completion_tokens', async () => {
      const res = await req('POST', '/v1/chat/completions', {
        model: LLM_ALIAS,
        messages: [{ role: 'user', content: 'Write a very long story about a cat.' }],
        max_completion_tokens: 8
      })
      assert.equal(res.status, 200)
      const data = res.body as {
        choices: Array<{ message: { content: string } }>
        usage: { completion_tokens: number }
      }
      assert.ok(data.choices[0]!.message.content!.length > 0)
    })
  })

  describe('POST /v1/chat/completions (streaming)', { timeout: 120_000 }, () => {
    it('returns valid SSE stream', async () => {
      const { chunks, done } = await sseReq('/v1/chat/completions', {
        model: LLM_ALIAS,
        messages: [{ role: 'user', content: 'Say "hi".' }],
        stream: true,
        max_tokens: 16
      })
      assert.ok(done, 'stream should end with [DONE]')
      assert.ok(chunks.length >= 2, 'should have at least role chunk + stop chunk')

      const first = chunks[0]!
      assert.ok(first.id!.startsWith('chatcmpl-'))
      assert.equal(first.object, 'chat.completion.chunk')
      assert.equal(first.model, LLM_ALIAS)
      assert.equal(first.choices![0]!.delta.role, 'assistant')

      const last = chunks[chunks.length - 1]!
      assert.ok(
        last.choices![0]!.finish_reason === 'stop' || last.choices![0]!.finish_reason === 'tool_calls',
        'last chunk should have a finish_reason'
      )

      const contentTokens = chunks.filter(c =>
        c.choices?.[0]?.delta?.content !== undefined && c.choices[0].delta.content !== ''
      )
      assert.ok(contentTokens.length > 0, 'stream should include content tokens')
    })
  })

  // ── Embeddings ─────────────────────────────────────────────────────

  describe('POST /v1/embeddings', { timeout: 120_000 }, () => {
    it('returns embedding vector for single input', async () => {
      const res = await req('POST', '/v1/embeddings', {
        model: EMBED_ALIAS,
        input: 'Hello world'
      })
      assert.equal(res.status, 200)
      const data = res.body as {
        object: string
        data: Array<{ object: string; index: number; embedding: number[] }>
        model: string
        usage: Record<string, number>
      }
      assert.equal(data.object, 'list')
      assert.equal(data.data.length, 1)
      assert.equal(data.data[0]!.object, 'embedding')
      assert.equal(data.data[0]!.index, 0)
      assert.ok(Array.isArray(data.data[0]!.embedding))
      assert.ok(data.data[0]!.embedding.length > 0, 'embedding vector should not be empty')
      assert.equal(typeof data.data[0]!.embedding[0], 'number')
      assert.equal(data.model, EMBED_ALIAS)
    })

    it('returns vectors for batch input', async () => {
      const res = await req('POST', '/v1/embeddings', {
        model: EMBED_ALIAS,
        input: ['Hello', 'World']
      })
      assert.equal(res.status, 200)
      const data = res.body as {
        data: Array<{ index: number; embedding: number[] }>
      }
      assert.equal(data.data.length, 2)
      assert.equal(data.data[0]!.index, 0)
      assert.equal(data.data[1]!.index, 1)
      assert.ok(data.data[0]!.embedding.length > 0)
      assert.equal(data.data[0]!.embedding.length, data.data[1]!.embedding.length, 'vectors should have same dimension')
    })
  })

  // ── Transcriptions ─────────────────────────────────────────────────

  describe('POST /v1/audio/transcriptions', { timeout: 120_000 }, () => {
    it('transcribes audio and returns JSON', async () => {
      const wav = generateSilentWav(1)
      const res = await multipartReq(
        '/v1/audio/transcriptions',
        { model: WHISPER_ALIAS },
        { name: 'silence.wav', data: wav }
      )
      assert.equal(res.status, 200)
      const data = res.body as { text: string }
      assert.equal(typeof data.text, 'string')
    })

    it('returns plain text with response_format=text', async () => {
      const wav = generateSilentWav(1)
      const res = await multipartReq(
        '/v1/audio/transcriptions',
        { model: WHISPER_ALIAS, response_format: 'text' },
        { name: 'silence.wav', data: wav }
      )
      assert.equal(res.status, 200)
      assert.equal(typeof res.body, 'string')
    })
  })

  // ── Cross-endpoint model type validation ───────────────────────────

  describe('model type validation', () => {
    it('chat endpoint rejects embedding model', async () => {
      const res = await req('POST', '/v1/chat/completions', {
        model: EMBED_ALIAS,
        messages: [{ role: 'user', content: 'hi' }]
      })
      assert.equal(res.status, 400)
      const err = (res.body as { error: { code: string } }).error
      assert.equal(err.code, 'invalid_model_type')
    })

    it('embedding endpoint rejects chat model', async () => {
      const res = await req('POST', '/v1/embeddings', {
        model: LLM_ALIAS,
        input: 'hello'
      })
      assert.equal(res.status, 400)
      const err = (res.body as { error: { code: string } }).error
      assert.equal(err.code, 'invalid_model_type')
    })

    it('transcription endpoint rejects chat model', async () => {
      const wav = generateSilentWav(1)
      const res = await multipartReq(
        '/v1/audio/transcriptions',
        { model: LLM_ALIAS },
        { name: 'audio.wav', data: wav }
      )
      assert.equal(res.status, 400)
      const err = (res.body as { error: { code: string } }).error
      assert.equal(err.code, 'invalid_model_type')
    })
  })

  // ── Model lifecycle ────────────────────────────────────────────────

  describe('DELETE /v1/models/:id', () => {
    it('unloads a model and removes from list', async () => {
      const del = await req('DELETE', `/v1/models/${WHISPER_ALIAS}`)
      assert.equal(del.status, 200)
      const data = del.body as { id: string; deleted: boolean }
      assert.equal(data.id, WHISPER_ALIAS)
      assert.equal(data.deleted, true)

      const get = await req('GET', `/v1/models/${WHISPER_ALIAS}`)
      assert.equal(get.status, 404)

      const list = await req('GET', '/v1/models')
      const models = (list.body as { data: Array<{ id: string }> }).data
      assert.ok(!models.some(m => m.id === WHISPER_ALIAS), 'unloaded model should not appear in list')
      assert.equal(models.length, 2)
    })
  })
})
