'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const IdEnc = require('hypercore-id-encoding')
const os = require('os')

async function example () {
  const tmpStorage = path.join(os.tmpdir(), `qvac-registry-example-${Date.now()}`)
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('Using temporary storage:', tmpStorage)
  console.log('Registry view key:', process.env.QVAC_REGISTRY_CORE_KEY)

  // Wait for client to be ready, then log connection info
  await client.ready()
  const viewCore = client.db.core
  console.log('View core discovery key (DHT topic):', IdEnc.normalize(viewCore.discoveryKey))
  console.log('View core length:', viewCore.length)

  // ========================================
  // NEW SIMPLIFIED API: findBy()
  // ========================================

  // List all models (no filters)
  console.log('\n=== NEW API: findBy() ===')
  console.log('\n--- findBy() with no params (list all) ---')
  const allModels = await client.findBy()
  console.log('Total models found:', allModels.length)
  const totalBytes = allModels.reduce((sum, m) => sum + (m.blobBinding?.byteLength || 0), 0)
  console.log('Total size:', totalBytes, 'bytes', (totalBytes / 1024 / 1024 / 1024).toFixed(2), 'GB')

  // Get a specific model
  if (allModels.length > 0) {
    console.log('\n--- getModel() ---')
    const { path: modelPath, source: modelSource } = allModels[0]
    const model = await client.getModel(modelPath, modelSource)
    console.log('Found model:', model?.path, model?.engine)
  }

  // Find by engine
  console.log('\n--- findBy({ engine }) ---')
  const whisperModels = await client.findBy({ engine: '@qvac/transcription-whispercpp' })
  console.log('Found whisper models:', whisperModels.length)

  // Find by name (partial match)
  console.log('\n--- findBy({ name }) ---')
  const llamaModels = await client.findBy({ name: 'llama' })
  console.log('Found llama models:', llamaModels.length)

  // Find by quantization
  console.log('\n--- findBy({ quantization }) ---')
  const q4Models = await client.findBy({ quantization: 'q4' })
  console.log('Found q4 quantized models:', q4Models.length)

  // Combined filters
  console.log('\n--- findBy({ engine, quantization }) ---')
  const llmQ4Models = await client.findBy({
    engine: '@qvac/llm-llamacpp',
    quantization: 'q4'
  })
  console.log('Found LLM models with q4 quantization:', llmQ4Models.length)

  // Include deprecated models
  console.log('\n--- findBy({ includeDeprecated: true }) ---')
  const allIncludingDeprecated = await client.findBy({ includeDeprecated: true })
  console.log('Total models (including deprecated):', allIncludingDeprecated.length)

  // ========================================
  // LEGACY API: findModels*, findModelsByEngine, etc.
  // ========================================

  console.log('\n=== LEGACY API ===')

  // Find all models using legacy API
  console.log('\n--- findModels({}) ---')
  const allModelsLegacy = await client.findModels({})
  console.log('Total models found (legacy):', allModelsLegacy.length)

  // Find by engine using legacy API
  console.log('\n--- findModelsByEngine() ---')
  const modelsByEngine = await client.findModelsByEngine({
    gte: { engine: '@qvac/transcription-whispercpp' },
    lte: { engine: '@qvac/transcription-whispercpp' }
  })
  console.log('Found models by engine (legacy):', modelsByEngine.length)

  // Find by quantization using legacy API
  console.log('\n--- findModelsByQuantization() ---')
  const modelsByQuant = await client.findModelsByQuantization({
    gte: { quantization: 'q4_0' },
    lte: { quantization: 'q4_0' }
  })
  console.log('Found models by quantization "q4_0" (legacy):', modelsByQuant.length)

  // Client-side filtering for non-indexed fields
  console.log('\n--- Client-side filtering ---')
  const modelsBySource = allModels.filter(m => m.source === 'hf')
  console.log('Found models by source "hf":', modelsBySource.length)

  await client.close()
}

example().catch(console.error)
