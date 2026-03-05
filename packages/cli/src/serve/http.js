export function handleCors (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
  }
}

export function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson (res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export function sendError (res, status, code, message) {
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
  })
}

export function sendSSE (res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function endSSE (res) {
  res.write('data: [DONE]\n\n')
  res.end()
}

export function initSSE (res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
}
