# Registry Architecture

The QVAC Registry is a P2P system for distributing AI model files. It stores model metadata in a replicated database and model file data in Hyperblobs, all served over Hyperswarm without a centralized download server.

## Library Stack

The registry is built on the Holepunch (Hypercore Protocol) stack. Each library is a layer:

```
┌──────────────────────────────────────────────────────────┐
│  Application Layer                                       │
│                                                          │
│  RegistryDatabase (HyperDB)     Hyperblobs               │
│  Structured model catalog       Binary file storage      │
│  with indexed queries           split into blocks        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Autobase                                                │
│  Multi-writer consensus — linearized view                │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Hypercore                                               │
│  Append-only signed log (blocks of data)                 │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Corestore                                               │
│  Manages multiple Hypercores (local disk storage)        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Hyperswarm                                              │
│  P2P discovery + connections (DHT, NAT traversal)        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  BlindPeering                                            │
│  Relay data through always-on seeders                    │
│  (can't read content, just serve blocks)                 │
└──────────────────────────────────────────────────────────┘
```

### Hypercore

Append-only log identified by a public key. Data is split into numbered blocks. Only the key holder can write; anyone with the public key can read and verify.

### Corestore

Storage manager for multiple Hypercores under one directory on disk. Both server and client create a Corestore backed by a local folder. The `storage` path determines where blocks persist — this is critical for download resume (blocks cached locally survive restarts).

### Hyperswarm

