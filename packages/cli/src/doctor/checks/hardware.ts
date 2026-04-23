import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { Check } from '../check.js'

const MIN_TOTAL_MEMORY_GB = 2
const RECOMMENDED_TOTAL_MEMORY_GB = 4
const RECOMMENDED_AVAILABLE_MEMORY_GB = 2
const RECOMMENDED_FREE_DISK_GB = 5

function toGB (bytes: number): number {
  return bytes / (1024 ** 3)
}

function fmtGB (bytes: number): string {
  return `${toGB(bytes).toFixed(2)} GB`
}

// Total RAM has a hard gate (<2 GB fails the report) with a recommended
// band on top, so the check is 'required' as a whole — the same pattern
// as checkNodeVersion. Severity describes the check itself, not the
// outcome of a particular branch.
export const checkTotalMemory: Check = (ctx) => {
  const totalBytes = ctx.totalMemoryBytes
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
      severity: 'required',
      value: fmtGB(totalBytes),
      hint: `Less than ${RECOMMENDED_TOTAL_MEMORY_GB} GB RAM detected; most LLMs will fail to load.`
    }
  }
  return {
    id: 'memory-total',
    label: 'Total RAM',
    status: 'pass',
    severity: 'required',
    value: fmtGB(totalBytes)
  }
}

export const checkAvailableMemory: Check = (ctx) => {
  const availableBytes = ctx.availableMemoryBytes
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

export const checkFreeDiskSpace: Check = (ctx) => {
  const dir = ctx.projectRoot
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
