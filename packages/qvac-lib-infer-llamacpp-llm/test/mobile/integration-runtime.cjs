'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const { pathToFileURL } = require('bare-url')

// ---------------------------------------------------------------------------
// Test filter – allows CI to restrict which tests actually execute.
//
// The WDIO before-hook pushes a testFilter.txt file (containing a regex
// pattern) to the app's Documents directory via Appium pushFile *before*
// clicking "Run Automated Tests".  Each run*Test wrapper consults
// __shouldRunTest(); when the test name doesn't match the pattern the
// wrapper returns a zero-count summary instantly – no model is loaded,
// no inference runs, zero resource cost.
// ---------------------------------------------------------------------------
let __filterLoaded = false
let __filterRe = null

global.__shouldRunTest = function shouldRunTest (testName) {
  if (!__filterLoaded) {
    __filterLoaded = true
    try {
      const dir = global.testDir
      if (dir) {
        const fp = path.join(dir, 'testFilter.txt')
        if (fs.existsSync(fp)) {
          const raw = fs.readFileSync(fp, 'utf-8').trim()
          if (raw) {
            __filterRe = new RegExp(raw)
            console.log('[TestFilter] loaded pattern: ' + raw)
          }
          try { fs.unlinkSync(fp) } catch (_) {}
        }
      }
    } catch (e) {
      console.log('[TestFilter] read error (running all):', e.message)
    }
  }
  if (!__filterRe) return true
  return __filterRe.test(testName)
}

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return 'missing'
  }

  const moduleUrl = pathToFileURL(modulePath).href
  await import(moduleUrl)
  return modulePath
}

global.runIntegrationModule = runIntegrationModule
