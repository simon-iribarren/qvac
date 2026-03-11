#!/usr/bin/env node
'use strict'

// Cross-platform runner for integration tests. Spawns bare run-all.js; when tests
// complete, run-all.js writes .exit-code. We detect that, kill bare, and exit
// with the correct code. Handles native addon keeping event loop alive after tests.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TEST_DIR = path.join(__dirname, '..', 'test', 'integration')
const EXIT_CODE_FILE = path.join(TEST_DIR, '.exit-code')
const TIMEOUT_MS = (parseInt(process.env.INTEGRATION_TEST_TIMEOUT, 10) || 10800) * 1000 // 3h default

function main () {
  try {
    fs.unlinkSync(EXIT_CODE_FILE)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }

  const bare = spawn('bare', ['test/integration/run-all.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: true
  })

  const start = Date.now()
  const poll = setInterval(() => {
    if (Date.now() - start > TIMEOUT_MS) {
      clearInterval(poll)
      bare.kill('SIGKILL')
      console.error('# integration-test timeout — forcing exit')
      process.exit(1)
    }
    try {
      if (fs.existsSync(EXIT_CODE_FILE)) {
        clearInterval(poll)
        bare.kill('SIGTERM')
        setTimeout(() => { bare.kill('SIGKILL') }, 2000)
      }
    } catch (_) {}
  }, 1000)

  bare.on('exit', (code, signal) => {
    clearInterval(poll)
    if (fs.existsSync(EXIT_CODE_FILE)) {
      const exitCode = parseInt(fs.readFileSync(EXIT_CODE_FILE, 'utf8'), 10) || 0
      try { fs.unlinkSync(EXIT_CODE_FILE) } catch (_) {}
      process.exit(exitCode)
    }
    process.exit(code !== null ? code : (signal === 'SIGKILL' ? 1 : 0))
  })
}

main()
