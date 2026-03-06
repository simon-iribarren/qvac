#include "ParakeetModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstring>
#include <filesystem>
#include <fstream>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include <iostream>
#include <istream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "onnxruntime/onnxruntime_cxx_api.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <Eigen/Core>
#include <unsupported/Eigen/FFT>

namespace qvac_lib_infer_parakeet {

namespace {

constexpr float MEL_HZ_TO_MEL_FACTOR = 2595.0f;
constexpr float MEL_HZ_BASE = 700.0f;
constexpr size_t WARMUP_SAMPLES = 8000;
constexpr float S16LE_NORMALIZE = 32768.0f;
constexpr float MEL_EPS = 1e-10f;
constexpr int MAX_TOKENS_PER_STEP = 10;
constexpr const char *SENTENCEPIECE_SPACE_UTF8 = "\xe2\x96\x81";

template <typename Func>
void measureTime(int64_t &accumulator, Func &&operation) {
  auto start = std::chrono::high_resolution_clock::now();
  operation();
  auto end = std::chrono::high_resolution_clock::now();
  accumulator +=
      std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
          .count();
}

std::string parseVocabularyLine(const std::string &line) {
  size_t spacePos = line.rfind(' ');
  if (spacePos != std::string::npos) {
    return line.substr(0, spacePos);
  }
  return line;
}

void fillVocabularyFromStream(std::istringstream &iss,
                              std::vector<std::string> &vocab) {
  std::string line;
  while (std::getline(iss, line)) {
    vocab.push_back(parseVocabularyLine(line));
  }
}

void applySessionOptions(Ort::SessionOptions &options, int maxThreads,
                         int64_t seed) {
  options.SetIntraOpNumThreads(maxThreads);
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  if (seed >= 0) {
    options.SetDeterministicCompute(true);
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "Deterministic compute enabled (seed=" + std::to_string(seed) + ")");
  }
}

void loadEncoderFromNamedPaths(Ort::Env &env, const std::string &encoderPath,
                               const std::string &encoderDataPath,
                               Ort::SessionOptions &sessionOptions,
                               std::unique_ptr<Ort::Session> &outSession) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading encoder from path: " + encoderPath);
  bool hasExternalData =
      !encoderDataPath.empty() && std::filesystem::exists(encoderDataPath);
  if (hasExternalData) {
    std::filesystem::path stagingDir =
        std::filesystem::temp_directory_path() /
        ("parakeet_enc_" +
         std::to_string(
             std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(stagingDir);
    auto encLink = stagingDir / "encoder-model.onnx";
    auto dataLink = stagingDir / "encoder-model.onnx.data";
    std::filesystem::create_symlink(encoderPath, encLink);
    std::filesystem::create_symlink(encoderDataPath, dataLink);
    try {
      outSession =
          std::make_unique<Ort::Session>(env, encLink.c_str(), sessionOptions);
    } catch (...) {
      std::filesystem::remove_all(stagingDir);
      throw;
    }
    std::filesystem::remove_all(stagingDir);
  } else {
#ifdef _WIN32
    std::wstring wPath(encoderPath.begin(), encoderPath.end());
    outSession =
        std::make_unique<Ort::Session>(env, wPath.c_str(), sessionOptions);
#else
    outSession = std::make_unique<Ort::Session>(env, encoderPath.c_str(),
                                                sessionOptions);
#endif
  }
}

void loadEncoderFromWeights(
    Ort::Env &env, const std::string &modelPath,
    const std::map<std::string, std::vector<uint8_t>> &model_weights_,
    Ort::SessionOptions &sessionOptions,
    std::unique_ptr<Ort::Session> &outSession) {
  auto encoderIt = model_weights_.find("encoder-model.onnx");
  if (encoderIt == model_weights_.end()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         "Encoder model weights not found");
    throw std::runtime_error("Encoder model not loaded");
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading encoder session...");
  std::string encoderPath = modelPath + "/encoder-model.onnx";
  std::string encoderDataPath = modelPath + "/encoder-model.onnx.data";
  bool hasExternalData = std::filesystem::exists(encoderDataPath);
  if (hasExternalData) {
#ifdef _WIN32
    std::wstring wEncoderPath(encoderPath.begin(), encoderPath.end());
    outSession = std::make_unique<Ort::Session>(env, wEncoderPath.c_str(),
                                                sessionOptions);
#else
    outSession = std::make_unique<Ort::Session>(env, encoderPath.c_str(),
                                                sessionOptions);
#endif
  } else {
    outSession = std::make_unique<Ort::Session>(env, encoderIt->second.data(),
                                                encoderIt->second.size(),
                                                sessionOptions);
  }
}

void loadDecoderFromNamedPaths(Ort::Env &env, const std::string &decoderPath,
                               Ort::SessionOptions &sessionOptions,
                               std::unique_ptr<Ort::Session> &outSession) {
#ifdef _WIN32
  std::wstring wPath(decoderPath.begin(), decoderPath.end());
  outSession =
      std::make_unique<Ort::Session>(env, wPath.c_str(), sessionOptions);
#else
  outSession =
      std::make_unique<Ort::Session>(env, decoderPath.c_str(), sessionOptions);
#endif
}

void loadDecoderFromWeights(
    Ort::Env &env,
    const std::map<std::string, std::vector<uint8_t>> &model_weights_,
    Ort::SessionOptions &sessionOptions,
    std::unique_ptr<Ort::Session> &outSession) {
  auto decoderIt = model_weights_.find("decoder_joint-model.onnx");
  if (decoderIt == model_weights_.end()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         "Decoder model weights not found");
    throw std::runtime_error("Decoder model not loaded");
  }
  outSession = std::make_unique<Ort::Session>(
      env, decoderIt->second.data(), decoderIt->second.size(), sessionOptions);
}

void loadPreprocessorFromNamedPaths(Ort::Env &env,
                                    const std::string &preprocessorPath,
                                    Ort::SessionOptions &sessionOptions,
                                    std::unique_ptr<Ort::Session> &outSession) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading preprocessor session...");
#ifdef _WIN32
  std::wstring wPath(preprocessorPath.begin(), preprocessorPath.end());
  outSession =
      std::make_unique<Ort::Session>(env, wPath.c_str(), sessionOptions);
#else
  outSession = std::make_unique<Ort::Session>(env, preprocessorPath.c_str(),
                                              sessionOptions);
#endif
}

