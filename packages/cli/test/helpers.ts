import assert from 'node:assert/strict'

export function createTestClient (base: string) {
  async function req (
    method: string,
    urlPath: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload
    })
    const text = await res.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed }
  }

  async function multipartReq (
    urlPath: string,
    fields: Record<string, string>,
    file?: { name: string; data: Buffer }
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const boundary = '----TestBoundary' + Math.random().toString(36).slice(2)
    const parts: Buffer[] = []

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ))
    }

    if (file) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ))
      parts.push(file.data)
      parts.push(Buffer.from('\r\n'))
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    const res = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    })
    const text = await res.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed }
  }

  interface SSEChunk {
    id?: string
    object?: string
    model?: string
    choices?: Array<{
      index: number
      delta: Record<string, unknown>
      finish_reason: string | null
    }>
    usage?: Record<string, number>
  }

  async function sseReq (
    urlPath: string,
    body: unknown
  ): Promise<{ chunks: SSEChunk[]; done: boolean }> {
    const res = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    const lines = text.split('\n').filter(l => l.startsWith('data: '))
    const chunks: SSEChunk[] = []
    let done = false
    for (const line of lines) {
      const data = line.slice(6)
      if (data === '[DONE]') { done = true; continue }
      try { chunks.push(JSON.parse(data) as SSEChunk) } catch { /* skip */ }
    }
    return { chunks, done }
  }

  return { req, multipartReq, sseReq }
}

export type TestClient = ReturnType<typeof createTestClient>

export function assertErrorEnvelope (body: unknown, code: string): void {
  assert.ok(typeof body === 'object' && body !== null)
  const err = (body as Record<string, unknown>)['error']
  assert.ok(typeof err === 'object' && err !== null)
  assert.equal((err as Record<string, unknown>)['code'], code)
  assert.ok(typeof (err as Record<string, unknown>)['message'] === 'string')
}

export function generateSilentWav (durationSeconds = 1, sampleRate = 16000): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = Math.floor(durationSeconds * sampleRate * numChannels * (bitsPerSample / 8))
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  return buffer
}
