'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { spawn } = require('bare-subprocess')

const platform = os.platform()
const arch = os.arch()
const isMobile = platform === 'ios' || platform === 'android'

/**
 * Detect current platform string (e.g. 'darwin-arm64')
 * @returns {string}
 */
function detectPlatform () {
  return `${platform}-${arch}`
}

/**
 * Returns standard paths for models and output directories.
 * @returns {{ modelsDir: string, outputDir: string }}
 */
function getTestPaths () {
  const writableRoot = global.testDir || (isMobile ? os.tmpdir() : null)

  let modelsDir, outputDir

  if (isMobile && writableRoot) {
    modelsDir = path.join(writableRoot, 'models')
    outputDir = path.join(writableRoot, 'output')
  } else {
    modelsDir = path.resolve(__dirname, '../../models')
    outputDir = path.resolve(__dirname, '../../output')
  }

  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true })
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  return { modelsDir, outputDir, isMobile }
}

/**
 * Sets up the JS logger bridged into the C++ addon.
 * @param {object} binding - The native binding module
 * @returns {object} The binding with logger configured
 */
function setupJsLogger (binding) {
  const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
  binding.setLogger((priority, message) => {
    const label = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${label}] ${message}`)
  })
  return binding
}

/**
 * Downloads a file from a URL using curl.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
async function downloadFile (url, destPath) {
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['-L', '--progress-bar', '-o', destPath, url])
    curl.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`curl exited with code ${code}`))
    })
    curl.on('error', reject)
  })
}

/**
 * Ensures the SD2.1 Q8_0 model is present in the models directory.
 * Downloads from gpustack HuggingFace if missing.
 * @param {string} modelsDir
 * @returns {Promise<string>} Full path to the model file
 */
async function ensureModelSd2 (modelsDir) {
  const modelFile = 'stable-diffusion-v2-1-Q8_0.gguf'
  const modelPath = path.join(modelsDir, modelFile)

  if (fs.existsSync(modelPath)) {
    console.log(`Model already present: ${modelFile}`)
    return modelPath
  }

  console.log(`Downloading ${modelFile} from HuggingFace...`)
  const url = 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q8_0.gguf'
  await downloadFile(url, modelPath)
  console.log('Download complete.')
  return modelPath
}

/**
 * Checks whether a buffer is a valid PNG by inspecting the magic bytes.
 * PNG files start with: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
 * @param {Uint8Array} buf
 * @returns {boolean}
 */
function isPng (buf) {
  if (!buf || buf.length < 8) return false
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 && // 'P'
    buf[2] === 0x4E && // 'N'
    buf[3] === 0x47 && // 'G'
    buf[4] === 0x0D &&
    buf[5] === 0x0A &&
    buf[6] === 0x1A &&
    buf[7] === 0x0A
  )
}

module.exports = {
  detectPlatform,
  getTestPaths,
  setupJsLogger,
  ensureModelSd2,
  downloadFile,
  isPng,
  isMobile,
  platform,
  arch
}