void loadPreprocessorFromWeights(
    Ort::Env &env,
    const std::map<std::string, std::vector<uint8_t>> &model_weights_,
    Ort::SessionOptions &sessionOptions,
    std::unique_ptr<Ort::Session> &outSession) {
  auto preprocessorIt = model_weights_.find("preprocessor.onnx");
  if (preprocessorIt != model_weights_.end()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Loading preprocessor session...");
    outSession = std::make_unique<Ort::Session>(
        env, preprocessorIt->second.data(), preprocessorIt->second.size(),
        sessionOptions);
  }
}

void loadVocabFromFileIfNeeded(
    const std::string &vocabPath, std::vector<std::string> &vocab,
    std::function<void(const std::vector<uint8_t> &)> loadVocabulary) {
  if (vocabPath.empty() || !vocab.empty())
    return;
  std::ifstream vocabFile(vocabPath, std::ios::binary);
  if (!vocabFile.is_open())
    return;
  std::vector<uint8_t> vocabData((std::istreambuf_iterator<char>(vocabFile)),
                                 std::istreambuf_iterator<char>());
  loadVocabulary(vocabData);
}

void copyEncoderSliceAt(const float *encoderOutput, int64_t encodedLength,
                        int64_t t, int encoderDim,
                        std::vector<float> &encoderSlice) {
  for (int i = 0; i < encoderDim; ++i) {
    encoderSlice[i] = encoderOutput[i * encodedLength + t];
  }
}

