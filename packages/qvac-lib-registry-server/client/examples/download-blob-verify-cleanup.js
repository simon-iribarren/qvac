'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { QVACRegistryClient } = require('../index')
const os = require('os')
const fs = require('fs')

// ggml-tiny-q8_0.bin from output.json (~43MB, 665 blocks)
const WHISPER_TINY_Q8 = {
  coreKey: 'ey46cahego89xox118uhyryakz47bcs8bbxu97tnnpmuwmgi5wmo',
  blockOffset: 0,
  blockLength: 665,
  byteOffset: 0,
  byteLength: 43537433,
  sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca'
}

function getDirSize (dirPath) {
  let totalSize = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(entry.parentPath || entry.path || dirPath, entry.name)
        try {
          totalSize += fs.statSync(fullPath).size
        } catch {}
      }
    }
  } catch {}
  return totalSize
}

function formatBytes (bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run () {
  const tmpStorage = path.join(os.tmpdir(), `qvac-cleanup-test-${Date.now()}`)
  const outputFile = path.join(process.cwd(), 'downloaded', 'cleanup-test.bin')

  fs.mkdirSync(path.dirname(outputFile), { recursive: true })

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  Verify: corestore cleanup via stream (SDK-like behavior)   ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  console.log('  This test mimics how the SDK consumes downloadBlob():')
  console.log('    1. Call downloadBlob() WITHOUT outputFile (returns stream)')
  console.log('    2. Pipe the stream to a file (like the SDK does)')
  console.log('    3. Wait for write to finish')
  console.log('    4. Verify corestore blocks are cleared automatically')
  console.log()
  console.log(`  Corestore path:  ${tmpStorage}`)
  console.log(`  Output file:     ${outputFile}`)
  console.log(`  Model:           Whisper Tiny Q8 (${formatBytes(WHISPER_TINY_Q8.byteLength)})`)
  console.log(`  Blocks:          ${WHISPER_TINY_Q8.blockLength} (offset ${WHISPER_TINY_Q8.blockOffset})`)
  console.log()

  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
    storage: tmpStorage
  })

  console.log('[1/6] Waiting for client.ready()...')
  await client.ready()
  console.log('  --> Client ready')
  console.log()

  const sizeBefore = getDirSize(tmpStorage)
  console.log(`[2/6] Corestore size BEFORE download: ${formatBytes(sizeBefore)}`)
  console.log()

  // --- SDK-like flow: get stream, pipe to file ---
  console.log('[3/6] Calling downloadBlob() in stream mode (no outputFile)...')
  const t0 = Date.now()

  const result = await client.downloadBlob(WHISPER_TINY_Q8, {
    timeout: 120000
  })

  const readStream = result.artifact.stream
  const writeStream = fs.createWriteStream(outputFile)

  let downloadedBytes = 0
  readStream.on('data', (chunk) => {
    downloadedBytes += chunk.length
    const pct = ((downloadedBytes / WHISPER_TINY_Q8.byteLength) * 100).toFixed(1)
    process.stdout.write(`\r  Progress: ${pct}%  ${formatBytes(downloadedBytes)} / ${formatBytes(WHISPER_TINY_Q8.byteLength)}`)
  })

  readStream.pipe(writeStream)

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve)
    writeStream.on('error', reject)
    readStream.on('error', reject)
  })

  const elapsed = Date.now() - t0
  console.log(`\n  --> Download complete in ${(elapsed / 1000).toFixed(2)}s`)
  console.log(`  --> Output: ${outputFile} (${formatBytes(fs.statSync(outputFile).size)})`)
  console.log()

  const sizeRight = getDirSize(tmpStorage)
  console.log(`[4/6] Corestore size RIGHT AFTER pipe finish: ${formatBytes(sizeRight)}`)

  // The 'end' cleanup fires asynchronously — wait for it to complete
  console.log('  --> Waiting 3s for async cleanup (clear + compact)...')
  await sleep(3000)

  const sizeAfter = getDirSize(tmpStorage)
  console.log(`[5/6] Corestore size AFTER cleanup:           ${formatBytes(sizeAfter)}`)
  console.log()

  console.log('─── RESULT ─────────────────────────────────────────────────')
  console.log(`  Before download:      ${formatBytes(sizeBefore)}`)
  console.log(`  After pipe finish:    ${formatBytes(sizeRight)}`)
  console.log(`  After async cleanup:  ${formatBytes(sizeAfter)}`)

  if (sizeAfter < WHISPER_TINY_Q8.byteLength * 0.5) {
    console.log(`\n  >>> PASS: Corestore is ${formatBytes(sizeAfter)} — blob blocks were cleared`)
  } else {
    console.log(`\n  >>> FAIL: Corestore is ${formatBytes(sizeAfter)} — blob blocks were NOT cleared`)
    console.log(`           Expected < ${formatBytes(WHISPER_TINY_Q8.byteLength * 0.5)} (half the model size)`)

    if (sizeRight > WHISPER_TINY_Q8.byteLength * 0.5 && sizeAfter > WHISPER_TINY_Q8.byteLength * 0.5) {
      console.log('           The stream "end" cleanup did not trigger or clear+compact did not run.')
    }
  }

  console.log()
  console.log('[6/6] Cleaning up...')
  await client.close()
  fs.rmSync(tmpStorage, { recursive: true, force: true })
  fs.rmSync(outputFile, { force: true })
  console.log('  --> Done')
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