P2P discovery using a DHT. You "join" a topic (derived from a Hypercore's discovery key) and the DHT connects you to other peers on that topic. Each Hypercore has its own discovery key, so metadata and blob data have separate peer sets.

### Hyperblobs

Stores binary files inside a Hypercore. Splits files into blocks and returns a **blob pointer**:

```typescript
interface BlobPointer {
  blockOffset: number   // first block index in the Hypercore
  blockLength: number   // number of blocks this file spans
  byteOffset: number    // byte position within the Hypercore
  byteLength: number    // total file size in bytes
}
```

Multiple files share one Hypercore at different block ranges.

### HyperDB / RegistryDatabase (`@qvac/registry-schema`)

Structured database on top of Hypercore. Stores the model catalog with indexed fields: `path`, `source`, `engine`, `quantization`, `name`. Each entry includes a `blobBinding` that points to where the file data lives in a Hyperblobs core.

### Autobase

Multi-writer collaboration layer. Linearizes writes from multiple authorized writers into a single consistent "view" core. The registry server appends operations; Autobase produces a read-only view that clients consume.

### BlindPeering

Relay mechanism. Blind peers replicate and serve Hypercore data without being able to decrypt the content. They act as always-on seeders so data is available 24/7 even when the registry server is offline.

## Two Data Layers

The registry has two independent data layers on separate Hypercores with separate swarm topics.

### Layer 1 — Metadata (HyperDB)

One Hypercore containing the model catalog (all 300+ entries). Clients join a single swarm topic (the **registry core key**) to sync this. The registry core key is a well-known public key configured in the SDK.

Each model entry contains:
- `path` — canonical path (e.g., `unsloth/Llama-3.2-1B-Instruct-GGUF/blob/.../model.gguf`)
- `source` — origin protocol (`hf` or `s3`), only meaningful server-side
- `engine`, `quantization`, `name`, `sizeBytes`, `sha256`, `tags`, etc.
- `blobBinding` — pointer to file data: `{ coreKey, blockOffset, blockLength, byteOffset, byteLength }`

### Layer 2 — File Data (Hyperblobs)

One or more Hypercores storing the actual model file bytes. Clients join **separate swarm topics** for each blob core. The `blobBinding.coreKey` in a model entry identifies which blob core holds the data.

Currently the registry uses **2 blob cores**:
- CoreA (`6309722b...`) — ~257 models
- CoreB (`4035e663...`) — ~56 models

Each blob core is independently seeded by blind peers. If a blob core's seeders go offline, all models on that core become unreachable even though their metadata is still visible.

## Server Ingestion Flow

When the registry server adds a model (`addModel()`):

1. **Parse source** — `parseCanonicalSource()` parses the URL (`s3:///key` or `https://huggingface.co/...`)
2. **Download from source** — `_downloadArtifact()` fetches from S3 (`@aws-sdk/client-s3`) or HuggingFace (`@huggingface/hub`) to temp dir
3. **Compute metadata** — SHA256, file size, GGUF metadata if applicable
4. **Upload to Hyperblobs** — `_uploadFileToHyperblobs()` appends file bytes as blocks to a blob core (named `"models"`), returns a blob pointer
5. **Write DB entry** — Autobase operation appended with model metadata + blob pointer + blob core key
6. **Mirror to blind peers** — `_mirrorBlobCore()` adds the blob core to BlindPeering, waits for peers to confirm sync
7. **Clear local copy** (optional) — `core.clear(0, blockCount)` frees server storage since blind peers now hold the data

Key file: `packages/qvac-lib-registry-server/lib/registry-service.js`

## Client Download Flow

The client **never** contacts S3 or HuggingFace directly. All downloads go through the P2P network.

1. **Query HyperDB** — look up model by `path` + `source`, get the `blobBinding`
2. **Open blob core** — `corestore.get({ key: blobBinding.coreKey })`
3. **Join swarm** for the blob core's discovery key — find peers (blind peers) that have the data
4. **Stream data** — `blobs.createReadStream(blobBinding, { wait: true, timeout })` reads blocks from local cache or fetches from peers
5. **Write to file** — stream piped to file on disk in the models cache directory

The `source` field (`hf` / `s3`) is only used server-side for initial ingestion. Clients only see Hypercore blocks on the P2P network.

Key file: `packages/qvac-lib-registry-server/client/lib/client.js`

## SDK Integration

The SDK wraps the registry client (`@qvac/registry-client`) for model downloads.

### Registry Core Key

Defined once in `packages/qvac-sdk/constants/registry.ts` as `DEFAULT_REGISTRY_CORE_KEY`. Imported by:
- `server/bare/registry/registry-client.ts` — runtime client
- `models/update-models/registry.ts` — build-time model codegen

The registry client library (`@qvac/registry-client`) also has its own default in `client/lib/config.js`, overridable via `QVAC_REGISTRY_CORE_KEY` env var.

### Corestore Cache

The SDK creates a persistent Corestore at `~/.qvac/registry-corestore/<registry-key>/`. The key is included in the path so switching registry keys uses a fresh corestore (avoids stale/incompatible cached data).

Key file: `packages/qvac-sdk/server/bare/registry/registry-client.ts`

### SDK Download Pipeline

```
downloadAsset() / loadModel()
  → resolveModelPath()
    → sees registry:// URL
    → downloadModelFromRegistry()
      → validateCachedFile() — check if already downloaded
      → getRegistryClient() — singleton, creates QVACRegistryClient
      → client.downloadModel() — gets stream from P2P
      → pipe to file with progress callbacks
      → validateCachedFile() — checksum verification
      → closeRegistryClient()
```

For sharded models (multiple GGUF files):
```
downloadModelFromRegistry()
  → detectShardedModel() — recognizes -00001-of-00005 pattern
  → findModelShards() — queries registry for all shards by path prefix
  → downloadShardedFilesFromRegistry() — downloads each shard sequentially
  → extractTensorsFromShards() — post-processing
```

For ONNX models with external data:
```
downloadModelFromRegistry()
  → findOnnxCompanionDataFile() — looks for .onnx_data companion
  → downloadOnnxWithDataFromRegistry() — downloads both files to same dir
```

Key file: `packages/qvac-sdk/server/rpc/handlers/load-model/registry.ts`

## S3 Source Configuration

S3 source URLs in `models.prod.json` use bucket-less format: `s3:///key` (no bucket name). The bucket is resolved at runtime from `QVAC_S3_BUCKET` env var via `resolveS3Bucket()` in `lib/source-helpers.js`. This prevents exposing the private bucket name in the open-source repo.

Operators must set `QVAC_S3_BUCKET` in the registry server environment for S3 downloads to work.

## Known Issues & Gotchas

### Windows fd-lock Race Condition

The registry client uses RocksDB (via Corestore) which holds exclusive file locks. On Windows, these locks are mandatory and only released when `close()` fully completes. Code must `await closeRegistryClient()` — using `void` (fire-and-forget) causes a race where the next `getRegistryClient()` call fails because the lock hasn't been released yet. macOS/Linux are unaffected because their file locks are advisory.

Fixed in: `findModelShards()` in `registry.ts` (PR #454).

### Corestore Storage Path

The `QVACRegistryClient` must use a **stable, persistent** storage path for download resume to work. If a temp directory is used (the registry client's default), Hypercore blocks are lost between sessions and downloads start from scratch every time.

The SDK uses `~/.qvac/registry-corestore/<key>/` for persistence.

### Blob Core Availability

Each blob core is independently seeded by blind peers. If a blob core's seeders go offline:
- Metadata queries still work (different Hypercore)
- `downloadModel()` returns a stream, but it never emits data (0 bytes)
- All models on that blob core are affected regardless of their original source type

Diagnosing: group models by `blobBinding.coreKey` and test one download from each core to identify which is down.

### Client Lifecycle

The SDK uses a singleton `registryClient`. After each download operation, it calls `closeRegistryClient()`. The next operation creates a fresh client. This close/reopen cycle is necessary because the client joins swarm topics for specific blob cores and needs cleanup.

## Key Files Reference

| File | Description |
|------|-------------|
| `packages/qvac-lib-registry-server/lib/registry-service.js` | Server: ingestion, blob storage, blind peering |
| `packages/qvac-lib-registry-server/lib/source-helpers.js` | S3/HF URL parsing, bucket resolution |
| `packages/qvac-lib-registry-server/lib/config.js` | Server config (storage, S3 bucket, env vars) |
| `packages/qvac-lib-registry-server/client/lib/client.js` | Registry client: connect, query, download |
| `packages/qvac-lib-registry-server/client/lib/config.js` | Client config (storage path, core key) |
| `packages/qvac-lib-registry-server/data/models.prod.json` | Model source definitions for ingestion |
| `packages/qvac-sdk/constants/registry.ts` | `DEFAULT_REGISTRY_CORE_KEY` (single source of truth) |
| `packages/qvac-sdk/server/bare/registry/registry-client.ts` | SDK registry client wrapper (singleton) |
| `packages/qvac-sdk/server/rpc/handlers/load-model/registry.ts` | SDK download pipeline (single, sharded, ONNX) |
| `packages/qvac-sdk/server/utils/cache.ts` | Cache directory management |
| `packages/qvac-sdk/models/registry/models.ts` | Auto-generated model constants from registry |
| `packages/qvac-sdk/models/update-models/registry.ts` | Build script to regenerate models.ts |
