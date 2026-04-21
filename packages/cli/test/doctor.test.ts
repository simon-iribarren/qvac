import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  checkNodeVersion,
  checkPlatformArch,
  checkTotalMemory,
  checkFreeMemory,
  checkFreeDiskSpace,
  checkFfmpeg,
  checkBareRuntime,
  checkBun,
  checkSdkInstalled,
  collectCheckSections,
  isReportOk
} from '../src/doctor/checks.js'

describe('checkNodeVersion', () => {
  it('fails on Node < 18', () => {
    const r = checkNodeVersion('16.20.0')
    assert.equal(r.status, 'fail')
    assert.equal(r.severity, 'required')
  })

  it('warns on Node 18 (EOL but supported)', () => {
    const r = checkNodeVersion('18.19.0')
    assert.equal(r.status, 'warn')
  })

  it('warns on Node 19 (below recommended)', () => {
    const r = checkNodeVersion('19.9.0')
    assert.equal(r.status, 'warn')
  })

  it('passes on Node 20+', () => {
    const r = checkNodeVersion('20.11.0')
    assert.equal(r.status, 'pass')
  })

  it('handles v-prefixed versions', () => {
    const r = checkNodeVersion('v22.1.0')
    assert.equal(r.status, 'pass')
  })

  it('warns when version cannot be parsed', () => {
    const r = checkNodeVersion('nightly')
    assert.equal(r.status, 'warn')
  })
})

describe('checkPlatformArch', () => {
  it('passes on darwin-arm64', () => {
    const r = checkPlatformArch('darwin', 'arm64')
    assert.equal(r.status, 'pass')
    assert.equal(r.value, 'darwin-arm64')
  })

  it('passes on linux-x64', () => {
    const r = checkPlatformArch('linux', 'x64')
    assert.equal(r.status, 'pass')
  })

  it('passes on win32-x64', () => {
    const r = checkPlatformArch('win32', 'x64')
    assert.equal(r.status, 'pass')
  })

  it('fails on unsupported combinations', () => {
    const r = checkPlatformArch('freebsd', 'x64')
    assert.equal(r.status, 'fail')
  })

  it('fails on win32-arm64 (not in supported matrix)', () => {
    const r = checkPlatformArch('win32', 'arm64')
    assert.equal(r.status, 'fail')
  })
})

describe('checkTotalMemory', () => {
  it('fails when total RAM is below the hard minimum', () => {
    const r = checkTotalMemory(1 * 1024 ** 3)
    assert.equal(r.status, 'fail')
  })

  it('warns when total RAM is below recommended', () => {
    const r = checkTotalMemory(3 * 1024 ** 3)
    assert.equal(r.status, 'warn')
  })

  it('passes when total RAM meets recommended', () => {
    const r = checkTotalMemory(8 * 1024 ** 3)
    assert.equal(r.status, 'pass')
  })
})

describe('checkFreeMemory', () => {
  it('warns when free RAM is below recommended', () => {
    const r = checkFreeMemory(1 * 1024 ** 3)
    assert.equal(r.status, 'warn')
  })

  it('passes when free RAM is above recommended', () => {
    const r = checkFreeMemory(4 * 1024 ** 3)
    assert.equal(r.status, 'pass')
  })
})

describe('checkFreeDiskSpace', () => {
  it('returns a result for the current working directory', () => {
    const r = checkFreeDiskSpace(process.cwd())
    assert.ok(['pass', 'warn', 'skip'].includes(r.status))
    assert.equal(r.severity, 'recommended')
  })
})

describe('optional tool probes', () => {
  const probePresent = () => ({ ok: true, version: '1.2.3' })
  const probeMissing = () => ({ ok: false })

  it('ffmpeg passes when probe reports installed', () => {
    const r = checkFfmpeg(probePresent)
    assert.equal(r.status, 'pass')
    assert.equal(r.value, '1.2.3')
  })

  it('ffmpeg warns when probe reports missing', () => {
    const r = checkFfmpeg(probeMissing)
    assert.equal(r.status, 'warn')
    assert.ok(r.hint && r.hint.includes('ffmpeg'))
  })

  it('Bare runtime warns when missing (recommended only)', () => {
    const r = checkBareRuntime(probeMissing)
    assert.equal(r.status, 'warn')
    assert.equal(r.severity, 'recommended')
  })

  it('Bun warns when missing (recommended only)', () => {
    const r = checkBun(probeMissing)
    assert.equal(r.status, 'warn')
    assert.equal(r.severity, 'recommended')
  })
})

describe('checkSdkInstalled', () => {
  it('warns when @qvac/sdk is absent from node_modules', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-check-'))
    try {
      const r = checkSdkInstalled(emptyDir)
      assert.equal(r.status, 'warn')
      assert.equal(r.value, 'not found')
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('passes when @qvac/sdk package.json is present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-check-'))
    const sdkDir = path.join(root, 'node_modules', '@qvac', 'sdk')
    fs.mkdirSync(sdkDir, { recursive: true })
    fs.writeFileSync(
      path.join(sdkDir, 'package.json'),
      JSON.stringify({ name: '@qvac/sdk', version: '0.9.0' })
    )
    try {
      const r = checkSdkInstalled(root)
      assert.equal(r.status, 'pass')
      assert.equal(r.value, 'v0.9.0')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('collectCheckSections + isReportOk', () => {
  it('returns the expected section order and ids', () => {
    const sections = collectCheckSections({ projectRoot: process.cwd() })
    assert.deepEqual(
      sections.map((s) => s.id),
      ['runtime', 'hardware', 'tools', 'project']
    )
  })

  it('isReportOk returns false when any check has failed', () => {
    const sections = [
      {
        id: 'runtime' as const,
        title: 'Runtime',
        checks: [
          { id: 'x', label: 'x', status: 'pass' as const, severity: 'required' as const },
          { id: 'y', label: 'y', status: 'fail' as const, severity: 'required' as const }
        ]
      }
    ]
    assert.equal(isReportOk(sections), false)
  })

  it('isReportOk returns true when only warnings/skips are present', () => {
    const sections = [
      {
        id: 'runtime' as const,
        title: 'Runtime',
        checks: [
          { id: 'x', label: 'x', status: 'warn' as const, severity: 'required' as const },
          { id: 'y', label: 'y', status: 'skip' as const, severity: 'recommended' as const }
        ]
      }
    ]
    assert.equal(isReportOk(sections), true)
  })
})