size_t argmaxFloat(const float *data, size_t n) {
  size_t bestIdx = 0;
  float best = data[0];
  for (size_t i = 1; i < n; ++i) {
    if (data[i] > best) {
      best = data[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}

bool isSpecialToken(const std::string &piece) {
  return piece.size() >= 2 && piece[0] == '<' && piece.back() == '>';
}

void replaceSentencepieceSpacesInPlace(std::string &piece) {
  size_t pos = 0;
  while ((pos = piece.find(SENTENCEPIECE_SPACE_UTF8, pos)) !=
         std::string::npos) {
    piece.replace(pos, 3, " ");
    pos += 1;
  }
}

std::string tokensToText(const std::vector<int64_t> &decodedTokens,
                         const std::vector<std::string> &vocab) {
  std::string result;
  for (int64_t token : decodedTokens) {
    if (token < 0 || static_cast<size_t>(token) >= vocab.size())
      continue;
    std::string piece = vocab[static_cast<size_t>(token)];
    if (piece.empty())
      continue;
    if (isSpecialToken(piece))
      continue;
    replaceSentencepieceSpacesInPlace(piece);
    result += piece;
  }
  size_t start = result.find_first_not_of(' ');
  size_t end = result.find_last_not_of(' ');
  if (start != std::string::npos && end != std::string::npos) {
    result = result.substr(start, end - start + 1);
  }
  return result;
}

void decodeS16LeToFloat(const std::vector<uint8_t> &audioData,
                        std::vector<float> &result) {
  result.reserve(audioData.size() / 2);
  for (size_t i = 0; i + 1 < audioData.size(); i += 2) {
    int16_t sample = static_cast<int16_t>(audioData[i]) |
                     (static_cast<int16_t>(audioData[i + 1]) << 8);
    result.push_back(static_cast<float>(sample) / S16LE_NORMALIZE);
  }
}

} // namespace

ParakeetModel::ParakeetModel(const ParakeetConfig &config) : cfg_(config) {
  ort_env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "Parakeet");
  reset();
}

ParakeetModel::~ParakeetModel() { unload(); }

void ParakeetModel::initializeBackend() {
  // Already initialized in constructor
}

void ParakeetModel::set_weights_for_file(
    const std::string &filename, const std::span<const uint8_t> &contents,
    bool completed) {
  if (completed) {
    model_weights_[filename] =
        std::vector<uint8_t>(contents.begin(), contents.end());
    if (filename == "vocab.txt") {
      loadVocabulary(model_weights_[filename]);
    }
  }
}

void ParakeetModel::set_weights_for_file(
    const std::string &filename,
    std::unique_ptr<std::basic_streambuf<char>> streambuf) {
  std::istream stream(streambuf.get());
  std::vector<uint8_t> data((std::istreambuf_iterator<char>(stream)),
                            std::istreambuf_iterator<char>());

  model_weights_[filename] = std::move(data);
  if (filename == "vocab.txt") {
    loadVocabulary(model_weights_[filename]);
  }
}

void ParakeetModel::loadVocabulary(const std::vector<uint8_t> &vocabData) {
  std::string vocabStr(vocabData.begin(), vocabData.end());
  std::istringstream iss(vocabStr);
  vocab_.clear();
  fillVocabularyFromStream(iss, vocab_);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loaded vocabulary with " + std::to_string(vocab_.size()) + " tokens");
}

void ParakeetModel::load() {
  if (is_loaded_)
    return;
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loading Parakeet models from: " + cfg_.modelPath);
  auto loadStart = std::chrono::high_resolution_clock::now();
  try {
    memory_info_ = std::make_unique<Ort::MemoryInfo>(
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault));
    Ort::SessionOptions sessionOptions;
    applySessionOptions(sessionOptions, cfg_.maxThreads, cfg_.seed);
    const bool useNamedPaths = !cfg_.encoderPath.empty();

    if (useNamedPaths) {
      loadEncoderFromNamedPaths(*ort_env_, cfg_.encoderPath,
                                cfg_.encoderDataPath, sessionOptions,
                                encoder_session_);
    } else {
      loadEncoderFromWeights(*ort_env_, cfg_.modelPath, model_weights_,
                             sessionOptions, encoder_session_);
    }

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Loading decoder session...");
    if (useNamedPaths && !cfg_.decoderPath.empty()) {
      loadDecoderFromNamedPaths(*ort_env_, cfg_.decoderPath, sessionOptions,
                                decoder_session_);
    } else {
      loadDecoderFromWeights(*ort_env_, model_weights_, sessionOptions,
                             decoder_session_);
    }

    if (useNamedPaths && !cfg_.preprocessorPath.empty()) {
      loadPreprocessorFromNamedPaths(*ort_env_, cfg_.preprocessorPath,
                                     sessionOptions, preprocessor_session_);
    } else {
      loadPreprocessorFromWeights(*ort_env_, model_weights_, sessionOptions,
                                  preprocessor_session_);
    }

    if (useNamedPaths) {
      loadVocabFromFileIfNeeded(
          cfg_.vocabPath, vocab_,
          [this](const std::vector<uint8_t> &d) { loadVocabulary(d); });
    }

    is_loaded_ = true;
    auto loadEnd = std::chrono::high_resolution_clock::now();
    modelLoadMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                       loadEnd - loadStart)
                       .count();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "Parakeet models loaded successfully in " +
             std::to_string(modelLoadMs_) + "ms");

    if (!is_warmed_up_) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Warming up Parakeet model");
      warmup();
      is_warmed_up_ = true;
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Parakeet model warmup completed");
    }
  } catch (const Ort::Exception &e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("ONNX Runtime error: ") + e.what());
    throw;
  }
}

void ParakeetModel::unload() {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Unloading Parakeet model");

  preprocessor_session_.reset();
  encoder_session_.reset();
  decoder_session_.reset();
  memory_info_.reset();
  is_loaded_ = false;
  is_warmed_up_ = false;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Parakeet model unloaded successfully");
}

std::tuple<std::vector<float>, int64_t, bool>
ParakeetModel::computeFeatures(const Input &audio) {
  std::vector<float> melFeatures;
  int64_t numFrames = 0;
  bool alreadyTransposed = false;
  if (preprocessor_session_) {
    auto [features, frames] = runPreprocessor(audio);
    melFeatures = std::move(features);
    numFrames = frames;
    alreadyTransposed = true;
  } else {
    melFeatures = computeMelSpectrogram(audio);
    numFrames = static_cast<int64_t>(melFeatures.size() / MEL_BINS);
    alreadyTransposed = false;
  }
  return {std::move(melFeatures), numFrames, alreadyTransposed};
}

