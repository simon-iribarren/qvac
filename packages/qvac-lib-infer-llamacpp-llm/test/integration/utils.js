'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const os = require('bare-os')

const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const isAndroid = os.platform() === 'android'

/** 30 min on mobile (slow model download), configurable on desktop */
function getTestTimeout (desktopMs = 600_000) {
  return isMobile ? 1_800_000 : desktopMs
}

const DOWNLOAD_TIMEOUT_MS = 600_000
const MAX_RETRIES = 3
const PROGRESS_INTERVAL_MS = 15_000
const ANDROID_PRE_STAGED_DIR = '/data/local/tmp/qvac-test-models'

async function downloadFile (url, dest) {
  return new Promise((resolve, reject) => {
    let resolved = false
    let progressTimer = null
    let timeoutTimer = null

    const cleanup = () => {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
    }

    const safeResolve = () => {
      if (!resolved) {
        resolved = true
        cleanup()
        resolve()
      }
    }
    const safeReject = (err) => {
      if (!resolved) {
        resolved = true
        cleanup()
        reject(err)
      }
    }

    const file = fs.createWriteStream(dest)

    timeoutTimer = setTimeout(() => {
      console.error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s`)
      try { file.destroy() } catch (_) {}
      try { req.destroy() } catch (_) {}
      fs.unlink(dest, () => safeReject(new Error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s for ${url}`)))
    }, DOWNLOAD_TIMEOUT_MS)

    file.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    const req = https.request(url, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        cleanup()
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            return safeReject(unlinkErr)
          }

          let redirectUrl = response.headers.location
          if (redirectUrl.startsWith('/')) {
            const originalUrl = new URL(url)
            redirectUrl = `${originalUrl.protocol}//${originalUrl.host}${redirectUrl}`
          }

          downloadFile(redirectUrl, dest)
            .then(safeResolve)
            .catch(safeReject)
        })
        return
      }

      if (response.statusCode !== 200) {
        file.destroy()
        fs.unlink(dest, () => safeReject(new Error(`Download failed: HTTP ${response.statusCode} from ${url}`)))
        return
      }

      const contentLength = parseInt(response.headers['content-length'], 10) || null
      if (contentLength) {
        console.log(`Download started: ${(contentLength / 1024 / 1024).toFixed(1)}MB`)
      } else {
        console.log('Download started (unknown size)')
      }

      progressTimer = setInterval(() => {
        try {
          if (fs.existsSync(dest)) {
            const st = fs.statSync(dest)
            const mb = (st.size / 1024 / 1024).toFixed(1)
            if (contentLength) {
              const pct = ((st.size / contentLength) * 100).toFixed(1)
              console.log(`Download progress: ${mb}MB / ${(contentLength / 1024 / 1024).toFixed(1)}MB (${pct}%)`)
            } else {
              console.log(`Download progress: ${mb}MB`)
            }
          }
        } catch (_) {}
      }, PROGRESS_INTERVAL_MS)

      response.on('error', (err) => {
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })

      response.pipe(file)

      file.on('close', () => {
        safeResolve()
      })
    })

    req.on('error', err => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    req.end()
  })
}

function findPreStagedModel (modelName) {
  if (!isAndroid) return null
  try {
    const staged = `${ANDROID_PRE_STAGED_DIR}/${modelName}`
    if (fs.existsSync(staged)) {
      const st = fs.statSync(staged)
      if (st.size > 0) return staged
    }
  } catch (_) {}
  return null
}

async function ensureModel ({ modelName, downloadUrl }) {
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, modelName)

  if (fs.existsSync(modelPath)) {
    try {
      const st = fs.statSync(modelPath)
      if (st.size > 0) return [modelName, modelDir]
      fs.unlinkSync(modelPath)
    } catch (_) {}
  }

  const preStagedPath = findPreStagedModel(modelName)
  if (preStagedPath) {
    console.log(`Found pre-staged model at ${preStagedPath}`)
    fs.mkdirSync(modelDir, { recursive: true })
    try {
      const src = fs.createReadStream(preStagedPath)
      const dst = fs.createWriteStream(modelPath)
      await new Promise((resolve, reject) => {
        src.on('error', reject)
        dst.on('error', reject)
        dst.on('close', resolve)
        src.pipe(dst)
      })
      const st = fs.statSync(modelPath)
      console.log(`Model ready (pre-staged): ${(st.size / 1024 / 1024).toFixed(1)}MB`)
      return [modelName, modelDir]
    } catch (err) {
      console.error(`Failed to copy pre-staged model: ${err.message}`)
      try { fs.unlinkSync(modelPath) } catch (_) {}
    }
  }

  fs.mkdirSync(modelDir, { recursive: true })

  let lastError = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Downloading ${modelName} (attempt ${attempt}/${MAX_RETRIES})...`)
      await downloadFile(downloadUrl, modelPath)

      if (!fs.existsSync(modelPath)) {
        throw new Error(`File not found after download: ${modelPath}`)
      }
      const st = fs.statSync(modelPath)
      if (st.size === 0) {
        fs.unlinkSync(modelPath)
        throw new Error('Downloaded file is empty (0 bytes)')
      }

      console.log(`Model ready: ${(st.size / 1024 / 1024).toFixed(1)}MB`)
      return [modelName, modelDir]
    } catch (err) {
      lastError = err
      console.error(`Download attempt ${attempt} failed: ${err.message}`)
      try { fs.unlinkSync(modelPath) } catch (_) {}

      if (attempt < MAX_RETRIES) {
        const delay = attempt * 10_000
        console.log(`Retrying in ${delay / 1000}s...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw new Error(`Failed to download ${modelName} after ${MAX_RETRIES} attempts: ${lastError ? lastError.message : 'unknown error'}`)
}

