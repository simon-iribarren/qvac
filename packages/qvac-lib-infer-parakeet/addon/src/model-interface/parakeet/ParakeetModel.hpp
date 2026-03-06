#pragma once

#include <functional>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <tuple>
#include <type_traits>
#include <vector>

#include "ParakeetConfig.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

// Forward declarations for ONNX Runtime
namespace Ort {
class Env;
class Session;
class SessionOptions;
class MemoryInfo;
} // namespace Ort

namespace qvac_lib_infer_parakeet {

class ParakeetModel {
public:
  using OutputCallback = std::function<void(const Transcript &)>;
  using ValueType = float;
  using Input = std::vector<ValueType>;
  using InputView = std::span<const ValueType>;
  using Output = std::vector<Transcript>;

  explicit ParakeetModel(const ParakeetConfig &config);
  ~ParakeetModel();

  // Disable copy
  ParakeetModel(const ParakeetModel &) = delete;
  ParakeetModel &operator=(const ParakeetModel &) = delete;

  void initializeBackend();
  void setConfig(const ParakeetConfig &config) { cfg_ = config; }
  auto setOnSegmentCallback(const OutputCallback &callback) -> void {
    on_segment_ = callback;
  }
  auto addTranscription(const Transcript &transcript) -> void {
    output_.push_back(transcript);
  }

  void process(const Input &input);
  Output process(const Input &input,
                 std::function<void(const Output &)> callback);

  void load();
  void unload();
  void unloadWeights() { unload(); }
  void reload() {
    unload();
    load();
  }
  void reset() {
    output_.clear();
    stream_ended_ = false;
    processed_time_ = 0.0f;

    totalSamples_ = 0;
    totalTokens_ = 0;
    totalTranscriptions_ = 0;
    processCalls_ = 0;

    totalWallMs_ = 0;
    modelLoadMs_ = 0;
    melSpecMs_ = 0;
    encoderMs_ = 0;
    decoderMs_ = 0;

    totalMelFrames_ = 0;
    totalEncodedFrames_ = 0;
  }
  void endOfStream() { stream_ended_ = true; }
  bool isStreamEnded() const { return stream_ended_; }
  bool isLoaded() const { return is_loaded_; }
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats();
  void warmup();

  static std::vector<float>
  preprocessAudioData(const std::vector<uint8_t> &audioData,
                      const std::string &audioFormat = "s16le");

  void saveLoadParams(const ParakeetConfig &config) { cfg_ = config; }

  template <typename T, typename... Args>
  typename std::enable_if<
      !std::is_same<typename std::decay<T>::type, ParakeetConfig>::value,
      void>::type
  saveLoadParams(T &&, Args &&...) {}

  void set_weights_for_file(const std::string &filename,
                            const std::span<const uint8_t> &contents,
                            bool completed);

  // Streambuf version used by base Addon class
  void
  set_weights_for_file(const std::string &filename,
                       std::unique_ptr<std::basic_streambuf<char>> streambuf);

  template <typename T>
  void set_weights_for_file(const std::string &filename, T &&contents) {}

  std::string getName() const {
    switch (cfg_.modelType) {
    case ModelType::CTC:
      return "Parakeet-CTC";
    case ModelType::TDT:
      return "Parakeet-TDT";
    case ModelType::EOU:
      return "Parakeet-EOU";
    case ModelType::SORTFORMER:
      return "Parakeet-Sortformer";
    default:
      return "Parakeet";
    }
  }

private:
  std::pair<std::vector<float>, int64_t> runPreprocessor(const Input &audio);
  std::vector<float> computeMelSpectrogram(const Input &audio);
  std::vector<float> runEncoder(const std::vector<float> &melFeatures,
                                int64_t numFrames, int64_t &encodedLength,
                                bool alreadyTransposed = false);
  std::string greedyDecode(const std::vector<float> &encoderOutput,
                           int64_t encodedLength);
  void loadVocabulary(const std::vector<uint8_t> &vocabData);

  std::string runInferenceAndGetText(const Input &input);

  std::tuple<std::vector<float>, int64_t, bool>
  computeFeatures(const Input &audio);
  std::string runInferencePipeline(const Input &audio);

  ParakeetConfig cfg_;
  OutputCallback on_segment_;
  Output output_;
  bool stream_ended_ = false;
  bool is_loaded_ = false;
  bool is_warmed_up_ = false;
  std::unique_ptr<Ort::Env> ort_env_;
  std::unique_ptr<Ort::Session> preprocessor_session_;
  std::unique_ptr<Ort::Session> encoder_session_;
  std::unique_ptr<Ort::Session> decoder_session_;
  std::unique_ptr<Ort::MemoryInfo> memory_info_;
  std::map<std::string, std::vector<uint8_t>> model_weights_;
  std::vector<std::string> vocab_;
  static constexpr int64_t BLANK_TOKEN = 8192;
  static constexpr int64_t PAD_TOKEN = 2;
  static constexpr int64_t EOS_TOKEN = 3;
  static constexpr int64_t NOSPEECH_TOKEN = 1;
  static constexpr int64_t START_TRANSCRIPT = 4;
  static constexpr int64_t PREDICT_LANG = 22;
  int64_t getLanguageToken(const std::string &langCode) const;
  static constexpr int MEL_BINS = 128;
  static constexpr int FFT_SIZE = 512;
  static constexpr int HOP_LENGTH = 160;
  static constexpr int WIN_LENGTH = 400;
  static constexpr float SAMPLE_RATE = 16000.0f;
  static constexpr int ENCODER_DIM = 1024;
  static constexpr int DECODER_STATE_DIM = 640;
  float processed_time_ = 0.0f;
  int64_t totalSamples_ = 0;
  int64_t totalTokens_ = 0;
  int64_t totalTranscriptions_ = 0;
  int64_t processCalls_ = 0;
  int64_t totalWallMs_ = 0;
  int64_t modelLoadMs_ = 0;
  int64_t melSpecMs_ = 0;
  int64_t encoderMs_ = 0;
  int64_t decoderMs_ = 0;
  int64_t totalMelFrames_ = 0;
  int64_t totalEncodedFrames_ = 0;
};

} // namespace qvac_lib_infer_parakeet
