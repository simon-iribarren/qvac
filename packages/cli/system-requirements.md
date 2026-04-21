# QVAC system requirements

Minimum host requirements for running `@qvac/sdk` and `@qvac/cli`. You can
validate your environment against this list with:

```bash
qvac doctor
```

Use `--json` for machine-readable output and `--quiet` to only set the exit
code (`0` when all required checks pass, `1` otherwise).

## Required

| Requirement | Notes |
|---|---|
| Node.js `>= 18.0.0` | Node 18 is end-of-life; prefer `>= 20`. Matches `engines.node`. |
| Supported platform / arch | `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64`. Android and iOS are supported at the SDK level via the Expo plugin but are not host targets for the CLI. |
| Total RAM `>= 2 GB` (recommended `>= 4 GB`) | Below 4 GB, most LLMs will fail to load. |

## Recommended

| Requirement | When it is needed |
|---|---|
| Free RAM `>= 2 GB` | Needed when loading a model. Warning only — transient. |
| Free disk `>= 5 GB` in the working directory | Model artifacts are typically multi-GB per model. |

## Optional tools

Only required if you use the corresponding feature. The checker warns when
they are missing but does not fail.

| Tool | Required for |
|---|---|
| `ffmpeg` | Microphone capture, transcription examples, and the built-in audio decoder. Install from [ffmpeg.org](https://ffmpeg.org/download.html). |
| [Bare](https://bare.pears.com) runtime | Running the SDK under Bare directly (Node and Bun are supported out of the box). |
| [Bun](https://bun.sh) | Building the SDK from source or running the monorepo development workflow. |

## Exit codes

- `0` — all required checks passed. Warnings may still be present.
- `1` — one or more required checks failed (unsupported Node version, unsupported platform, insufficient total RAM, …). See the printed hints for remediation steps.

## JSON schema

```ts
interface DoctorReport {
  ok: boolean;
  platform: string;       // e.g. "darwin"
  arch: string;           // e.g. "arm64"
  nodeVersion: string;    // e.g. "20.19.5"
  sections: Array<{
    id: 'runtime' | 'hardware' | 'tools' | 'project';
    title: string;
    checks: Array<{
      id: string;
      label: string;
      status: 'pass' | 'warn' | 'fail' | 'skip';
      severity: 'required' | 'recommended';
      value?: string;
      detail?: string;
      hint?: string;      // present for any non-pass result
    }>;
  }>;
}
```
