# Registry Architecture

## What

Architecture reference for the QVAC P2P model registry: the Holepunch library stack, two-layer data model (metadata + blob cores), server ingestion flow, client download flow, SDK integration, and known issues.

## When to Use

- Understanding how models are stored and distributed over P2P
- Working with the registry server ingestion pipeline (addModel, Hyperblobs, blind peering)
- Working with the SDK download pipeline (registry://, sharded models, ONNX companions)
- Debugging download failures, blob core availability, or corestore issues
- Understanding the relationship between metadata core, blob cores, and blind peers
- Working with S3 source configuration or HuggingFace ingestion
- Modifying registry-client.ts, registry.ts, or client.js

## References

| File | Content |
|------|---------|
| `references/registry-architecture.md` | Full architecture: library stack, two data layers, server ingestion flow, client download flow, SDK integration, S3 config, known issues, key files |
