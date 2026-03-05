import { sdkLoadModel, sdkUnloadModel, sdkClose } from './sdk.js'

export async function preloadModels (serveConfig, registry, logger) {
  const toPreload = []

  for (const [alias, entry] of serveConfig.models) {
    registry.register(alias, entry)
    if (entry.preload) {
      toPreload.push(alias)
    }
  }

  if (toPreload.length === 0) {
    logger.info('No models configured for preload.')
    return
  }

  logger.info(`Preloading ${toPreload.length} model(s): ${toPreload.join(', ')}`)

  for (const alias of toPreload) {
    try {
      await loadModel(alias, registry, logger)
    } catch (err) {
      logger.error(`Failed to preload "${alias}": ${err.message}`)
    }
  }
}

export async function loadModel (alias, registry, logger) {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not registered`)

  if (entry.state === registry.STATES.READY) {
    logger.debug(`Model "${alias}" already loaded.`)
    return entry
  }

  if (entry.state === registry.STATES.LOADING) {
    logger.debug(`Model "${alias}" is already loading, skipping.`)
    return entry
  }

  logger.info(`Loading model "${alias}" from ${entry.src}...`)
  registry.setLoading(alias)

  try {
    const sdkModelId = await sdkLoadModel({
      src: entry.src,
      type: entry.sdkType,
      config: entry.config
    })
    registry.setReady(alias, sdkModelId)
    logger.info(`Model "${alias}" loaded (SDK modelId: ${sdkModelId}).`)
  } catch (err) {
    registry.setError(alias, err)
    throw err
  }

  return registry.getEntry(alias)
}

export async function unloadModel (alias, registry, logger) {
  const entry = registry.getEntry(alias)
  if (!entry) throw new Error(`Model "${alias}" not found`)

  if (entry.sdkModelId) {
    try {
      await sdkUnloadModel(entry.sdkModelId)
    } catch (err) {
      logger.warn(`SDK unload for "${alias}" failed: ${err.message}`)
    }
  }

  logger.info(`Unloaded model "${alias}".`)
  registry.remove(alias)
}

export async function shutdownSDK (logger) {
  try {
    await sdkClose()
    logger.info('SDK connection closed.')
  } catch (err) {
    logger.warn(`SDK close error: ${err.message}`)
  }
}
