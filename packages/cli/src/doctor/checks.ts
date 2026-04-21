import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import type { CheckResult, CheckSection } from './types.js'

const MIN_NODE_MAJOR = 18
const RECOMMENDED_NODE_MAJOR = 20
const MIN_TOTAL_MEMORY_GB = 2
const RECOMMENDED_TOTAL_MEMORY_GB = 4
const RECOMMENDED_FREE_MEMORY_GB = 2
const RECOMMENDED_FREE_DISK_GB = 5

const SUPPORTED_HOSTS: ReadonlyArray<string> = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64'
]

function toGB (bytes: number): number {
  return bytes / (1024 ** 3)
}

function fmtGB (bytes: number): string {
  return `${toGB(bytes).toFixed(2)} GB`
}

function parseNodeMajor (version: string): number | null {
  const match = /^v?(\d+)\./.exec(version)
  if (!match || match[1] === undefined) return null
  const n = Number.parseInt(match[1], 10)
  return Number.isFinite(n) ? n : null
}

export function checkNodeVersion (version: string = process.versions.node): CheckResult {
  const major = parseNodeMajor(version)
  if (major === null) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'warn',
      severity: 'required',
      value: version,
      hint: `Could not parse Node.js version; expected v${MIN_NODE_MAJOR} or newer.`
    }
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'fail',
      severity: 'required',
      value: `v${version}`,
      hint: `Upgrade Node.js to v${MIN_NODE_MAJOR} or newer (current: v${version}).`
    }
  }
  if (major < RECOMMENDED_NODE_MAJOR) {
    return {
      id: 'node-version',
      label: 'Node.js version',
      status: 'warn',
      severity: 'required',
      value: `v${version}`,
      hint: `Node.js v${MIN_NODE_MAJOR} is supported but end-of-life; upgrade to v${RECOMMENDED_NODE_MAJOR}+ when possible.`
    }
  }
  return {
    id: 'node-version',
    label: 'Node.js version',
    status: 'pass',
    severity: 'required',
    value: `v${version}`
  }
}

export function checkPlatformArch (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CheckResult {
  const host = `${platform}-${arch}`
  if (SUPPORTED_HOSTS.includes(host)) {
    return {
      id: 'platform-arch',
      label: 'Platform / architecture',
      status: 'pass',
      severity: 'required',
      value: host
    }
  }
  return {
    id: 'platform-arch',
    label: 'Platform / architecture',
    status: 'fail',
    severity: 'required',
    value: host,
    hint: `Unsupported host "${host}". Supported: ${SUPPORTED_HOSTS.join(', ')}.`
  }
}

export function checkTotalMemory (totalBytes: number = os.totalmem()): CheckResult {
  const gb = toGB(totalBytes)
  if (gb < MIN_TOTAL_MEMORY_GB) {
    return {
      id: 'memory-total',
      label: 'Total RAM',
      status: 'fail',
      severity: 'required',
      value: fmtGB(totalBytes),
      hint: `At least ${MIN_TOTAL_MEMORY_GB} GB of RAM is required to run QVAC models.`
    }
  }
  if (gb < RECOMMENDED_TOTAL_MEMORY_GB) {
    return {
      id: 'memory-total',
      label: 'Total RAM',
      status: 'warn',
      severity: 'recommended',
      value: fmtGB(totalBytes),
      hint: `Less than ${RECOMMENDED_TOTAL_MEMORY_GB} GB RAM detected; most LLMs will fail to load.`
    }
  }
  return {
    id: 'memory-total',
    label: 'Total RAM',
    status: 'pass',
    severity: 'recommended',
    value: fmtGB(totalBytes)
  }
}

export function checkFreeMemory (freeBytes: number = os.freemem()): CheckResult {
  const gb = toGB(freeBytes)
  if (gb < RECOMMENDED_FREE_MEMORY_GB) {
    return {
      id: 'memory-free',
      label: 'Free RAM',
      status: 'warn',
      severity: 'recommended',
      value: fmtGB(freeBytes),
      hint: `Less than ${RECOMMENDED_FREE_MEMORY_GB} GB free; close other applications before loading large models.`
    }
  }
  return {
    id: 'memory-free',
    label: 'Free RAM',
    status: 'pass',
    severity: 'recommended',
    value: fmtGB(freeBytes)
  }
}

function readFreeDiskBytes (dir: string): number | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number, bavail: number } }).statfsSync
  if (typeof statfs !== 'function') return null
  try {
    const info = statfs(dir)
    return info.bsize * info.bavail
  } catch {
    return null
  }
}

