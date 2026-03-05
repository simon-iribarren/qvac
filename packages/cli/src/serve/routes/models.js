import { sendJson, sendError } from '../http.js'

export function handleListModels (req, res, ctx) {
  const entries = ctx.registry.getReady()

  sendJson(res, 200, {
    object: 'list',
    data: entries.map(toModelObject)
  })
}

export function handleGetModel (req, res, ctx) {
  const modelId = extractModelId(req.url)
  const entry = ctx.registry.getEntry(modelId)

  if (!entry || entry.state !== ctx.registry.STATES.READY) {
    return sendError(res, 404, 'model_not_found', `Model "${modelId}" not found or not loaded.`)
  }

  sendJson(res, 200, toModelObject(entry))
}

export async function handleDeleteModel (req, res, ctx) {
  const modelId = extractModelId(req.url)
  const entry = ctx.registry.getEntry(modelId)

  if (!entry) {
    return sendError(res, 404, 'model_not_found', `Model "${modelId}" not found.`)
  }

  const { unloadModel } = await import('../lifecycle.js')
  await unloadModel(modelId, ctx.registry, ctx.logger)

  sendJson(res, 200, {
    id: modelId,
    object: 'model',
    deleted: true
  })
}

function extractModelId (url) {
  const path = url.split('?')[0]
  return decodeURIComponent(path.replace('/v1/models/', ''))
}

function toModelObject (entry) {
  return {
    id: entry.id,
    object: 'model',
    created: Math.floor(entry.createdAt / 1000),
    owned_by: 'qvac'
  }
}
