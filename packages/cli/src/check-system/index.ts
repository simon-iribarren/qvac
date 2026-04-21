import { collectCheckSections, isReportOk } from './checks.js'
import { formatJsonReport, formatReport } from './format.js'
import type { RunCheckSystemOptions, SystemCheckReport } from './types.js'

export async function runSystemCheck (
  options: RunCheckSystemOptions = {}
): Promise<SystemCheckReport> {
  const projectRoot = options.projectRoot ?? process.cwd()
  const sections = collectCheckSections({ projectRoot })

  const report: SystemCheckReport = {
    ok: isReportOk(sections),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    sections
  }

  if (options.json) {
    process.stdout.write(`${formatJsonReport(report)}\n`)
  } else if (!options.quiet) {
    process.stdout.write(`${formatReport(report)}\n`)
  }

  return report
}

export type { SystemCheckReport, RunCheckSystemOptions } from './types.js'
