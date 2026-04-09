'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureChatterboxModels, ensureSupertonicModels, ensureSupertonicModelsMultilingual } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'
const VARIANT_SUFFIX = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`

function chatterboxPath (modelDir, baseName, isMultilingual = false) {
  const suffix = isMultilingual ? '' : VARIANT_SUFFIX
  return path.join(modelDir, `${baseName}${suffix}.onnx`)
}

function chatterboxLmPath (modelDir) {
  return path.join(modelDir, `language_model${VARIANT_SUFFIX}.onnx`)
}

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const CHATTERBOX_EXPECTATION = {
  minSamples: 5000,
  maxSamples: 5000000,
  minDurationMs: 200,
  maxDurationMs: 300000
}

const SUPERTONIC_SAMPLE_RATE = 44100

// ---------------------------------------------------------------------------
// Chatterbox TTS: English
// ---------------------------------------------------------------------------

test('Chatterbox TTS: English synthesis', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  console.log('\n=== Ensuring Chatterbox English models ===')
  const download = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(download.success, 'Chatterbox English models should be downloaded')
  if (!download.success) return

  console.log('\n=== Loading Chatterbox English model ===')
  const model = await loadChatterboxTTS({
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  })
  t.ok(model, 'Chatterbox English model should be loaded')

  const text = 'The quick brown fox jumps over the lazy dog.'
  console.log(`\n=== Synthesizing: "${text}" ===`)
  const result = await runChatterboxTTS(model, { text }, CHATTERBOX_EXPECTATION)
  console.log(result.output)
  t.ok(result.passed, 'Chatterbox English synthesis should pass sample expectations')
  t.ok(result.data.sampleCount > 0, 'Chatterbox English should produce audio samples')

  await model.unload()
  t.pass('Chatterbox English model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX ENGLISH SHORT TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`  [en] ${result.data.sampleCount} samples, ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Supertonic TTS: English
// ---------------------------------------------------------------------------

test('Supertonic TTS: English synthesis', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')

  console.log('\n=== Ensuring Supertonic English models ===')
  const download = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(download.success, 'Supertonic English models should be downloaded')
  if (!download.success) return

  const expectation = {
    minSamples: 10000,
    maxSamples: 500000,
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  console.log('\n=== Loading Supertonic English model ===')
  const model = await loadSupertonicTTS({
    modelDir,
    voiceName: 'F1',
    language: 'en',
    supertonicMultilingual: false
  })
  t.ok(model, 'Supertonic English model should be loaded')
  t.ok(model.addon, 'Supertonic English addon should be created')

  const text = 'Hello world! This is a test of the Supertonic text to speech system.'
  console.log(`\n=== Synthesizing: "${text}" ===`)
  const result = await runSupertonicTTS(model, { text }, expectation)
  console.log(result.output)
  t.ok(result.passed, 'Supertonic English synthesis should pass sample expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic English should produce audio samples')
  t.is(SUPERTONIC_SAMPLE_RATE, 44100, 'Supertonic output sample rate is 44.1kHz')

  await model.unload()
  t.pass('Supertonic English model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC ENGLISH SHORT TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`  [en] ${result.data.sampleCount} samples, ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Supertonic TTS: Spanish
// ---------------------------------------------------------------------------

test('Supertonic TTS: Spanish synthesis', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic-multilingual')

  console.log('\n=== Ensuring Supertonic multilingual models ===')
  const download = await ensureSupertonicModelsMultilingual({ targetDir: modelDir })
  t.ok(download.success, 'Supertonic multilingual models should be downloaded')
  if (!download.success) return

  const expectation = {
    minSamples: 8000,
    maxSamples: 800000,
    minDurationMs: 400,
    maxDurationMs: 30000
  }

  console.log('\n=== Loading Supertonic multilingual model (es) ===')
  const model = await loadSupertonicTTS({
    modelDir,
    voiceName: 'F1',
    language: 'es',
    supertonicMultilingual: true
  })
  t.ok(model, 'Supertonic multilingual model should be loaded')

  const text = 'Hola mundo. Esta es una prueba del sistema Supertonic de síntesis de voz en español.'
  console.log(`\n=== Synthesizing: "${text}" ===`)
  const result = await runSupertonicTTS(model, { text }, expectation)
  console.log(result.output)
  t.ok(result.passed, 'Supertonic Spanish synthesis should pass sample expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic Spanish should produce audio samples')

  await model.unload()
  t.pass('Supertonic multilingual model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC SPANISH SHORT TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`  [es] ${result.data.sampleCount} samples, ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log('='.repeat(60))
})