export function checkFreeDiskSpace (dir: string = process.cwd()): CheckResult {
  const free = readFreeDiskBytes(dir)
  if (free === null) {
    return {
      id: 'disk-free',
      label: `Free disk space (${dir})`,
      status: 'skip',
      severity: 'recommended',
      hint: 'Disk space check requires Node.js v19.6.0 or newer (fs.statfsSync).'
    }
  }
  if (toGB(free) < RECOMMENDED_FREE_DISK_GB) {
    return {
      id: 'disk-free',
      label: `Free disk space (${dir})`,
      status: 'warn',
      severity: 'recommended',
      value: fmtGB(free),
      hint: `Less than ${RECOMMENDED_FREE_DISK_GB} GB free; model downloads are typically multi-GB.`
    }
  }
  return {
    id: 'disk-free',
    label: `Free disk space (${dir})`,
    status: 'pass',
    severity: 'recommended',
    value: fmtGB(free)
  }
}

export interface ProbeResult {
  ok: boolean
  version?: string
}

function probeBinary (command: string, args: string[]): ProbeResult {
  try {
    const r = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.error || r.status !== 0) return { ok: false }
    const firstLine = r.stdout.toString('utf8').split('\n')[0]?.trim() ?? ''
    return firstLine ? { ok: true, version: firstLine } : { ok: true }
  } catch {
    return { ok: false }
  }
}

export function checkFfmpeg (
  probe: (c: string, a: string[]) => ProbeResult = probeBinary
): CheckResult {
  const r = probe('ffmpeg', ['-version'])
  if (!r.ok) {
    return {
      id: 'tool-ffmpeg',
      label: 'ffmpeg',
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: 'Install ffmpeg to use transcription / microphone examples (https://ffmpeg.org/download.html).'
    }
  }
  return {
    id: 'tool-ffmpeg',
    label: 'ffmpeg',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'installed'
  }
}

export function checkBareRuntime (
  probe: (c: string, a: string[]) => ProbeResult = probeBinary
): CheckResult {
  const r = probe('bare', ['--version'])
  if (!r.ok) {
    return {
      id: 'tool-bare',
      label: 'Bare runtime',
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: 'Install bare-runtime only if you target the Bare runtime directly (npm i -g bare-runtime).'
    }
  }
  return {
    id: 'tool-bare',
    label: 'Bare runtime',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'installed'
  }
}

export function checkBun (
  probe: (c: string, a: string[]) => ProbeResult = probeBinary
): CheckResult {
  const r = probe('bun', ['--version'])
  if (!r.ok) {
    return {
      id: 'tool-bun',
      label: 'Bun',
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: 'Install Bun only if you build the SDK from source (https://bun.sh).'
    }
  }
  return {
    id: 'tool-bun',
    label: 'Bun',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'installed'
  }
}

export function checkSdkInstalled (projectRoot: string = process.cwd()): CheckResult {
  const pkgPath = path.join(projectRoot, 'node_modules', '@qvac', 'sdk', 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return {
      id: 'project-sdk',
      label: '@qvac/sdk in node_modules',
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: `Run 'npm install @qvac/sdk' in ${projectRoot} to install the SDK.`
    }
  }
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return {
      id: 'project-sdk',
      label: '@qvac/sdk in node_modules',
      status: 'pass',
      severity: 'recommended',
      value: pkg.version ? `v${pkg.version}` : 'installed'
    }
  } catch {
    return {
      id: 'project-sdk',
      label: '@qvac/sdk in node_modules',
      status: 'warn',
      severity: 'recommended',
      value: 'unreadable',
      hint: `Found ${pkgPath} but could not read its version.`
    }
  }
}

export interface CollectChecksOptions {
  projectRoot: string
  probe?: (c: string, a: string[]) => ProbeResult
}

export function collectCheckSections (options: CollectChecksOptions): CheckSection[] {
  const { projectRoot, probe = probeBinary } = options

  return [
    {
      id: 'runtime',
      title: 'Runtime',
      checks: [checkNodeVersion(), checkPlatformArch()]
    },
    {
      id: 'hardware',
      title: 'Hardware',
      checks: [checkTotalMemory(), checkFreeMemory(), checkFreeDiskSpace(projectRoot)]
    },
    {
      id: 'tools',
      title: 'Optional tools',
      checks: [checkFfmpeg(probe), checkBareRuntime(probe), checkBun(probe)]
    },
    {
      id: 'project',
      title: 'Project',
      checks: [checkSdkInstalled(projectRoot)]
    }
  ]
}

export function isReportOk (sections: CheckSection[]): boolean {
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === 'fail') return false
    }
  }
  return true
}