std::string ParakeetModel::runInferencePipeline(const Input &audio) {
  auto [melFeatures, numFrames, alreadyTransposed] = computeFeatures(audio);
  if (melFeatures.empty() || numFrames <= 0)
    return "";
  int64_t encodedLength = 0;
  auto encoderOutput =
      runEncoder(melFeatures, numFrames, encodedLength, alreadyTransposed);
  if (encoderOutput.empty() || encodedLength <= 0)
    return "";
  return greedyDecode(encoderOutput, encodedLength);
}

void ParakeetModel::warmup() {
  if (!is_loaded_ || !encoder_session_ || !decoder_session_) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Cannot warmup - model not loaded");
    return;
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Starting model warmup");
  auto warmupStart = std::chrono::high_resolution_clock::now();
  std::vector<float> silentAudio(WARMUP_SAMPLES, 0.0f);
  try {
    runInferencePipeline(silentAudio);
    auto warmupEnd = std::chrono::high_resolution_clock::now();
    auto warmupMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        warmupEnd - warmupStart)
                        .count();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Model warmup completed in " + std::to_string(warmupMs) + "ms");
  } catch (const std::exception &e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         std::string("Warmup inference failed (non-fatal): ") + e.what());
  }
}

float hzToMel(float hz) {
  return MEL_HZ_TO_MEL_FACTOR * std::log10(1.0f + hz / MEL_HZ_BASE);
}

float melToHz(float mel) {
  return MEL_HZ_BASE * (std::pow(10.0f, mel / MEL_HZ_TO_MEL_FACTOR) - 1.0f);
}

void fillMelPoints(std::vector<float> &melPoints, float melMin, float melMax) {
  const int n = static_cast<int>(melPoints.size());
  for (int i = 0; i < n; ++i) {
    melPoints[i] = melMin + (melMax - melMin) * i / (n - 1);
  }
}

void fillBinPoints(const std::vector<float> &melPoints, int fftSize,
                   float sampleRate, std::vector<int> &binPoints) {
  for (size_t i = 0; i < melPoints.size(); ++i) {
    float hz = melToHz(melPoints[i]);
    binPoints[i] =
        static_cast<int>(std::floor((fftSize + 1) * hz / sampleRate));
  }
}

void fillFilterbankSlopes(std::vector<std::vector<float>> &filterbank,
                          const std::vector<int> &binPoints, int numFftBins) {
  const int numMelBins = static_cast<int>(filterbank.size());
  for (int m = 0; m < numMelBins; ++m) {
    int left = binPoints[m];
    int center = binPoints[m + 1];
    int right = binPoints[m + 2];
    for (int k = left; k < center && k < numFftBins; ++k) {
      if (center != left) {
        filterbank[m][k] = static_cast<float>(k - left) / (center - left);
      }
    }
    for (int k = center; k < right && k < numFftBins; ++k) {
      if (right != center) {
        filterbank[m][k] = static_cast<float>(right - k) / (right - center);
      }
    }
  }
}

std::vector<std::vector<float>> buildMelFilterbank(int numMelBins, int fftSize,
                                                   float sampleRate, float fMin,
                                                   float fMax) {
  int numFftBins = fftSize / 2 + 1;
  float melMin = hzToMel(fMin);
  float melMax = hzToMel(fMax);
  std::vector<float> melPoints(numMelBins + 2);
  fillMelPoints(melPoints, melMin, melMax);
  std::vector<int> binPoints(numMelBins + 2);
  fillBinPoints(melPoints, fftSize, sampleRate, binPoints);
  std::vector<std::vector<float>> filterbank(
      numMelBins, std::vector<float>(numFftBins, 0.0f));
  fillFilterbankSlopes(filterbank, binPoints, numFftBins);
  return filterbank;
}

void buildHannWindow(int winLength, std::vector<float> &hannWindow) {
  for (int i = 0; i < winLength; ++i) {
    hannWindow[i] = 0.5f * (1.0f - std::cos(2.0f * static_cast<float>(M_PI) *
                                            i / (winLength - 1)));
  }
}

void computePowerSpectrum(const std::vector<std::complex<float>> &spectrum,
                          int numFftBins, std::vector<float> &powerSpec) {
  for (int k = 0; k < numFftBins; ++k) {
    powerSpec[k] = std::norm(spectrum[k]);
  }
}

