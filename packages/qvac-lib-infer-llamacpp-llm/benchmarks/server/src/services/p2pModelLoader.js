'use strict'

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const HyperDriveDL = require('@tetherto/qvac-lib-dl-hyperdrive')
const LlmLlamacpp = require('@tetherto/llm-llamacpp')
const logger = require('../utils/logger')
const path = require('path')

// --- P2P Infrastructure Initialization (like quickstart.js) ---
const storeDir = path.resolve(__dirname, '../../../store')
const store = new Corestore(storeDir)
const dbStore = store.namespace('db')
const swarm = new Hyperswarm()

swarm.on('connection', conn => {
  logger.info('New swarm connection established')
  dbStore.replicate(conn)
})

const core = dbStore.get({
  key: Buffer.from('6d15c77f4bbfbe61f761307faa07a2657a5e5060e1d2336bf16fb8074e662fb3', 'hex')
})

const p2pReady = (async () => {
  await core.ready()
  const foundPeers = dbStore.findingPeers()
  swarm.join(core.discoveryKey)
  await swarm.flush()
  await foundPeers()
  logger.info('P2P infrastructure ready')
})()

const hdStore = store.namespace('hd')

// --- Model Management ---
let p2pModel = null
let p2pModelId = null
let isLoading = false
let loadingPromise = null

/**
 * Loads a model using P2P (Hyperdrive) approach
 * @param {Object} options - P2P loading options
 * @returns {Promise<Object>} Model instance
 */
const loadP2PModel = async (options) => {
  await p2pReady // Ensure P2P infra is ready
  const { hyperdriveKey, modelName, modelConfig } = options
  if (!hyperdriveKey || !modelName) {
    const errMsg = 'Both hyperdriveKey and modelName must be provided.'
    logger.error(errMsg)
    throw new Error(errMsg)
  }
  const modelId = `${hyperdriveKey}-${modelName}`

  logger.info('=== loadP2PModel called ===')
  logger.info(`Options: ${JSON.stringify(options, null, 2)}`)
  logger.info(`Model ID: ${modelId}`)
  logger.info(`ModelConfig: ${JSON.stringify(modelConfig, null, 2)}`)

  // If already loading the same model, wait for that to complete
  if (isLoading && loadingPromise && p2pModelId === modelId) {
    logger.info('Model is already loading, waiting for completion...')
    try {
      const result = await loadingPromise
      return result
    } catch (error) {
      logger.error('Previous loading attempt failed:', error)
      // Continue with new loading attempt
    }
  }

  // Check if we already have a model loaded
  if (p2pModel) {
    logger.info(`Existing model found with ID: ${p2pModelId}`)
    logger.info(`Requested model ID: ${modelId}`)
    if (p2pModelId === modelId) {
      logger.info('✅ Using cached P2P model instance (same model)')
      return p2pModel
    } else {
      logger.info('⚠️ Different model requested, will unload current model')
      try {
        await p2pModel.unload()
        logger.info('Previous model unloaded successfully')
      } catch (error) {
        logger.error('Error unloading previous model:', error)
      }
      p2pModel = null
      p2pModelId = null
    }
  } else {
    logger.info('No existing model found, will load new model')
  }

  // Set loading state and promise
  isLoading = true
  loadingPromise = (async () => {
    logger.info('Loading new P2P model instance')
    logger.info(`Hyperdrive key: ${hyperdriveKey}`)
    logger.info(`Model name: ${modelName}`)

    // Create a Hyperdrive Dataloader instance for this model
    const hdDL = new HyperDriveDL({
      key: hyperdriveKey,
      store: hdStore
    })
    logger.info('HyperDriveDL created successfully')

    // Create a LlmLlamacpp instance
    const args = {
      loader: hdDL,
      opts: { stats: true },
      logger: console,
      // saveWeightsToDisk: true,
      diskPath: './p2p-models/',
      modelName
    }
    const config = {
      gpu_layers: modelConfig?.gpu_layers || '32',
      ctx_size: modelConfig?.ctx_size || '1024',
      ...modelConfig
    }
    logger.info('LlmLlamacpp config prepared:', JSON.stringify(config, null, 2))
    logger.info('Instantiating LlmLlamacpp...')
    const model = new LlmLlamacpp(args, config)
    logger.info('LlmLlamacpp instance created')
    logger.info('Loading model...')
    await model.load()
    logger.info('Model loaded successfully!')

    // Cache the model
    p2pModel = model
    p2pModelId = modelId

    return model
  })()

  try {
    const model = await loadingPromise
    return model
  } catch (error) {
    logger.error('Failed to load P2P model:', error)
    throw error
  } finally {
    isLoading = false
    loadingPromise = null
  }
}

const getP2PModel = () => {
  if (!p2pModel) {
    throw new Error('No P2P model loaded. Call loadP2PModel first.')
  }
  return p2pModel
}

const isModelLoading = () => {
  return isLoading
}

const clearP2PModel = () => {
  if (p2pModel) {
    try {
      p2pModel.unload()
      logger.info('✅ P2P model unloaded and cache cleared')
    } catch (error) {
      logger.error('Error unloading P2P model:', error)
    }
    p2pModel = null
    p2pModelId = null
  }
  isLoading = false
  loadingPromise = null
}

const getModelStatus = () => {
  return {
    isLoaded: !!p2pModel,
    modelId: p2pModelId,
    isLoading
  }
}

module.exports = {
  loadP2PModel,
  getP2PModel,
  isModelLoading,
  clearP2PModel,
  getModelStatus,
  swarm,
  store,
  hdStore
}
