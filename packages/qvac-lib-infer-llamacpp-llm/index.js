'use strict'

const path = require('bare-path')

const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { LlamaInterface } = require('./addon')

const END_OF_INPUT = 'end of job'
const noop = () => { }

/**
 * GGML client implementation for Llama LLM model
 */
class LlmLlamacpp extends BaseInference {
  /**
   * Creates an instance of LlmLlamacpp.
   * @constructor
   * @param {Object} args - Setup parameters including loader, logger, disk path, and model name
   * @param {Loader} args.loader - External loader instance
   * @param {Logger} [args.logger] - Optional structured logger
   * @param {Object} [args.opts] - Optional inference options
   * @param {string} args.diskPath - Disk directory where model files are stored
   * @param {string} args.modelName - Name of the model directory or file. The usage of a sharded
   * filename (e.g. "llama-00001-of-00004.gguf") will trigger asynchronous loading of the weights for
   * all remaining files.
   * @param {string} args.projectionModel - Name of the projection model directory or file
   * @param {Object} config - Model-specific configuration settings
   */
  constructor (
    { opts = {}, loader, logger = null, diskPath = '.', modelName, projectionModel },
    config,
    finetuningParams = null
  ) {
    super({ logger, opts })
    this._config = config
    this._diskPath = diskPath
    this._modelName = modelName
    this._projectionModel = projectionModel
    // _shards will be null if the modelName is not a sharded file.
    this._shards = WeightsProvider.expandGGUFIntoShards(this._modelName)
    this.weightsProvider = new WeightsProvider(loader, this.logger)
    this._runQueueWaiter = Promise.resolve()
    this._defaultFinetuneParams = finetuningParams ?? null
  }

  /**
   * Load model weights, initialize the native addon, and activate the model.
   * @param {boolean} [closeLoader=true] - Whether to close the loader when complete
   * @param {ProgressReportCallback} [onDownloadProgress] - Optional byte-level progress callback
   * @returns {Promise<void>}
   */
  async _load (closeLoader = true, onDownloadProgress = noop) {
    this.logger.info('Starting model load')

    try {
      const configForLoad = { ...this._config }
      const shouldDisableFlashAttn = this._defaultFinetuneParams !== null
      if (shouldDisableFlashAttn) {
        const hasFlashSetting = Object.prototype.hasOwnProperty.call(configForLoad, 'flash_attn')
        const requestedValue = hasFlashSetting ? configForLoad.flash_attn : undefined
        if (requestedValue !== 'off') {
          configForLoad.flash_attn = 'off'
        }
      }

      const configurationParams = {
        path: path.join(this._diskPath, this._modelName),
        projectionPath: this._projectionModel ? path.join(this._diskPath, this._projectionModel) : '',
        config: configForLoad
      }

      this.logger.info('Creating addon with configuration:', configurationParams)
      this.addon = this._createAddon(configurationParams, this._defaultFinetuneParams)

      if (this._shards !== null) {
        await this._loadWeights(onDownloadProgress)
      } else {
        await this.downloadWeights(onDownloadProgress, { closeLoader })
      }

      this.logger.info('Activating addon')
      await this.addon.activate()

      this.logger.info('Model load completed successfully')
    } catch (error) {
      this.logger.error('Error during model load:', error)
      throw error
    }
  }

  /**
   * Download the model weight files and return the local path to the primary file.
   * @param {ProgressReportCallback} [onDownloadProgress] - Callback invoked with bytes downloaded
   * @returns {Promise<{filePath: string, completed: boolean, error: boolean}[]>} Local file path for the model weights
   */
  async _downloadWeights (onDownloadProgress, opts) {
    return await this.weightsProvider.downloadFiles(
      this._projectionModel ? [this._modelName, this._projectionModel] : [this._modelName],
      this._diskPath,
      {
        closeLoader: opts.closeLoader,
        onDownloadProgress
      }
    )
  }