void applyMelFilterbankToPower(
    const std::vector<std::vector<float>> &melFilterbank,
    const std::vector<float> &powerSpec, int melBins, int numFftBins,
    float *melRow) {
  for (int m = 0; m < melBins; ++m) {
    float melEnergy = 0.0f;
    for (int k = 0; k < numFftBins; ++k) {
      melEnergy += melFilterbank[m][k] * powerSpec[k];
    }
    melRow[m] = std::log(std::max(melEnergy, MEL_EPS));
  }
}

void computeCmvnMean(const std::vector<float> &melSpec, size_t numFrames,
                     int melBins, std::vector<float> &mean) {
  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < melBins; ++m) {
      mean[m] += melSpec[f * melBins + m];
    }
  }
  for (int m = 0; m < melBins; ++m) {
    mean[m] /= static_cast<float>(numFrames);
  }
}

void computeCmvnStddev(const std::vector<float> &melSpec, size_t numFrames,
                       int melBins, const std::vector<float> &mean,
                       std::vector<float> &stddev) {
  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < melBins; ++m) {
      float diff = melSpec[f * melBins + m] - mean[m];
      stddev[m] += diff * diff;
    }
  }
  for (int m = 0; m < melBins; ++m) {
    stddev[m] = std::sqrt(stddev[m] / static_cast<float>(numFrames) + MEL_EPS);
  }
}

void applyCmvnNormalize(std::vector<float> &melSpec, size_t numFrames,
                        int melBins, const std::vector<float> &mean,
                        const std::vector<float> &stddev) {
  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < melBins; ++m) {
      melSpec[f * melBins + m] =
          (melSpec[f * melBins + m] - mean[m]) / stddev[m];
    }
  }
}

std::vector<float> ParakeetModel::computeMelSpectrogram(const Input &audio) {
  const size_t numSamples = audio.size();
  if (numSamples < static_cast<size_t>(WIN_LENGTH))
    return {};
  const size_t numFrames = (numSamples - WIN_LENGTH) / HOP_LENGTH + 1;
  if (numFrames == 0)
    return {};

  std::vector<float> hannWindow(WIN_LENGTH);
  buildHannWindow(WIN_LENGTH, hannWindow);

  constexpr float FMAX_NYQUIST = SAMPLE_RATE / 2.0f;
  static auto melFilterbank =
      buildMelFilterbank(MEL_BINS, FFT_SIZE, SAMPLE_RATE, 0.0f, FMAX_NYQUIST);

  Eigen::FFT<float> fft;
  const int numFftBins = FFT_SIZE / 2 + 1;
  std::vector<float> melSpec(numFrames * MEL_BINS);
  std::vector<float> frame(FFT_SIZE, 0.0f);
  std::vector<std::complex<float>> spectrum(FFT_SIZE);
  std::vector<float> powerSpec(numFftBins);

  for (size_t f = 0; f < numFrames; ++f) {
    size_t startSample = f * HOP_LENGTH;
    std::fill(frame.begin(), frame.end(), 0.0f);
    for (int i = 0; i < WIN_LENGTH && (startSample + i) < numSamples; ++i) {
      frame[i] = audio[startSample + i] * hannWindow[i];
    }
    fft.fwd(spectrum, frame);
    computePowerSpectrum(spectrum, numFftBins, powerSpec);
    applyMelFilterbankToPower(melFilterbank, powerSpec, MEL_BINS, numFftBins,
                              &melSpec[f * MEL_BINS]);
  }

  std::vector<float> mean(MEL_BINS, 0.0f);
  std::vector<float> stddev(MEL_BINS, 0.0f);
  computeCmvnMean(melSpec, numFrames, MEL_BINS, mean);
  computeCmvnStddev(melSpec, numFrames, MEL_BINS, mean, stddev);
  applyCmvnNormalize(melSpec, numFrames, MEL_BINS, mean, stddev);
  return melSpec;
}

void transposeMelFramesToBins(const std::vector<float> &melFeatures,
                              int64_t numFrames, int melBins,
                              std::vector<float> &encoderInput) {
  encoderInput.resize(melFeatures.size());
  for (int64_t f = 0; f < numFrames; ++f) {
    for (int b = 0; b < melBins; ++b) {
      encoderInput[b * numFrames + f] = melFeatures[f * melBins + b];
    }
  }
}

