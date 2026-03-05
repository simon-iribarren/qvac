import { getSDK } from './sdk.js'

// Maps SDK addon/type names to our internal endpoint categories.
// Routes check against these normalized values, not raw SDK types.
const ENDPOINT_CATEGORY = {
  llm: 'chat',
  'llamacpp-completion': 'chat',
  embeddings: 'embedding',
  embedding: 'embedding',
  'llamacpp-embedding': 'embedding',
  whisper: 'transcription',
  'whispercpp-transcription': 'transcription',
  parakeet: 'transcription',
  'parakeet-transcription': 'transcription',
  nmt: 'translation',
  'nmtcpp-translation': 'translation',
  tts: 'speech',
  'onnx-tts': 'speech',
  ocr: 'ocr',
  'onnx-ocr': 'ocr'
}

export async function parseServeConfig (rawConfig, cliOptions) {
  const serve = rawConfig.serve ?? {}
  const rawModels = serve.models ?? {}

  const models = new Map()
  const registry = await loadModelConstants()

  for (const [alias, entry] of Object.entries(rawModels)) {
    const resolved = typeof entry === 'string'
      ? resolveModelConstant(alias, entry, registry)
      : parseExplicitEntry(alias, entry)

    models.set(alias, resolved)
  }

  if (cliOptions.model) {
    const cliModels = Array.isArray(cliOptions.model) ? cliOptions.model : [cliOptions.model]
    for (const alias of cliModels) {
      const entry = models.get(alias)
      if (entry) {
        entry.preload = true
      }
    }
  }

  return {
    models,
    defaults: resolveDefaults(models)
  }
}

export function normalizeEndpointCategory (sdkType) {
  return ENDPOINT_CATEGORY[sdkType] ?? sdkType
}

function resolveModelConstant (alias, constantName, registry) {
  const model = registry.get(constantName)
  if (!model) {
    throw new Error(
      `serve.models.${alias}: unknown model constant "${constantName}". ` +
      'Use a valid SDK model name (e.g. QWEN3_600M_INST_Q4).'
    )
  }

  return {
    alias,
    src: model.src,
    sdkType: model.addon,
    endpointCategory: normalizeEndpointCategory(model.addon),
    isDefault: false,
    preload: true,
    config: {}
  }
}

function parseExplicitEntry (alias, entry) {
  if (!entry.src) {
    throw new Error(`serve.models.${alias}: "src" is required`)
  }
  if (!entry.type) {
    throw new Error(`serve.models.${alias}: "type" is required`)
  }

  return {
    alias,
    src: entry.src,
    sdkType: entry.type,
    endpointCategory: normalizeEndpointCategory(entry.type),
    isDefault: entry.default === true,
    preload: entry.preload === true,
    config: entry.config ?? {}
  }
}

function resolveDefaults (models) {
  const defaults = new Map()

  for (const [alias, entry] of models) {
    if (entry.isDefault) {
      defaults.set(entry.type, alias)
    }
  }

  return defaults
}

export function resolveModelAlias (serveConfig, modelName) {
  if (!modelName) return null

  const entry = serveConfig.models.get(modelName)
  if (entry) return entry

  for (const [, entry] of serveConfig.models) {
    if (entry.src === modelName) return entry
  }

  return null
}

async function loadModelConstants () {
  const map = new Map()

  try {
    const sdk = await getSDK()
    for (const [key, value] of Object.entries(sdk)) {
      if (value && typeof value === 'object' && 'src' in value && 'addon' in value && 'name' in value) {
        map.set(key, value)
        map.set(value.name, value)
      }
    }
  } catch {
    // SDK not available — only explicit entries will work
  }

  return map
}
