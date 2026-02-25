# qvac-lib-infer-stable-diffusion-cpp

Native C++ addon for image and video generation using [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp), built for the Bare Runtime. Supports Stable Diffusion 1.x / 2.x, SDXL, SD3, FLUX.1, FLUX.2 [klein], and Wan2.x video models.

## Table of Contents

- [Supported platforms](#supported-platforms)
- [Prerequisites](#prerequisites)
- [Building from Source](#building-from-source)
- [Downloading Model Files](#downloading-model-files)
- [Running the Example](#running-the-example)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create a Data Loader](#2-create-a-data-loader)
  - [3. Create the `args` object](#3-create-the-args-object)
  - [4. Create the `config` object](#4-create-the-config-object)
  - [5. Create a Model Instance](#5-create-a-model-instance)
  - [6. Load the Model](#6-load-the-model)
  - [7. Run Inference](#7-run-inference)
  - [8. Release Resources](#8-release-resources)
- [Model File Reference](#model-file-reference)
- [License](#license)

---

## Supported platforms

| Platform | Architecture | Status | GPU Backend |
|----------|-------------|--------|-------------|
| macOS | arm64 | ✅ Tier 1 | Metal |
| macOS | x64 | ✅ Tier 1 | CPU / Metal |
| Linux | arm64, x64 | ✅ Tier 1 | Vulkan |
| Android | arm64 | ✅ Tier 1 | Vulkan, OpenCL |
| iOS | arm64 | ✅ Tier 1 | Metal |
| Windows | x64 | ✅ Tier 1 | Vulkan |

**Dependencies:**
- `stable-diffusion.cpp` (bundled via vcpkg overlay port)
- `ggml` (bundled alongside stable-diffusion.cpp)
- Bare Runtime ≥ 1.24.0
- CMake ≥ 3.25 and a C++20-capable compiler

---

## Prerequisites

Install the Bare Runtime globally:

```bash
npm install -g bare@latest
```

Verify the build toolchain is available:

```bash
cmake --version       # must be 3.25+
clang++ --version     # or g++ --version (g++-13 required on Ubuntu 22)
git --version
```

On **macOS**, Xcode Command Line Tools are required for Metal support:

```bash
xcode-select --install
```

---

## Building from Source

**1. Install npm dependencies** (fetches cmake-bare, cmake-vcpkg, and all JS dependencies):

```bash
npm install
```

**2. Build the native addon** (generates, compiles, and installs the `.bare` shared library into `prebuilds/`):

```bash
npm run build
```

The build process:
- Runs `bare-make generate` to configure CMake and download/build vcpkg dependencies (including `stable-diffusion.cpp` and `ggml`)
- Runs `bare-make build` to compile the C++ addon
- Runs `bare-make install` to copy the built `.bare` file to `prebuilds/`

> **First build note:** The vcpkg step clones and compiles `stable-diffusion.cpp` from source, which can take **5–15 minutes** depending on your machine and internet connection.

---

## Downloading Model Files

A download script is provided that fetches all required files for **FLUX.2 [klein] 4B**:

```bash
./scripts/download-model.sh
```

This downloads three files into the `models/` directory:

| File | Size | Description |
|------|------|-------------|
| `flux-2-klein-4b-Q8_0.gguf` | ~4.0 GB | FLUX.2 [klein] 4B diffusion model (Q8_0 quantised) |
| `Qwen3-4B-Q6_K.gguf` | ~3.1 GB | Qwen3 4B text encoder (Q6_K quantised) |
| `flux2-vae.safetensors` | ~321 MB | VAE decoder |

> **Note:** Downloads can be resumed if interrupted — the script uses `curl -C -` for resumable transfers.

### Why these specific files?

FLUX.2 [klein] uses a split model layout. Three separate components are required:

- **Diffusion model** (`flux-2-klein-4b-Q8_0.gguf`) — the main image transformer. This GGUF has no SD metadata KV pairs so it must be loaded via `diffusion_model_path` internally, not `model_path`.
- **Text encoder** (`Qwen3-4B-Q6_K.gguf`) — Qwen3 4B in standard GGML Q6_K format. The FP4 safetensors variant from ComfyUI (`qwen_3_4b_fp4_flux2.safetensors`) is **not supported** by ggml and will fail with a tensor shape error.
- **VAE** (`flux2-vae.safetensors`) — standard safetensors format, compatible as-is.

### Disk and RAM requirements

| Component | Disk | RAM at runtime |
|-----------|------|----------------|
| Diffusion model (Q8_0) | 4.0 GB | ~4.1 GB |
| Text encoder (Q6_K) | 3.1 GB | ~4.3 GB |
| VAE | 321 MB | ~95 MB |
| **Total** | **~7.4 GB** | **~8.5 GB** |

A machine with **16 GB of unified memory** (e.g. MacBook Air M-series) can run this model.

---

## Running the Example

After building and downloading the model files, run the load/unload example:

```bash
npm run example
```

Expected output:

```
FLUX.2 [klein] 4B — load/unload example
========================================
Models dir : .../models
Model      : flux-2-klein-4b-Q8_0.gguf
LLM encoder: Qwen3-4B-Q6_K.gguf
VAE        : flux2-vae.safetensors

Loading model weights (this takes a moment)...
...
Model loaded in 12.0s

Model is ready. (No inference in this example.)

Unloading model...
Done — all resources released.
```

The example source lives at [`examples/load-model.js`](./examples/load-model.js).

---

## Usage

### 1. Import the Model Class

```js
const ImgStableDiffusion = require('@qvac/img-stable-diffusion-cpp')
```

### 2. Create a Data Loader

Use `@qvac/dl-filesystem` to serve pre-downloaded model files from disk:

```js
const FilesystemDL = require('@qvac/dl-filesystem')
const path = require('bare-path')

const MODELS_DIR = path.resolve(__dirname, './models')
const loader = new FilesystemDL({ dirPath: MODELS_DIR })
```

### 3. Create the `args` object

```js
const args = {
  loader,
  logger: console,
  diskPath: MODELS_DIR,
  modelName:  'flux-2-klein-4b-Q8_0.gguf',
  llmModel:   'Qwen3-4B-Q6_K.gguf',   // Qwen3 text encoder for FLUX.2 [klein]
  vaeModel:   'flux2-vae.safetensors'
}
```

| Property | Required | Description |
|----------|----------|-------------|
| `loader` | ✅ | Data loader that provides model file access |
| `diskPath` | ✅ | Local directory where model files are stored |
| `modelName` | ✅ | Diffusion model file name |
| `logger` | — | Logger instance (e.g. `console`) |
| `clipLModel` | — | Separate CLIP-L text encoder (FLUX.1, SD3) |
| `clipGModel` | — | Separate CLIP-G text encoder (SDXL, SD3) |
| `t5XxlModel` | — | Separate T5-XXL text encoder (FLUX.1, SD3) |
| `llmModel` | — | Qwen3 LLM text encoder (FLUX.2 [klein]) |
| `vaeModel` | — | Separate VAE file |

### 4. Create the `config` object

```js
const config = {
  threads: 8  // CPU threads for tensor operations (Metal handles GPU automatically)
}
```

All config values are coerced to strings internally before being passed to the native layer.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `threads` | number | auto | Number of CPU threads for model loading and CPU ops |
| `wtype` | `'f32'` \| `'f16'` \| `'q4_0'` \| `'q8_0'` \| … | auto | Override weight quantisation type |
| `rng` | `'cpu'` \| `'cuda'` | `'cpu'` | RNG backend for sampling noise |
| `clip_on_cpu` | `true` \| `false` | `false` | Force CLIP encoder to run on CPU |
| `vae_on_cpu` | `true` \| `false` | `false` | Force VAE to run on CPU |
| `flash_attn` | `true` \| `false` | `false` | Enable flash attention (reduces memory) |
| `verbosity` | `0`–`3` | `0` | Log level: 0=error, 1=warn, 2=info, 3=debug |

### 5. Create a Model Instance

```js
const model = new ImgStableDiffusion(args, config)
```

The constructor stores configuration only — no memory is allocated yet.

### 6. Load the Model

```js
await model.load()
```

This downloads any missing files via the loader, creates the native `sd_ctx_t`, and loads all weights into memory. It can take 10–30 seconds depending on disk speed and model size.

Optionally track download progress:

```js
await model.load(true, progress => {
  process.stdout.write(`\rLoading: ${progress.overallProgress}%`)
})
```

### 7. Run Inference

#### Text-to-image

```js
const response = await model.txt2img({
  prompt: 'a photo of a cat sitting on a red sofa, cinematic lighting',
  width: 512,
  height: 512,
  steps: 20,
  cfg_scale: 7.0,
  seed: 42
})

// The output is a PNG-encoded Uint8Array
for await (const chunk of response.iterate()) {
  if (chunk instanceof Uint8Array) {
    require('bare-fs').writeFileSync('output.png', chunk)
  }
}
```

#### Image-to-image

```js
const inputPng = require('bare-fs').readFileSync('input.png')

const response = await model.img2img({
  prompt: 'a photo of a cat in a snowy landscape',
  init_image: inputPng,
  strength: 0.75,  // 0.0 = no change, 1.0 = full redraw
  steps: 20
})
```

#### Text-to-video (Wan2.x models only)

```js
const response = await model.txt2vid({
  prompt: 'a bird flying over the ocean',
  frames: 16,
  fps: 8,
  width: 512,
  height: 512,
  steps: 20
})
```

**Generation parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | — | Text prompt |
| `negative_prompt` | string | `''` | Things to avoid in the output |
| `width` | number | `512` | Output width in pixels |
| `height` | number | `512` | Output height in pixels |
| `steps` | number | `20` | Number of diffusion steps |
| `cfg_scale` | number | `7.0` | Classifier-free guidance scale |
| `sampler` | string | `'euler_a'` | Sampling method (`euler_a`, `euler`, `dpm++_2m`, …) |
| `seed` | number | `-1` | Random seed (-1 for random) |
| `batch_count` | number | `1` | Number of images to generate |

### 8. Release Resources

```js
await model.unload()
await loader.close()
```

`unload()` calls `free_sd_ctx` which releases all GPU and CPU memory. The JS object can be safely garbage collected afterwards.

---

## Model File Reference

### FLUX.2 [klein] 4B (recommended for 16 GB machines)

| Role | File | Source |
|------|------|--------|
| Diffusion model | `flux-2-klein-4b-Q8_0.gguf` | `leejet/FLUX.2-klein-4B-GGUF` |
| Text encoder | `Qwen3-4B-Q6_K.gguf` | `unsloth/Qwen3-4B-GGUF` |
| VAE | `flux2-vae.safetensors` | `Comfy-Org/vae-text-encorder-for-flux-klein-4b` |

> The `qwen_3_4b_fp4_flux2.safetensors` file from the ComfyUI repo **will not work** — FP4 quantisation is NVIDIA-specific and is not supported by ggml.

### FLUX.1 dev / schnell

| Role | Suggested file | Parameter |
|------|---------------|-----------|
| Diffusion model | `flux1-dev-Q4_K_M.gguf` | `modelName` |
| CLIP-L | `clip_l.safetensors` | `clipLModel` |
| T5-XXL | `t5xxl_fp16.safetensors` | `t5XxlModel` |
| VAE | `ae.safetensors` | `vaeModel` |

### Stable Diffusion 1.x / 2.x

Pass an all-in-one checkpoint directly as `modelName`. No separate encoders needed.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