async function ensureModelPath ({ modelName, downloadUrl }) {
  const [downloadedModelName, modelDir] = await ensureModel({ modelName, downloadUrl })
  return path.join(modelDir, downloadedModelName)
}

/**
 * Get path to a media file - works on both desktop and mobile
 * On mobile, media files must be in testAssets/
 * On desktop, media files are in addon root /media/
 *
 * @param {string} filename - Name of the media file (e.g., 'elephant.jpg')
 * @returns {string} - Full path to the media file
 *
 * @example
 * const imagePath = getMediaPath('elephant.jpg')
 * const imageBytes = fs.readFileSync(imagePath)
 */
function getMediaPath (filename) {
  // Mobile environment - use asset loading from testAssets
  if (isMobile && global.assetPaths) {
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      const resolvedPath = global.assetPaths[projectPath].replace('file://', '')
      return resolvedPath
    }
    // Asset not found in manifest
    throw new Error(`Asset not found in testAssets: ${filename}. Make sure ${filename} is in testAssets/ directory and rebuild the app.`)
  }

  // Desktop environment - use media directory at addon root
  return path.resolve(__dirname, '../../media', filename)
}

/**
 * Factory to create a shared onOutput handler and expose collected state.
 * Used in tests to capture and track LLM output events.
 *
 * @param {object} t - Test instance
 * @param {object} [logger=console] - Logger instance with a `log` method
 * @returns {{
 *   onOutput: (addon: object, event: string, jobId: string, output: string, error: string) => void,
 *   outputText: Object<string, string>,
 *   generatedText: string,
 *   jobCompleted: boolean,
 *   timeToFirstToken: number | null,
 *   stats: object | null,
 *   setStartTime: (time: number) => void
 * }} An object containing:
 *   - `onOutput` - Callback to handle addon output events ('Output', 'Error', 'JobEnded')
 *   - `outputText` - Map of jobId to accumulated output text
 *   - `generatedText` - All generated text concatenated
 *   - `jobCompleted` - Flag indicating if the job has finished
 *   - `timeToFirstToken` - Time to first token in milliseconds
 *   - `stats` - Stats object from the job
 *   - `setStartTime` - Function to set the start time for timeToFirstToken calculation
 *
 * @example
 * const collector = makeOutputCollector(t)
 * addon.setOnOutputCb(collector.onOutput)
 * // ... run inference ...
 * console.log(collector.generatedText)
 */
function makeOutputCollector (t, logger = console) {
  const outputText = {}
  let jobCompleted = false
  let generatedText = ''
  let timeToFirstToken = null
  let startTime = null
  let stats = null

  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Output') {
      if (!outputText[jobId]) {
        outputText[jobId] = ''
        // Record time to first token (manual fallback)
        if (startTime && timeToFirstToken === null) {
          timeToFirstToken = Date.now() - startTime
        }
      }
      outputText[jobId] += output
      generatedText += output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      // Capture stats from the data parameter (output is actually the data/stats object in JobEnded)
      stats = output
      logger.log(`Job ${jobId} completed. Output: "${outputText[jobId]}"`)
      if (stats) {
        logger.log(`Job ${jobId} stats: ${JSON.stringify(stats)}`)
      }
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputText,
    get generatedText () { return generatedText },
    get jobCompleted () { return jobCompleted },
    get timeToFirstToken () { return timeToFirstToken },
    get stats () { return stats },
    setStartTime (time) { startTime = time }
  }
}

module.exports = {
  ensureModel,
  ensureModelPath,
  getMediaPath,
  getTestTimeout,
  makeOutputCollector
}