std::vector<float>
ParakeetModel::runEncoder(const std::vector<float> &melFeatures,
                          int64_t numFrames, int64_t &encodedLength,
                          bool alreadyTransposed) {
  if (!encoder_session_)
    throw std::runtime_error("Encoder session not initialized");
  std::vector<float> encoderInput;
  if (alreadyTransposed) {
    encoderInput = melFeatures;
  } else {
    transposeMelFramesToBins(melFeatures, numFrames, MEL_BINS, encoderInput);
  }
  std::vector<int64_t> inputShape = {1, MEL_BINS, numFrames};
  Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, encoderInput.data(), encoderInput.size(),
      inputShape.data(), inputShape.size());
  std::vector<int64_t> lengthData = {numFrames};
  std::vector<int64_t> lengthShape = {1};
  Ort::Value lengthTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, lengthData.data(), lengthData.size(), lengthShape.data(),
      lengthShape.size());
  const char *inputNames[] = {"audio_signal", "length"};
  const char *outputNames[] = {"outputs", "encoded_lengths"};
  std::vector<Ort::Value> inputTensors;
  inputTensors.push_back(std::move(inputTensor));
  inputTensors.push_back(std::move(lengthTensor));
  auto outputs = encoder_session_->Run(Ort::RunOptions{nullptr}, inputNames,
                                       inputTensors.data(), inputTensors.size(),
                                       outputNames, 2);
  auto &encoderOutput = outputs[0];
  auto outputInfo = encoderOutput.GetTensorTypeAndShapeInfo();
  size_t outputSize = outputInfo.GetElementCount();
  const float *outputData = encoderOutput.GetTensorData<float>();
  const int64_t *lengthPtr = outputs[1].GetTensorData<int64_t>();
  encodedLength = lengthPtr[0];
  return std::vector<float>(outputData, outputData + outputSize);
}

size_t findTokenIndexInVocab(const std::vector<std::string> &vocab,
                             const std::string &token) {
  for (size_t i = 0; i < vocab.size(); ++i) {
    if (vocab[i] == token)
      return i;
  }
  return vocab.size();
}

int64_t ParakeetModel::getLanguageToken(const std::string &langCode) const {
  std::string langToken = "<|" + langCode + "|>";
  size_t idx = findTokenIndexInVocab(vocab_, langToken);
  return idx < vocab_.size() ? static_cast<int64_t>(idx) : PREDICT_LANG;
}

std::string ParakeetModel::greedyDecode(const std::vector<float> &encoderOutput,
                                        int64_t encodedLength) {
  if (!decoder_session_ || vocab_.empty())
    return "[Model not ready]";
  const size_t vocabSize = vocab_.size();
  std::vector<int64_t> decodedTokens;
  constexpr int STATE_LAYERS = 2;
  constexpr int STATE_BATCH = 1;
  std::vector<float> state1(STATE_LAYERS * STATE_BATCH * DECODER_STATE_DIM,
                            0.0f);
  std::vector<float> state2(STATE_LAYERS * STATE_BATCH * DECODER_STATE_DIM,
                            0.0f);
  int32_t lastEmittedToken = static_cast<int32_t>(BLANK_TOKEN);
  int tokensThisFrame = 0;
  int skip = 0;

  for (int64_t t = 0; t < encodedLength; t += skip) {
    std::vector<float> encoderSlice(ENCODER_DIM);
    copyEncoderSliceAt(encoderOutput.data(), encodedLength, t, ENCODER_DIM,
                       encoderSlice);
    std::vector<int64_t> encoderShape = {1, ENCODER_DIM, 1};
    Ort::Value encoderTensor = Ort::Value::CreateTensor<float>(
        *memory_info_, encoderSlice.data(), encoderSlice.size(),
        encoderShape.data(), encoderShape.size());
    std::vector<int32_t> targetData = {lastEmittedToken};
    std::vector<int64_t> targetShape = {1, 1};
    Ort::Value targetTensor = Ort::Value::CreateTensor<int32_t>(
        *memory_info_, targetData.data(), targetData.size(), targetShape.data(),
        targetShape.size());
    std::vector<int32_t> targetLengthData = {1};
    std::vector<int64_t> targetLengthShape = {1};
    Ort::Value targetLengthTensor = Ort::Value::CreateTensor<int32_t>(
        *memory_info_, targetLengthData.data(), targetLengthData.size(),
        targetLengthShape.data(), targetLengthShape.size());
    std::vector<int64_t> stateShape = {STATE_LAYERS, STATE_BATCH,
                                       DECODER_STATE_DIM};
    Ort::Value state1Tensor = Ort::Value::CreateTensor<float>(
        *memory_info_, state1.data(), state1.size(), stateShape.data(),
        stateShape.size());
    Ort::Value state2Tensor = Ort::Value::CreateTensor<float>(
        *memory_info_, state2.data(), state2.size(), stateShape.data(),
        stateShape.size());
    const char *decoderInputNames[] = {"encoder_outputs", "targets",
                                       "target_length", "input_states_1",
                                       "input_states_2"};
    const char *decoderOutputNames[] = {"outputs", "prednet_lengths",
                                        "output_states_1", "output_states_2"};
    std::vector<Ort::Value> decoderInputs;
    decoderInputs.push_back(std::move(encoderTensor));
    decoderInputs.push_back(std::move(targetTensor));
    decoderInputs.push_back(std::move(targetLengthTensor));
    decoderInputs.push_back(std::move(state1Tensor));
    decoderInputs.push_back(std::move(state2Tensor));
    auto decoderOutputs = decoder_session_->Run(
        Ort::RunOptions{nullptr}, decoderInputNames, decoderInputs.data(),
        decoderInputs.size(), decoderOutputNames, 4);
    const float *logits = decoderOutputs[0].GetTensorData<float>();
    auto logitsInfo = decoderOutputs[0].GetTensorTypeAndShapeInfo();
    size_t outputSize = logitsInfo.GetShape().back();
    size_t numDurations = outputSize - vocabSize;
    const float *tokenLogits = logits;
    const float *durationLogits = logits + vocabSize;
    int64_t tokenId = static_cast<int64_t>(argmaxFloat(tokenLogits, vocabSize));
    skip = numDurations > 0
               ? static_cast<int>(argmaxFloat(durationLogits, numDurations))
               : 0;

    if (tokenId != BLANK_TOKEN) {
      const float *newState1 = decoderOutputs[2].GetTensorData<float>();
      const float *newState2 = decoderOutputs[3].GetTensorData<float>();
      std::copy(newState1, newState1 + state1.size(), state1.begin());
      std::copy(newState2, newState2 + state2.size(), state2.begin());
      if (tokenId == EOS_TOKEN)
        break;
      if (tokenId != NOSPEECH_TOKEN && tokenId != PAD_TOKEN) {
        decodedTokens.push_back(tokenId);
      }
      lastEmittedToken = static_cast<int32_t>(tokenId);
      tokensThisFrame++;
    }
    if (skip > 0)
      tokensThisFrame = 0;
    if (tokensThisFrame >= MAX_TOKENS_PER_STEP) {
      tokensThisFrame = 0;
      skip = 1;
    }
    if (tokenId == BLANK_TOKEN && skip == 0) {
      tokensThisFrame = 0;
      skip = 1;
    }
  }

  std::string result = tokensToText(decodedTokens, vocab_);
  return result.empty() ? "[No speech detected]" : result;
}

