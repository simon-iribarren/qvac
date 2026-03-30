# Unify GitHub Workflows Roadmap

## Goal

Implement the workflow unification initiative from `docs/pitches/unify-github-workflows.md` with phased migration, explicit validation gates, and a living backlog that can be split during execution.

## Scope

- Unify addon CI orchestration for prebuild, on-pr, and on-pr-close workflows.
- Introduce reusable building blocks in `.github/actions` and reusable workflows in `.github/workflows`.
- Preserve package-specific behavior while reducing duplicated workflow logic.

## Non-goals

- Full unification of integration/mobile test internals in this pass.
- Benchmark workflow unification in this pass.
- Forced runner standardization in this pass.

## Status Convention

- `todo`: not started
- `in_progress`: active work
- `blocked`: waiting on dependency/decision
- `done`: implemented and validated for target cohort

## Task Backlog

| ID | Task | Status |
| :-- | :-- | :-- |
| 1 | Create roadmap and baseline inventory | `done` |
| 2 | Build reusable composite actions | `done` |
| 3 | Build reusable prebuild workflow and migrate callers | `done` |
| 4 | Build reusable on-pr workflow and converge wrappers | `done` |
| 5 | Build reusable cpp-tests workflow and migrate wrappers | `done` |
| 6 | Validation, rollout, and legacy retirement | `in_progress` |

## Current Status Snapshot (2026-03-27)

### Implemented reusable building blocks

- `.github/actions/setup-addon-toolchain/action.yml`
- `.github/actions/setup-vcpkg-cache/action.yml`
- `.github/actions/strip-and-verify/action.yml`
- `.github/workflows/_reusable-prebuilds-addon.yml`
- `.github/workflows/_reusable-on-pr-addon.yml`
- `.github/workflows/_reusable-on-pr-close-addon.yml`
- `.github/workflows/_reusable-cpp-tests-addon.yml`

### Migrated `on-pr` prebuild call sites

- `on-pr-qvac-lib-infer-llamacpp-llm.yml`
- `on-pr-qvac-lib-infer-llamacpp-embed.yml`
- `on-pr-qvac-lib-infer-whispercpp.yml`
- `on-pr-qvac-lib-infer-onnx-tts.yml`
- `on-pr-qvac-lib-infer-parakeet.yml`
- `on-pr-qvac-lib-infer-onnx.yml`
- `on-pr-qvac-lib-infer-nmtcpp.yml`
- `on-pr-lib-infer-diffusion.yml`
- `on-pr-ocr-onnx.yml`

### Migrated `on-pr-close` wrappers

- `on-pr-close-qvac-lib-infer-llamacpp-llm.yml`
- `on-pr-close-qvac-lib-infer-llamacpp-embed.yml`
- `on-pr-close-qvac-lib-infer-whispercpp.yml`
- `on-pr-close-qvac-lib-infer-onnx-tts.yml`
- `on-pr-close-qvac-lib-infer-parakeet.yml`
- `on-pr-close-qvac-lib-infer-nmtcpp.yml`
- `on-pr-close-qvac-lib-infer-onnx.yml`
- `on-pr-close-lib-infer-diffusion.yml`
- `on-pr-close-ocr-onnx.yml`
- `on-pr-close-qvac-lib-decoder-audio.yml`

### Migrated `on-pr` C++ test callers

- `on-pr-qvac-lib-infer-llamacpp-llm.yml` now calls `_reusable-cpp-tests-addon.yml`
- `on-pr-qvac-lib-infer-llamacpp-embed.yml` now calls `_reusable-cpp-tests-addon.yml`
- `on-pr-lib-infer-diffusion.yml` now calls `_reusable-cpp-tests-addon.yml`

### Validation status

- Local/static validation completed:
  - repo wiring checks for migrated `uses:` references
  - lint diagnostics check (`ReadLints`) on changed workflow/action/doc paths
  - check that unified setup paths do not include `gcc-13`/`g++-13`
- Full CI rollout validation is still pending (required before legacy workflow retirement).

## Baseline Inventory

### Prebuild workflows