  async _loadWeights (reportProgressCallback) {
    const onChunk = async (chunkedWeightsData) => {
      this.addon.loadWeights(chunkedWeightsData, this.logger)
    }
    await this.weightsProvider.streamFiles(this._shards, onChunk, reportProgressCallback)
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.settings - LLM-specific settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon (configurationParams, finetuningParams = null) {
    this.logger.info(
      'Creating Llama interface with configuration:',
      configurationParams
    )
    const binding = require('./binding')
    const transitionCb = this.logger && typeof this.logger.info === 'function'
      ? this.logger.info.bind(this.logger)
      : null

    // Wrap _outputCallback to capture log messages
    const originalOutputCb = this._outputCallback?.bind(this)
    const wrappedOutputCb = (instance, eventType, jobId, data, extra) => {
      if (eventType === 'LogMsg') {
        const logMsg = typeof data === 'string' ? data : (data?.message || JSON.stringify(data))
        this.logger?.info?.(logMsg)
        // Don't call originalOutputCb for LogMsg to avoid duplicate logging
        return
      }
      if (originalOutputCb) {
        return originalOutputCb(instance, eventType, jobId, data, extra)
      }
    }

    return new LlamaInterface(
      binding,
      configurationParams,
      wrappedOutputCb,
      transitionCb,
      finetuningParams
    )
  }

  async _withExclusiveRun (fn) {
    const prev = this._runQueueWaiter || Promise.resolve()
    let release
    this._runQueueWaiter = new Promise(resolve => { release = resolve })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Internal method to start inference with a text prompt.
   * @param {Message[]} prompt - Input prompt array of messages
   * @returns {Promise<QvacResponse>} A QvacResponse representing the inference job
   */
  async _runInternal (prompt) {
    this.logger.info('Starting inference with prompt:', prompt)
    return this._withExclusiveRun(async () => {
      // Process prompt to handle media content with user role
      const processedPrompt = prompt.map(message => {
        // Check if message has user role and media type with Uint8Array content
        if (message.role === 'user' &&
          message.type === 'media' &&
          message.content instanceof Uint8Array) {
          // Send media data as separate append call
          this.addon.append({ type: 'media', input: message.content })
            .catch(err => this.logger.error('Failed to send media data:', err))

          // Return modified message with empty string for media content
          return {
            ...message,
            content: ''
          }
        }

        return message
      })

      const serializedPrompt = JSON.stringify(processedPrompt)

      const jobId = await this.addon.append({ type: 'text', input: serializedPrompt })

      this.logger.info('Created inference job with ID:', jobId)

      const response = this._createResponse(jobId)
      await this.addon.append({ type: END_OF_INPUT })

      this.logger.info('Inference job started successfully')

      return response
    })
  }

  async finetune (finetuningOptions = undefined) {
    this.logger?.info?.('finetune() called')
    const params = finetuningOptions ?? this._defaultFinetuneParams
    if (!params) {
      throw new Error('Finetuning parameters are required but not provided.')
    }

    this._defaultFinetuneParams = params
    this.logger?.info?.('Finetuning parameters:', params)

    if (!this.addon) {
      this.logger?.info?.('Addon not loaded, calling load()...')
      await this.load()
      this.logger?.info?.('Addon loaded')
    }

    return this._withExclusiveRun(async () => {
      this.logger?.info?.('Calling addon.finetune()...')
      await this.addon.finetune(params)
      this.logger?.info?.('addon.finetune() returned, waiting for completion...')
      const finalStatus = await this._waitForFinetuneCompletion()
      this.logger?.info?.(`Finetuning completed with status: ${finalStatus}`)
      return { status: finalStatus }
    })
  }

  async _waitForFinetuneCompletion ({ pollIntervalMs = 500, timeoutMs = 100000000000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let sawFinetuneState = false

    while (Date.now() <= deadline) {
      const status = await this.addon.status()
      if (status === 'FINETUNING') {
        sawFinetuneState = true
      } else if (sawFinetuneState) {
        // Only return on terminal states (IDLE = completion, not PAUSED)
        // PAUSED is a temporary state - training can resume, so keep waiting
        if (status === 'PAUSED') {
          // Continue waiting - training may resume
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
          continue
        }
        // Return on other terminal states (IDLE, ERROR, etc.)
        return status
      } else if (status !== 'LOADING') {
        return status
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error('Time out')
  }

  /**
   * Pause finetuning. Saves checkpoint and pauses training.
   * @returns {Promise<void>}
   */
  async pauseFinetune () {
    if (!this.addon) {
      throw new Error('Addon not initialized')
    }
    await this.addon.pause()
  }

  /**
   * Resume finetuning from pause checkpoint.
   * @returns {Promise<void>}
   */
  async resumeFinetune () {
    if (!this.addon) {
      throw new Error('Addon not initialized')
    }
    await this.addon.activate()
  }
}

module.exports = LlmLlamacpp
