import { readBody, sendJson, sendError } from '../http.js'
import { resolveModelAlias } from '../config.js'
import { sdkEmbed } from '../sdk.js'

export async function handleEmbeddings (req, res, ctx) {
  const body = await readBody(req)

  if (!body.model) {
    return sendError(res, 400, 'missing_model', '"model" is required.')
  }

  if (!body.input) {
    return sendError(res, 400, 'missing_input', '"input" is required.')
  }

  if (body.encoding_format && body.encoding_format !== 'float') {
    ctx.logger.warn(`Ignoring unsupported encoding_format: ${body.encoding_format}`)
  }

  if (body.dimensions) {
    ctx.logger.warn(`Ignoring unsupported param: dimensions=${body.dimensions}`)
  }

  const modelEntry = resolveModelAlias(ctx.serveConfig, body.model) ?? ctx.registry.getEntry(body.model)

  if (!modelEntry) {
    return sendError(res, 404, 'model_not_found', `Model "${body.model}" is not available. Check serve.models config.`)
  }

  if (modelEntry.endpointCategory !== 'embedding') {
    return sendError(res, 400, 'invalid_model_type', `Model "${body.model}" does not support embeddings.`)
  }

  const registryEntry = ctx.registry.getEntry(modelEntry.alias ?? modelEntry.id)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    return sendError(res, 503, 'model_not_ready', `Model "${body.model}" is not loaded yet.`)
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const modelAlias = modelEntry.alias ?? modelEntry.id
  const inputs = Array.isArray(body.input) ? body.input : [body.input]

  try {
    const embeddings = await sdkEmbed({
      modelId: sdkModelId,
      text: inputs.length === 1 ? inputs[0] : inputs
    })

    const isBatch = Array.isArray(embeddings[0])
    const vectors = isBatch ? embeddings : [embeddings]

    const data = vectors.map((vec, index) => ({
      object: 'embedding',
      index,
      embedding: vec
    }))

    sendJson(res, 200, {
      object: 'list',
      data,
      model: modelAlias,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0
      }
    })
  } catch (err) {
    ctx.logger.error(`Embed error for "${modelAlias}": ${err.message}`)
    sendError(res, 500, 'embed_error', err.message)
  }
}
