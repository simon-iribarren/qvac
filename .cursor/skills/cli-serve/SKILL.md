# CLI Serve (OpenAI-Compatible Server)

## What

Architecture and API reference for the `qvac serve openai` command — an OpenAI-compatible HTTP REST API that translates requests into SDK calls. Covers endpoints, config format, generation parameters, tool calling, transcription, and troubleshooting.

## When to Use

- Working on the CLI serve command or any file under `packages/cli/src/serve/`
- Adding or modifying an OpenAI-compatible endpoint
- Debugging tool calling, transcription, or streaming issues
- Understanding the model config format (`qvac.config.json` serve section)
- Understanding generation parameter translation (OpenAI params to SDK params)
- Troubleshooting compatibility with external tools (Continue.dev, LangChain, etc.)

## References

| File | Content |
|------|---------|
| `references/cli-serve.md` | Full reference: directory structure, endpoints, config format, generation params, tool calling flow, transcription flow, SDK wrapper, CLI flags, troubleshooting |
