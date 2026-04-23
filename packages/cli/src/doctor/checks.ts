import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { DEFAULT_HOSTS, DEFAULT_SDK_NAME } from '../bundle-sdk/constants.js'
import type { CheckResult, CheckSection } from './types.js'

const MIN_NODE_MAJOR = 18
const RECOMMENDED_NODE_MAJOR = 20
const MIN_TOTAL_MEMORY_GB = 2
const RECOMMENDED_TOTAL_MEMORY_GB = 4
const RECOMMENDED_AVAILABLE_MEMORY_GB = 2
const RECOMMENDED_FREE_DISK_GB = 5

// Where the `qvac` CLI itself can run. This is NOT the set of SDK deploy
// targets — the SDK additionally targets Android and iOS via Expo/BareKit,
// which are reported in the "Deploy targets" section.
const SUPPORTED_CLI_HOSTS: ReadonlyArray<string> = [
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

export function checkCliHost (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CheckResult {
  const host = `${platform}-${arch}`
  if (SUPPORTED_CLI_HOSTS.includes(host)) {
    return {
      id: 'cli-host',
      label: 'CLI host',
      status: 'pass',
      severity: 'required',
      value: host
    }
  }
  return {
    id: 'cli-host',
    label: 'CLI host',
    status: 'fail',
    severity: 'required',
    value: host,
    hint: `The 'qvac' CLI cannot run on "${host}". Supported CLI hosts: ${SUPPORTED_CLI_HOSTS.join(', ')}. (Android/iOS are supported as SDK deploy targets, not as CLI hosts.)`
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

// Prefer os.availableMemory() (Node 22+) which reports memory actually
// available for allocation. os.freemem() is known to be misleading on Linux
// and macOS because it excludes reclaimable page cache, which causes noisy
// false warnings on otherwise healthy systems.
function readAvailableMemoryBytes (): number {
  const available = (os as unknown as { availableMemory?: () => number }).availableMemory
  if (typeof available === 'function') return available()
  return os.freemem()
}

export function checkAvailableMemory (
  availableBytes: number = readAvailableMemoryBytes()
): CheckResult {
  const gb = toGB(availableBytes)
  if (gb < RECOMMENDED_AVAILABLE_MEMORY_GB) {
    return {
      id: 'memory-available',
      label: 'Available RAM',
      status: 'warn',
      severity: 'recommended',
      value: fmtGB(availableBytes),
      hint: `Less than ${RECOMMENDED_AVAILABLE_MEMORY_GB} GB available; close other applications before loading large models.`
    }
  }
  return {
    id: 'memory-available',
    label: 'Available RAM',
    status: 'pass',
    severity: 'recommended',
    value: fmtGB(availableBytes)
  }
}

interface StatfsLike { bsize: number, bavail: number }

function readFreeDiskBytes (dir: string): number | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => StatfsLike }).statfsSync
  if (typeof statfs === 'function') {
    try {
      const info = statfs(dir)
      return info.bsize * info.bavail
    } catch {
      // fall through to shell fallback
    }
  }
  // Fallback for Node 18.0–18.14 on unix (statfsSync was added in 18.15).
  if (process.platform !== 'win32') {
    try {
      const r = spawnSync('df', ['-Pk', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.error || r.status !== 0) return null
      const lines = r.stdout.toString('utf8').trim().split('\n')
      const row = lines[1]
      if (!row) return null
      const cols = row.trim().split(/\s+/)
      // Columns: Filesystem 1024-blocks Used Available Capacity Mounted
      const kb = cols.length >= 4 && cols[3] !== undefined ? Number.parseInt(cols[3], 10) : NaN
      if (!Number.isFinite(kb)) return null
      return kb * 1024
    } catch {
      return null
    }
  }
  return null
}

export function checkFreeDiskSpace (dir: string = process.cwd()): CheckResult {
  const free = readFreeDiskBytes(dir)
  if (free === null) {
    return {
      id: 'disk-free',
      label: `Free disk space (${dir})`,
      status: 'skip',
      severity: 'recommended',
      hint: 'Disk space check requires Node.js v18.15+ (fs.statfsSync) or a POSIX `df` on PATH.'
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

export type ProbeFn = (command: string, args: string[]) => ProbeResult

// Cap probes at 3s so a hung/interactive binary (or an adb that is waiting
// for a device) cannot make `qvac doctor` hang. 3s is generous for a
// `--version` style call while still short enough to keep the command snappy.
const PROBE_TIMEOUT_MS = 3000

function probeBinary (command: string, args: string[]): ProbeResult {
  try {
    const r = spawnSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS
    })
    if (r.error || r.status !== 0 || r.signal === 'SIGTERM') return { ok: false }
    const firstLine = r.stdout.toString('utf8').split('\n')[0]?.trim() ?? ''
    return firstLine ? { ok: true, version: firstLine } : { ok: true }
  } catch {
    return { ok: false }
  }
}

export function checkFfmpeg (probe: ProbeFn = probeBinary): CheckResult {
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

export function checkBareRuntime (probe: ProbeFn = probeBinary): CheckResult {
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

export function checkBun (probe: ProbeFn = probeBinary): CheckResult {
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

// Deploy targets — the full matrix of platforms the SDK can deploy to,
// which is a superset of CLI hosts (adds Android + iOS via BareKit).
// Informational by default: bare-pack ships prebuilts for every target,
// so bundling is always available. What's checked here is the host
// toolchain needed to *deploy* to each target class.

function desktopTargetsLine (hostPlatform: NodeJS.Platform, hostArch: string): string {
  const nativeHost = `${hostPlatform}-${hostArch}`
  const desktops = DEFAULT_HOSTS.filter((h) => !h.startsWith('android') && !h.startsWith('ios'))
  return desktops.map((h) => (h === nativeHost ? `${h} (native)` : h)).join(', ')
}

export function checkDesktopTargets (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CheckResult {
  return {
    id: 'target-desktop',
    label: 'Desktop',
    status: 'pass',
    severity: 'informational',
    value: desktopTargetsLine(platform, arch),
    hint: 'bare-pack ships prebuilts for every desktop target; cross-bundling is always available.'
  }
}

export function checkAndroidTarget (probe: ProbeFn = probeBinary): CheckResult {
  const r = probe('adb', ['--version'])
  if (!r.ok) {
    return {
      id: 'target-android',
      label: 'Android (android-arm64)',
      status: 'warn',
      severity: 'recommended',
      value: 'adb not found',
      hint: 'Install Android platform tools to deploy QVAC apps to Android devices: https://developer.android.com/tools/releases/platform-tools'
    }
  }
  return {
    id: 'target-android',
    label: 'Android (android-arm64)',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'adb installed'
  }
}

export function checkIosTarget (
  platform: NodeJS.Platform = process.platform,
  probe: ProbeFn = probeBinary
): CheckResult {
  if (platform !== 'darwin') {
    return {
      id: 'target-ios',
      label: 'iOS (ios-arm64 + simulators)',
      status: 'info',
      severity: 'informational',
      value: 'requires macOS host',
      hint: 'iOS apps can only be built/deployed from a macOS host with Xcode installed.'
    }
  }
  const r = probe('xcodebuild', ['-version'])
  if (!r.ok) {
    return {
      id: 'target-ios',
      label: 'iOS (ios-arm64 + simulators)',
      status: 'warn',
      severity: 'recommended',
      value: 'Xcode not found',
      hint: 'Install Xcode from the App Store (Command Line Tools alone are not sufficient for iOS builds).'
    }
  }
  return {
    id: 'target-ios',
    label: 'iOS (ios-arm64 + simulators)',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'Xcode installed'
  }
}

// Locate @qvac/sdk the same way a consumer project's runtime would, so we
// correctly find the package whether installed locally, hoisted in a
// monorepo, or linked via workspaces.
function resolveSdkPackageJson (projectRoot: string): string | null {
  try {
    const req = createRequire(path.join(projectRoot, 'package.json'))
    for (const spec of [`${DEFAULT_SDK_NAME}/package.json`, `${DEFAULT_SDK_NAME}/package`]) {
      try {
        return req.resolve(spec)
      } catch {
        // try the next spec
      }
    }
    return null
  } catch {
    return null
  }
}

export function checkSdkInstalled (projectRoot: string = process.cwd()): CheckResult {
  const pkgPath = resolveSdkPackageJson(projectRoot)
  if (pkgPath === null) {
    return {
      id: 'project-sdk',
      label: `${DEFAULT_SDK_NAME} resolvable from project`,
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: `Run 'npm install ${DEFAULT_SDK_NAME}' in ${projectRoot} to install the SDK.`
    }
  }
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return {
      id: 'project-sdk',
      label: `${DEFAULT_SDK_NAME} resolvable from project`,
      status: 'pass',
      severity: 'recommended',
      value: pkg.version !== undefined ? `v${pkg.version}` : 'installed'
    }
  } catch {
    return {
      id: 'project-sdk',
      label: `${DEFAULT_SDK_NAME} resolvable from project`,
      status: 'warn',
      severity: 'recommended',
      value: 'unreadable',
      hint: `Found ${pkgPath} but could not read its version.`
    }
  }
}

export interface CollectChecksOptions {
  projectRoot: string
  probe?: ProbeFn
}

export function collectCheckSections (options: CollectChecksOptions): CheckSection[] {
  const { projectRoot, probe = probeBinary } = options

  return [
    {
      id: 'runtime',
      title: 'Runtime',
      checks: [checkNodeVersion(), checkCliHost()]
    },
    {
      id: 'hardware',
      title: 'Hardware',
      checks: [checkTotalMemory(), checkAvailableMemory(), checkFreeDiskSpace(projectRoot)]
    },
    {
      id: 'targets',
      title: 'Deploy targets (SDK)',
      checks: [checkDesktopTargets(), checkAndroidTarget(probe), checkIosTarget(process.platform, probe)]
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