std::pair<std::vector<float>, int64_t>
ParakeetModel::runPreprocessor(const Input &audio) {
  if (!preprocessor_session_ || audio.empty())
    return {{}, 0};
  std::vector<int64_t> waveformShape = {1, static_cast<int64_t>(audio.size())};
  std::vector<float> audioData(audio.begin(), audio.end());
  Ort::Value waveformTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, audioData.data(), audioData.size(), waveformShape.data(),
      waveformShape.size());
  std::vector<int64_t> waveformLens = {static_cast<int64_t>(audio.size())};
  std::vector<int64_t> lensShape = {1};
  Ort::Value lensTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, waveformLens.data(), waveformLens.size(), lensShape.data(),
      lensShape.size());
  const char *inputNames[] = {"waveforms", "waveforms_lens"};
  const char *outputNames[] = {"features", "features_lens"};
  std::vector<Ort::Value> inputs;
  inputs.push_back(std::move(waveformTensor));
  inputs.push_back(std::move(lensTensor));
  auto outputs =
      preprocessor_session_->Run(Ort::RunOptions{nullptr}, inputNames,
                                 inputs.data(), inputs.size(), outputNames, 2);
  auto &featuresTensor = outputs[0];
  auto featuresInfo = featuresTensor.GetTensorTypeAndShapeInfo();
  auto featuresShape = featuresInfo.GetShape();
  const float *featuresData = featuresTensor.GetTensorData<float>();
  size_t featuresSize = featuresInfo.GetElementCount();
  constexpr size_t FEATURES_TIME_DIM = 2;
  int64_t numFrames = featuresShape[FEATURES_TIME_DIM];
  return {std::vector<float>(featuresData, featuresData + featuresSize),
          numFrames};
}

