#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <streambuf>
#include <string>
#include <unordered_map>
#include <vector>

#include <stable-diffusion.h>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

/**
 * Core stable-diffusion.cpp model wrapper.
 *
 * Lifecycle:
 *   1. Construct  – stores paths and config, allocates nothing.
 *   2. load()     – calls new_sd_ctx(); weights are read from disk here.
 *   3. process()  – runs txt2img / img2img / txt2vid via generate_image/video.
 *   4. unload()   – calls free_sd_ctx() and releases all GPU/CPU memory.
 *      The destructor calls unload() automatically if the caller forgets.
 *
 * Wraps the struct-based stable-diffusion.cpp API:
 *   sd_ctx_params_t / new_sd_ctx()
 *   sd_img_gen_params_t / generate_image()
 *   sd_vid_gen_params_t / generate_video()
 */
class SdModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  SdModel(const SdModel&)            = delete;
  SdModel& operator=(const SdModel&) = delete;
  SdModel(SdModel&&)                 = delete;
  SdModel& operator=(SdModel&&)      = delete;

  /**
   * Stores all paths and config. Does NOT load weights — call load() for that.
   *
   * @param modelPath  Main weights file (.gguf / .safetensors / .ckpt)
   * @param clipLPath  Optional CLIP-L text encoder  (FLUX.1 / SD3)
   * @param clipGPath  Optional CLIP-G text encoder  (SDXL / SD3)
   * @param t5XxlPath  Optional T5-XXL text encoder  (FLUX.1 / SD3)
   * @param llmPath    Optional LLM text encoder     (FLUX.2 [klein] → Qwen3)
   * @param vaePath    Optional separate VAE
   * @param configMap  Key/value options: threads, wtype, rng, clip_on_cpu,
   *                   vae_on_cpu, flash_attn, verbosity
   */
  SdModel(
      std::string modelPath,
      std::string clipLPath,
      std::string clipGPath,
      std::string t5XxlPath,
      std::string llmPath,
      std::string vaePath,
      std::unordered_map<std::string, std::string> configMap);

  /**
   * Calls unload() — releases the sd_ctx if still alive.
   */
  ~SdModel() override;

  [[nodiscard]] std::string getName() const final { return "SdModel"; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Load model weights into memory.
   * Builds sd_ctx_params_t from the stored paths/config and calls new_sd_ctx().
   * Throws qvac_errors::StatusError on failure (bad path, unsupported format…).
   * No-op if already loaded.
   */
  void load();

  /**
   * Release all model memory (calls free_sd_ctx).
   * Safe to call multiple times. After unload() the object can be load()-ed
   * again to reload weights.
   */
  void unload();

  /**
   * Returns true if weights are currently loaded (sd_ctx is live).
   */
  [[nodiscard]] bool isLoaded() const noexcept { return sdCtx_ != nullptr; }

  // ── IModelAsyncLoad ────────────────────────────────────────────────────────
  // The framework calls waitForLoadInitialization() inside AddonCpp::activate().
  // For stable-diffusion.cpp all weights are local files so loading is
  // synchronous — waitForLoadInitialization simply calls load().
  // setWeightsForFile is a no-op (SD does not stream weight blobs).

  void waitForLoadInitialization() final { load(); }

  void setWeightsForFile(
      const std::string& /*filename*/,
      std::unique_ptr<std::basic_streambuf<char>>&& /*buf*/) final {}

  // ── IModel ─────────────────────────────────────────────────────────────────

  /**
   * Run a generation job.
   * Input must be a SdModel::GenerationJob wrapped in std::any.
   * Throws if the model is not loaded.
   */
  std::any process(const std::any& input) final;

  // ── IModelCancel ───────────────────────────────────────────────────────────

  void cancel() const final;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const final;

  // ── log callback (registered with sd_set_log_callback) ────────────────────

  static void sdLogCallback(sd_log_level_t level, const char* text, void* userData);

  // ── generation job input type ──────────────────────────────────────────────

  struct GenerationJob {
    std::string paramsJson;
    /** Called each diffusion step: {"step":N,"total":M,"elapsed_ms":T} */
    std::function<void(const std::string&)> progressCallback;
    /** Called once per output image/frame with PNG-encoded bytes */
    std::function<void(const std::vector<uint8_t>&)> outputCallback;
  };

private:
  static std::vector<uint8_t> encodeToPng(const sd_image_t& img);
  static sd_image_t           decodePng(const std::vector<uint8_t>& pngBytes);
  static sample_method_t      parseSampler(const std::string& name);
  static scheduler_t          parseScheduler(const std::string& name);
  static sd_type_t            parseWeightType(const std::string& name);

  // Stored at construction, consumed by load()
  const std::string modelPath_;
  const std::string clipLPath_;
  const std::string clipGPath_;
  const std::string t5XxlPath_;
  const std::string llmPath_;
  const std::string vaePath_;
  const std::unordered_map<std::string, std::string> configMap_;

  std::unique_ptr<sd_ctx_t, decltype(&free_sd_ctx)> sdCtx_;
  mutable std::atomic<bool>                          cancelRequested_{ false };
  mutable qvac_lib_inference_addon_cpp::RuntimeStats lastStats_{};
};
