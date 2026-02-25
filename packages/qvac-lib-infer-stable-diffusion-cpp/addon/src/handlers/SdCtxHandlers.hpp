#pragma once

#include <functional>
#include <string>
#include <unordered_map>

#include <stable-diffusion.h>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd {

/**
 * All load-time configuration for the stable-diffusion context.
 *
 * Populated in two steps inside AddonJs::createInstance:
 *   1. Paths set directly from JS args (path, clipLPath, llmPath, …)
 *   2. Config options resolved via applySdCtxHandlers(config, configMap)
 *
 * Consumed once in SdModel::load() where new_sd_ctx() is called.
 *
 * Supported models:
 *   SD1.x  — uses modelPath (all-in-one .ckpt / .safetensors)
 *   SD2.x  — same as SD1, add prediction="v" to the config
 *   SDXL   — uses modelPath, add clipGModel if split; set force_sdxl_vae_conv_scale if needed
 *   FLUX.2 [klein] — uses diffusionModelPath + llmPath (Qwen3) + vaeModel
 */
struct SdCtxConfig {
  // ── Model file paths ───────────────────────────────────────────────────────
  // All paths are absolute; empty string = not used.

  std::string modelPath;           // model_path            — SD1.x/SDXL all-in-one checkpoint
  std::string diffusionModelPath;  // diffusion_model_path  — FLUX.2 [klein] standalone diffusion GGUF
  std::string clipLPath;           // clip_l_path           — CLIP-L text encoder (SD1.x / SDXL)
  std::string clipGPath;           // clip_g_path           — CLIP-G text encoder (SDXL)
  std::string llmPath;             // llm_path              — LLM text encoder (FLUX.2 → Qwen3)
  std::string vaePath;             // vae_path              — standalone VAE decoder weights
  std::string taesdPath;           // taesd_path            — Tiny AutoEncoder (optional fast preview)

  // ── Compute ───────────────────────────────────────────────────────────────
  int  nThreads          = -1;    // n_threads:            -1 = auto-detect physical cores
  bool flashAttn         = false; // flash_attn:           full-model flash attention
  bool diffusionFlashAttn = false;// diffusion_flash_attn: flash attention on diffusion only

  // ── Memory management ─────────────────────────────────────────────────────
  bool mmap          = false;     // enable_mmap:           memory-map the GGUF file
  bool offloadToCpu  = false;     // offload_params_to_cpu: keep weights in RAM, load per-layer to GPU
  bool keepClipOnCpu = false;     // keep_clip_on_cpu:      keep CLIP encoder in CPU RAM
  bool keepVaeOnCpu  = false;     // keep_vae_on_cpu:       keep VAE decoder in CPU RAM

  // ── Precision ─────────────────────────────────────────────────────────────
  sd_type_t wtype = SD_TYPE_COUNT;         // global weight type override; COUNT = auto (use GGUF)
  std::string tensorTypeRules;             // per-tensor rules e.g. "^vae.=f16,model.=q8_0"

  // ── Sampling RNG (Random Number Generator) ────────────────────────────────
  rng_type_t rngType        = CPU_RNG;    // rng_type
  rng_type_t samplerRngType = CPU_RNG;    // sampler_rng_type (independent RNG for noise schedule)

  // ── Prediction type (set explicitly if auto-detection fails) ──────────────
  // EPS_PRED = classic SD1.x epsilon prediction
  // V_PRED   = v-prediction (SD2.x)
  // FLUX2_FLOW_PRED = FLUX.2 flow matching
  // Leave as EPS_PRED to rely on model auto-detection.
  prediction_t prediction = EPS_PRED;

  // ── LoRA (Low-Rank Adaptation) apply mode ─────────────────────────────────
  lora_apply_mode_t loraApplyMode = LORA_APPLY_AUTO;

  // ── Flow matching (FLUX, SD3) ─────────────────────────────────────────────
  float flowShift = 0.0f;                 // 0 = auto; tune for noise-schedule quality

  // ── Convolution kernel options ────────────────────────────────────────────
  bool diffusionConvDirect   = false;     // ggml_conv2d_direct in diffusion model
  bool vaeConvDirect         = false;     // ggml_conv2d_direct in VAE

  // ── Tiling convolutions (produces seamlessly tileable images) ─────────────
  bool circularX = false;                 // circular RoPE wrap on X-axis (width)
  bool circularY = false;                 // circular RoPE wrap on Y-axis (height)

  // ── SDXL compatibility ────────────────────────────────────────────────────
  bool forceSDXLVaeConvScale = false;     // force SDXL VAE conv scale (compat fix)

  // ── Internal ──────────────────────────────────────────────────────────────
  bool freeParamsImmediately = true;
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler function for a single configMap key.
 * Receives the config struct (by ref) and the raw string value from JS.
 * Throws qvac_errors::StatusError on invalid input.
 */
using SdCtxHandlerFn   = std::function<void(SdCtxConfig&, const std::string&)>;
using SdCtxHandlersMap = std::unordered_map<std::string, SdCtxHandlerFn>;

/** All supported load-time config keys and their handlers. */
extern const SdCtxHandlersMap SD_CTX_HANDLERS;

/**
 * Apply SD_CTX_HANDLERS to configMap, writing results into config.
 * Unknown keys are silently ignored (forward compatibility).
 */
void applySdCtxHandlers(
    SdCtxConfig& config,
    const std::unordered_map<std::string, std::string>& configMap);

} // namespace qvac_lib_inference_addon_sd