- `prebuilds-qvac-lib-infer-llamacpp-llm.yml`
- `prebuilds-qvac-lib-infer-llamacpp-embed.yml`
- `prebuilds-qvac-lib-infer-whispercpp.yml`
- `prebuilds-qvac-lib-infer-onnx-tts.yml`
- `prebuilds-qvac-lib-infer-parakeet.yml`
- `prebuilds-qvac-lib-infer-nmtcpp.yml`
- `prebuilds-qvac-lib-infer-onnx.yml`
- `prebuilds-lib-infer-diffusion.yml`
- `prebuilds-ocr-onnx.yml`

### On-PR workflows

- `on-pr-qvac-lib-infer-llamacpp-llm.yml`
- `on-pr-qvac-lib-infer-llamacpp-embed.yml`
- `on-pr-qvac-lib-infer-whispercpp.yml`
- `on-pr-qvac-lib-infer-onnx-tts.yml`
- `on-pr-qvac-lib-infer-parakeet.yml`
- `on-pr-qvac-lib-infer-nmtcpp.yml`
- `on-pr-qvac-lib-infer-onnx.yml`
- `on-pr-lib-infer-diffusion.yml`
- `on-pr-ocr-onnx.yml`

### On-PR close workflows

- `on-pr-close-qvac-lib-infer-llamacpp-llm.yml`
- `on-pr-close-qvac-lib-infer-llamacpp-embed.yml`
- `on-pr-close-qvac-lib-infer-whispercpp.yml`
- `on-pr-close-qvac-lib-infer-onnx-tts.yml`
- `on-pr-close-qvac-lib-infer-parakeet.yml`
- `on-pr-close-qvac-lib-infer-nmtcpp.yml`
- `on-pr-close-qvac-lib-infer-onnx.yml`
- `on-pr-close-lib-infer-diffusion.yml`
- `on-pr-close-ocr-onnx.yml`

### C++ test workflows

- `cpp-tests-llm.yml`
- `cpp-tests-embed.yml`
- `cpp-tests-diffusion.yml`
- `cpp-test-coverage-qvac-lib-infer-whispercpp.yml`
- `cpp-test-coverage-qvac-lib-infer-onnx-tts.yml`
- `cpp-test-coverage-qvac-lib-infer-parakeet.yml`

### Known deltas to preserve during migration

- Runner differences: `ubuntu-22.04-arm` and `ubuntu-24.04-arm64-private` coexist.
- Cache backend differences: GH cache/filesystem and S3-backed variants coexist.
- Package naming and publish nuances differ between `@qvac` and `@tetherto` publishes.
- `qvac-lib-infer-nmtcpp` includes custom patch and compatibility logic.
- Legacy compiler pinning exists in isolated places and must not be reintroduced.

## Migration Order

- Cohort A: `qvac-lib-infer-llamacpp-llm`, `qvac-lib-infer-llamacpp-embed`
- Cohort B: `qvac-lib-infer-whispercpp`, `qvac-lib-infer-parakeet`
- Cohort C: `qvac-lib-infer-onnx-tts`, `qvac-lib-infer-onnx`, `lib-infer-diffusion`, `ocr-onnx`
- Cohort D: `qvac-lib-infer-nmtcpp`

## Validation Checklist

- Reusable workflow call path works from on-pr and workflow_dispatch.
- Package-specific publish tags and targets are preserved.
- C++ tests pass for migrated cohort packages.
- Integration and mobile test entrypoints remain wired.
- No `gcc-13` pinning in unified setup paths.
- Branch protection / merge-guard signals remain stable.

## Rollback Plan

- Keep legacy workflows in place until cohort validation is complete.
- Migrate callers first, then remove duplicated logic only after green CI.
- Revert by restoring caller `uses:` targets to previous workflow files if needed.

## Decision Log

| Date | Decision | Rationale |
| :-- | :-- | :-- |
| 2026-03-27 | Start with reusable workflows and wrappers by cohort | Limits blast radius and preserves package-specific behavior while deduplicating orchestration. |
| 2026-03-27 | Keep thin wrappers for `on-pr` and `on-pr-close` | Preserves per-package trigger surfaces and package-specific defaults while centralizing shared execution logic. |
| 2026-03-27 | Mark rollout validation as in progress | Local checks are complete, but full CI validation across cohorts must pass before deleting legacy workflows. |