std::string ParakeetModel::runInferenceAndGetText(const Input &input) {
  if (!is_loaded_ || !encoder_session_ || !decoder_session_) {
    return "[Model not loaded]";
  }
  try {
    std::vector<float> melFeatures;
    int64_t numFrames = 0;
    bool alreadyTransposed = false;
    int64_t encodedLength = 0;
    measureTime(melSpecMs_, [&]() {
      if (preprocessor_session_) {
        auto [features, frames] = runPreprocessor(input);
        melFeatures = std::move(features);
        numFrames = frames;
        alreadyTransposed = true;
      } else {
        melFeatures = computeMelSpectrogram(input);
        numFrames = static_cast<int64_t>(melFeatures.size() / MEL_BINS);
        alreadyTransposed = false;
      }
      totalMelFrames_ += numFrames;
    });
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Mel-spectrogram: " + std::to_string(numFrames) + " frames");
    if (melFeatures.empty() || numFrames <= 0) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
           "Audio too short for processing");
      return "[Audio too short]";
    }
    std::vector<float> encoderOutput;
    measureTime(encoderMs_, [&]() {
      encoderOutput =
          runEncoder(melFeatures, numFrames, encodedLength, alreadyTransposed);
      totalEncodedFrames_ += encodedLength;
    });
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Encoder output: " + std::to_string(encodedLength) +
             " encoded frames");
    std::string text;
    measureTime(decoderMs_,
                [&]() { text = greedyDecode(encoderOutput, encodedLength); });
    size_t wordCount =
        std::count(text.begin(), text.end(), ' ') + (text.empty() ? 0 : 1);
    totalTokens_ += static_cast<int64_t>(wordCount);
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Decoded: " + std::to_string(wordCount) + " tokens, text: " + text);
    return text;
  } catch (const std::exception &e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("Inference error: ") + e.what());
    return "[Inference error]";
  }
}

void ParakeetModel::process(const Input &input) {
  if (input.empty()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Empty audio input received");
    return;
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Processing audio: " + std::to_string(input.size()) + " samples");
  auto processStart = std::chrono::high_resolution_clock::now();
  processCalls_++;
  totalSamples_ += input.size();
  float startTime = processed_time_;
  float duration = static_cast<float>(input.size()) / SAMPLE_RATE;
  std::string text = runInferenceAndGetText(input);
  auto processEnd = std::chrono::high_resolution_clock::now();
  totalWallMs_ += std::chrono::duration_cast<std::chrono::milliseconds>(
                      processEnd - processStart)
                      .count();
  Transcript transcript;
  transcript.text = text;
  transcript.start = startTime;
  transcript.end = startTime + duration;
  transcript.toAppend = true;
  output_.push_back(transcript);
  processed_time_ += duration;
  totalTranscriptions_++;
  if (on_segment_)
    on_segment_(transcript);
}

ParakeetModel::Output
ParakeetModel::process(const Input &input,
                       std::function<void(const Output &)> callback) {
  process(input);
  Output result = std::move(output_);
  output_.clear();

  if (callback) {
    callback(result);
  }

  return result;
}

std::vector<float>
ParakeetModel::preprocessAudioData(const std::vector<uint8_t> &audioData,
                                   const std::string &audioFormat) {
  std::vector<float> result;
  if (audioFormat == "s16le") {
    decodeS16LeToFloat(audioData, result);
  } else if (audioFormat == "f32le") {
    constexpr size_t BYTES_PER_FLOAT = 4;
    result.reserve(audioData.size() / BYTES_PER_FLOAT);
    const float *floatData = reinterpret_cast<const float *>(audioData.data());
    result.assign(floatData, floatData + (audioData.size() / BYTES_PER_FLOAT));
  }
  return result;
}

qvac_lib_inference_addon_cpp::RuntimeStats ParakeetModel::runtimeStats() {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  const double audioDurationSec =
      totalSamples_ > 0 ? (double)totalSamples_ / SAMPLE_RATE : 0.0;
  const int64_t audioDurationMs =
      static_cast<int64_t>(audioDurationSec * 1000.0);
  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double rtf =
      audioDurationSec > 0.0 ? (totalTimeSec / audioDurationSec) : 0.0;
  const double tps =
      totalTimeSec > 0.0 ? ((double)totalTokens_ / totalTimeSec) : 0.0;
  const double msPerToken =
      totalTokens_ > 0 ? ((double)totalWallMs_ / totalTokens_) : 0.0;

  stats.emplace_back("totalTime", totalTimeSec);
  stats.emplace_back("realTimeFactor", rtf);
  stats.emplace_back("tokensPerSecond", tps);
  stats.emplace_back("msPerToken", msPerToken);
  stats.emplace_back("audioDurationMs", audioDurationMs);
  stats.emplace_back("totalSamples", totalSamples_);

  stats.emplace_back("totalTokens", totalTokens_);
  stats.emplace_back("totalTranscriptions", totalTranscriptions_);
  stats.emplace_back("processCalls", processCalls_);

  stats.emplace_back("modelLoadMs", modelLoadMs_);
  stats.emplace_back("melSpecMs", melSpecMs_);
  stats.emplace_back("encoderMs", encoderMs_);
  stats.emplace_back("decoderMs", decoderMs_);
  stats.emplace_back("totalWallMs", totalWallMs_);

  stats.emplace_back("totalMelFrames", totalMelFrames_);
  stats.emplace_back("totalEncodedFrames", totalEncodedFrames_);

  return stats;
}

} // namespace qvac_lib_infer_parakeet
