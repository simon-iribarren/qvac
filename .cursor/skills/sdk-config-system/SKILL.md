# SDK Config System

## What

Reference for the SDK's immutable configuration system: how config is resolved from files/env vars at initialization, sent to the worker, and accessed in server code.

## When to Use

- Adding a new config option to the SDK
- Debugging config resolution (file discovery, env vars, validation)
- Understanding the internal __init_config message protocol
- Working with cross-runtime compatibility (Node.js vs Bare)
- Modifying config-loader.ts, init-hooks.ts, or config-registry.ts

## References

| File | Content |
|------|---------|
| `references/config-system.md` | Full config system reference: architecture, adding options, resolution priority, cross-runtime compat, debugging |
