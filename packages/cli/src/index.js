#!/usr/bin/env node

import { createRequire } from 'node:module'
import { Command } from 'commander'
import { bundleSdk } from './bundle-sdk/index.js'
import { handleError } from './errors.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

// ─────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────────────────────

function collect (value, previous) {
  return previous.concat([value])
}

function setupCli () {
  const program = new Command()

  program
    .name('qvac')
    .description('Command-line interface for the QVAC ecosystem')
    .version(pkg.version)

  const bundleCmd = program
    .command('bundle')
    .description('Bundle QVAC artifacts for different runtimes')

  bundleCmd
    .command('sdk')
    .description('Generate a tree-shaken Bare worker bundle with selected plugins')
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option('--sdk-path <path>', 'Path to SDK package (default: auto-detect in node_modules)')
    .option('--host <target>', 'Target host (repeatable)', collect, [])
    .option('--defer <module>', 'Defer a module (repeatable)', collect, [])
    .option('-q, --quiet', 'Minimal output')
    .option('-v, --verbose', 'Detailed output')
    .action(async (options) => {
      try {
        await bundleSdk({
          projectRoot: process.cwd(),
          configPath: options.config,
          sdkPath: options.sdkPath,
          hosts: options.host.length > 0 ? options.host : undefined,
          defer: options.defer.length > 0 ? options.defer : undefined,
          quiet: options.quiet,
          verbose: options.verbose
        })
      } catch (error) {
        handleError(error)
        process.exit(1)
      }
    })

  program
    .command('serve')
    .description('Start an OpenAI-compatible REST API server backed by QVAC')
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option('-p, --port <number>', 'Port to listen on', '11434')
    .option('-H, --host <address>', 'Host to bind to', '127.0.0.1')
    .option('--model <alias>', 'Model alias to preload (repeatable, must be in config)', collect, [])
    .option('--api-key <key>', 'Require Bearer token authentication')
    .option('--cors', 'Enable CORS headers')
    .option('-v, --verbose', 'Detailed output')
    .action(async (options) => {
      try {
        const { startServer } = await import('./serve/index.js')
        await startServer({
          projectRoot: process.cwd(),
          config: options.config,
          port: parseInt(options.port, 10),
          host: options.host,
          model: options.model.length > 0 ? options.model : undefined,
          apiKey: options.apiKey,
          cors: options.cors,
          verbose: options.verbose
        })
      } catch (error) {
        handleError(error)
        process.exit(1)
      }
    })

  program.parse()
}

setupCli()
