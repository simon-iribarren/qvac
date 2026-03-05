import http from 'node:http'
import { createLogger } from '../logger.js'
import { findConfigFile, loadConfig } from '../config.js'
import { parseServeConfig, resolveModelAlias } from './config.js'
import { createModelRegistry } from './model-registry.js'
import { preloadModels, shutdownSDK } from './lifecycle.js'
import { handleCors, sendJson, sendError } from './http.js'

export async function startServer (options) {
  const logger = createLogger(options.verbose ? 'debug' : 'info')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 11434

  const configPath = findConfigFile(options.projectRoot, options.config)
  const rawConfig = configPath ? await loadConfig(configPath) : {}
  const serveConfig = await parseServeConfig(rawConfig, options)
  const registry = createModelRegistry()

  await preloadModels(serveConfig, registry, logger)

  const server = http.createServer(async (req, res) => {
    if (options.cors) {
      handleCors(req, res)
      if (req.method === 'OPTIONS') return
    }

    if (options.apiKey) {
      const auth = req.headers.authorization
      if (!auth || auth !== `Bearer ${options.apiKey}`) {
        return sendError(res, 401, 'invalid_api_key', 'Invalid or missing API key.')
      }
    }

    try {
      await route(req, res, { registry, serveConfig, logger })
    } catch (err) {
      logger.error(`Unhandled error: ${err.message}`)
      sendError(res, 500, 'internal_error', err.message)
    }
  })

  const shutdown = async () => {
    logger.info('Shutting down...')
    server.close(async () => {
      await shutdownSDK(logger)
      logger.info('Server stopped.')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      logger.info(`QVAC OpenAI-compatible server listening on http://${host}:${port}`)
      logger.info(`Endpoints: POST /v1/chat/completions, POST /v1/embeddings, GET /v1/models`)
      resolve(server)
    })
  })
}

async function route (req, res, ctx) {
  const { url, method } = req
  const path = url.split('?')[0]

  if (method === 'GET' && path === '/v1/models') {
    const { handleListModels } = await import('./routes/models.js')
    return handleListModels(req, res, ctx)
  }

  if (method === 'GET' && path.startsWith('/v1/models/')) {
    const { handleGetModel } = await import('./routes/models.js')
    return handleGetModel(req, res, ctx)
  }

  if (method === 'DELETE' && path.startsWith('/v1/models/')) {
    const { handleDeleteModel } = await import('./routes/models.js')
    return handleDeleteModel(req, res, ctx)
  }

  if (method === 'POST' && path === '/v1/chat/completions') {
    const { handleChatCompletions } = await import('./routes/chat.js')
    return handleChatCompletions(req, res, ctx)
  }

  if (method === 'POST' && path === '/v1/embeddings') {
    const { handleEmbeddings } = await import('./routes/embeddings.js')
    return handleEmbeddings(req, res, ctx)
  }

  sendError(res, 404, 'not_found', `Unknown endpoint: ${method} ${path}`)
}
