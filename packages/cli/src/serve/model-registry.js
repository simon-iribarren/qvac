const STATES = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  UNLOADING: 'unloading',
  ERROR: 'error'
}

export function createModelRegistry () {
  const models = new Map()

  function getEntry (modelId) {
    return models.get(modelId) ?? null
  }

  function getAll () {
    return Array.from(models.values())
  }

  function getReady () {
    return getAll().filter((m) => m.state === STATES.READY)
  }

  function register (alias, { src, sdkType, endpointCategory, config }) {
    if (models.has(alias)) return models.get(alias)

    const entry = {
      id: alias,
      src,
      sdkType,
      endpointCategory,
      config,
      state: STATES.IDLE,
      createdAt: Date.now(),
      error: null,
      sdkModelId: null
    }
    models.set(alias, entry)
    return entry
  }

  function setLoading (modelId) {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.LOADING
      entry.error = null
    }
  }

  function setReady (modelId, sdkModelId) {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.READY
      entry.error = null
      if (sdkModelId) entry.sdkModelId = sdkModelId
    }
  }

  function setError (modelId, error) {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.ERROR
      entry.error = error?.message ?? String(error)
    }
  }

  function remove (modelId) {
    return models.delete(modelId)
  }

  function isAllowed (modelId, serveConfig) {
    if (serveConfig.models.size === 0) return true
    return serveConfig.models.has(modelId)
  }

  return {
    STATES,
    getEntry,
    getAll,
    getReady,
    register,
    setLoading,
    setReady,
    setError,
    remove,
    isAllowed
  }
}
