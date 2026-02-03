'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

// Helper to check if Chatterbox models exist
function chatterboxModelsExist () {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')
  const requiredFiles = [
    'tokenizer.json',
    'speech_encoder.onnx',
    'embed_tokens.onnx',
    'conditional_decoder.onnx',
    'language_model.onnx'
  ]

  try {
    for (const file of requiredFiles) {
      const filePath = path.join(modelDir, file)
      fs.accessSync(filePath)
    }
    return true
  } catch {
    return false
  }
}

// Helper to check if reference audio exists
function refAudioExists () {
  const baseDir = getBaseDir()
  const refWavPath = path.join(baseDir, 'examples', 'ref.wav')
  try {
    fs.accessSync(refWavPath)
    return true
  } catch {
    return false
  }
}

test('Chatterbox TTS: Basic synthesis test', { timeout: 600000 }, async (t) => {
  // Skip if models or ref audio not available
  if (!chatterboxModelsExist()) {
    t.pass('Skipping: Chatterbox models not found in models/chatterbox/')
    console.log('To run this test, download Chatterbox ONNX models to models/chatterbox/')
    return
  }

  if (!refAudioExists()) {
    t.pass('Skipping: Reference audio not found at examples/ref.wav')
    console.log('To run this test, add a reference WAV file at examples/ref.wav')
    return
  }

  const baseDir = getBaseDir()

  const modelParams = {
    tokenizerPath: path.join(baseDir, 'models', 'chatterbox', 'tokenizer.json'),
    speechEncoderPath: path.join(baseDir, 'models', 'chatterbox', 'speech_encoder.onnx'),
    embedTokensPath: path.join(baseDir, 'models', 'chatterbox', 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(baseDir, 'models', 'chatterbox', 'conditional_decoder.onnx'),
    languageModelPath: path.join(baseDir, 'models', 'chatterbox', 'language_model.onnx'),
    refWavPath: path.join(baseDir, 'examples', 'ref.wav'),
    language: 'en'
  }

  // Load model
  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  // Run synthesis
  console.log('\n=== Running Chatterbox TTS synthesis ===')
  const text = 'Hello world! This is a test of the Chatterbox text to speech system.'

  const expectation = {
    minSamples: 10000, // At least ~0.4 seconds at 24kHz
    maxSamples: 500000, // At most ~20 seconds at 24kHz
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  const result = await runChatterboxTTS(model, { text, saveWav: true }, expectation)
  console.log(result.output)

  t.ok(result.passed, 'Chatterbox TTS synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Chatterbox TTS should produce audio samples')
  t.is(result.data.sampleRate, 24000, 'Sample rate should be 24kHz')

  if (result.data?.stats) {
    console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
  }

  // Unload model
  console.log('\n=== Unloading Chatterbox TTS model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX BASIC TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Text: "${text}"`)
  console.log(`Samples: ${result.data.sampleCount}`)
  console.log(`Duration: ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Sample rate: ${result.data.sampleRate}Hz`)
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Multiple sentences synthesis', { timeout: 900000 }, async (t) => {
  // Skip if models or ref audio not available
  if (!chatterboxModelsExist()) {
    t.pass('Skipping: Chatterbox models not found in models/chatterbox/')
    return
  }

  if (!refAudioExists()) {
    t.pass('Skipping: Reference audio not found at examples/ref.wav')
    return
  }

  const baseDir = getBaseDir()

  const modelParams = {
    tokenizerPath: path.join(baseDir, 'models', 'chatterbox', 'tokenizer.json'),
    speechEncoderPath: path.join(baseDir, 'models', 'chatterbox', 'speech_encoder.onnx'),
    embedTokensPath: path.join(baseDir, 'models', 'chatterbox', 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(baseDir, 'models', 'chatterbox', 'conditional_decoder.onnx'),
    languageModelPath: path.join(baseDir, 'models', 'chatterbox', 'language_model.onnx'),
    refWavPath: path.join(baseDir, 'examples', 'ref.wav'),
    language: 'en'
  }

  const dataset = [
    'The quick brown fox jumps over the lazy dog.',
    'How are you doing today?',
    'Artificial intelligence is transforming the world.',
    'The weather is beautiful outside.'
  ]

  const expectation = {
    minSamples: 5000,
    maxSamples: 300000,
    minDurationMs: 200,
    maxDurationMs: 15000
  }

  // Load model
  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')

  const results = []

  // Run TTS for each text sample
  for (let i = 0; i < dataset.length; i++) {
    const text = dataset[i]
    console.log(`\n--- Chatterbox TTS ${i + 1}/${dataset.length}: "${text}" ---`)

    const result = await runChatterboxTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Chatterbox TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Chatterbox TTS synthesis ${i + 1} should produce samples`)

    results.push({
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs
    })
  }

  // Unload model
  await model.unload()
  console.log('\nChatterbox TTS model unloaded')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${dataset.length}`)
  for (let i = 0; i < results.length; i++) {
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Reference audio is passed correctly', { timeout: 300000 }, async (t) => {
  // Skip if models or ref audio not available
  if (!chatterboxModelsExist()) {
    t.pass('Skipping: Chatterbox models not found in models/chatterbox/')
    return
  }

  if (!refAudioExists()) {
    t.pass('Skipping: Reference audio not found at examples/ref.wav')
    return
  }

  const baseDir = getBaseDir()

  const modelParams = {
    tokenizerPath: path.join(baseDir, 'models', 'chatterbox', 'tokenizer.json'),
    speechEncoderPath: path.join(baseDir, 'models', 'chatterbox', 'speech_encoder.onnx'),
    embedTokensPath: path.join(baseDir, 'models', 'chatterbox', 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(baseDir, 'models', 'chatterbox', 'conditional_decoder.onnx'),
    languageModelPath: path.join(baseDir, 'models', 'chatterbox', 'language_model.onnx'),
    refWavPath: path.join(baseDir, 'examples', 'ref.wav'),
    language: 'en'
  }

  // Load model - this will fail if reference audio is not passed correctly
  // since the C++ side requires non-empty referenceAudio for Chatterbox
  console.log('\n=== Testing reference audio is passed to addon ===')

  let model
  try {
    model = await loadChatterboxTTS(modelParams)
    t.ok(model, 'Model loaded successfully - reference audio was passed correctly')
  } catch (err) {
    t.fail(`Failed to load model: ${err.message}`)
    return
  }

  // Run a simple synthesis to verify the model works with the reference audio
  const result = await runChatterboxTTS(model, { text: 'Test.' }, {})

  if (result.passed && result.data.sampleCount > 0) {
    t.pass('Synthesis succeeded - reference audio is being used correctly')
  } else {
    t.fail(`Synthesis failed: ${result.output}`)
  }

  await model.unload()
  t.pass('Model unloaded')
})
