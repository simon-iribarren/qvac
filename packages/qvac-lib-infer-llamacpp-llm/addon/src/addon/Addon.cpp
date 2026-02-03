#include "Addon.hpp"

#include <atomic>
#include <chrono>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <utility>

#include <qvac-lib-inference-addon-cpp/FinetuningParameters.hpp>

#include "FinetuneParamStore.hpp"
#include "model-interface/LlamaModel.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "utils/LoggingMacros.hpp"

extern "C" void qvac_lib_inference_addon_llama_put_finetune_params(
    void* key,
    const qvac_lib_inference_addon_cpp::FinetuningParameters& params) {
  qvac_lib_inference_addon_llama_detail::put(key, params);
}

namespace qvac_lib_inference_addon_cpp {
template <>
bool Addon<LlamaModel>::supportsFinetuning() {
  return true;
}

// Static atomic variable to track if we should resume from pause
// This is set when activate() is called from PAUSED state
// Using atomic to ensure thread-safe access across the process loop and
// activate() calls
namespace {
std::atomic<bool> shouldResumeFromPause{false};
// Thread-local variable to pass the resume flag from process loop to
// doFinetuning() This ensures the flag value is preserved even if
// doFinetuning() is called multiple times
thread_local bool currentResumeFlag = false;
} // namespace

template <>
void Addon<LlamaModel>::doFinetuning();

template <>
template <>
Addon<LlamaModel>::Addon(
    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<const std::string> projectionPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb)
    : env_{env}, transitionCb_{transitionCb},
      model_{modelPath, projectionPath, configFilemap} {
  QLOG_IF(
      logger::Priority::INFO,
      "Initializing LlamaModel addon with model path: " +
          std::string(modelPath.get()));
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
  QLOG_IF(logger::Priority::INFO, "LlamaModel addon initialized successfully");
}

template <>
template <>
Addon<LlamaModel>::Addon(

    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb)
    : env_{env}, transitionCb_{transitionCb},
      model_{modelPath, "", configFilemap} {
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

template <>
template <>
Addon<LlamaModel>::Addon(

    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    std::reference_wrapper<const qvac_lib_inference_addon_cpp::FinetuningParameters>
      finetuningArgs,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb)
    : env_{env}, transitionCb_{transitionCb},
      model_{modelPath, "", configFilemap} {
  this->finetuningParameters_ = finetuningArgs.get();
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

template <>
LlamaModel::Input qvac_lib_inference_addon_llama::Addon::getNextPiece(
    LlamaModel::Input& input, size_t /*lastPieceEnd*/) {
  return input;
}

template <>
uint32_t qvac_lib_inference_addon_llama::Addon::append(
    int priority, LlamaModel::Input input) {
  uint32_t jobId = 0;
  constexpr int K_DEFAULT_PRIORITY = 50;
  {
    std::scoped_lock lock{ mtx_ };
    if (lastAppendedJob_ != nullptr) {
      jobId = lastAppendedJob_->id;
      // derive priority_queue so we can add a method to update the priority
    } else {
      auto newJob = std::make_unique<Job<LlamaModel::Input>>(++jobIds_);
      lastAppendedJob_ = newJob.get();
      jobId = lastAppendedJob_->id;
      try {
        jobQueue_.emplace(
            priority == -1 ? K_DEFAULT_PRIORITY : priority, std::move(newJob));
      } catch (...) {
        lastAppendedJob_ = nullptr;
        throw;
      }
    }
    auto &chunks = lastAppendedJob_->chunks;
    if (!chunks.empty() && chunks.back().index() == input.index()) {
      std::visit(
          [&](auto& dst, auto&& src) {
            using D = std::decay_t<decltype(dst)>;
            using S = std::decay_t<decltype(src)>;
            if constexpr (
                std::is_same_v<D, std::string> &&
                std::is_same_v<S, std::string>) {
              dst.append(src);
            } else if constexpr (
                std::is_same_v<D, std::vector<uint8_t>> &&
                std::is_same_v<S, std::vector<uint8_t>>) {
              chunks.emplace_back(std::forward<decltype(src)>(src));
            }
          },
          chunks.back(),
          std::move(input));
    } else {
      chunks.emplace_back(std::move(input));
    }
  }
  processCv_.notify_one();
  return jobId;
}

  // This is a template specialization of the process() function specifically for LlamaModel
  // Unlike other models, LlamaModel streams its output through callbacks rather than returning
  // complete responses. This specialization handles the streaming nature of LLaMA's output
  // by processing input in pieces and handling the incremental token generation.
template <>
void Addon<LlamaModel>::process() {

  std::unique_ptr<Job<LlamaModel::Input>> currentJob;
  auto cleanupLastAppended = utils::onError([&currentJob, this]() {
    auto scopedLock = std::scoped_lock{mtx_};
    if (currentJob.get() == lastAppendedJob_) {
      lastAppendedJob_ = nullptr;
    }
  });
  LlamaModel::Input input;
  size_t lastPieceEnd = 0;

  // Helper lambda to check if variant input is empty
  auto isInputEmpty = [](const LlamaModel::Input& inp) {
    return std::visit([](const auto& val) { return val.empty(); }, inp);
  };

  // Helper lambda to clear variant input
  auto clearInput = [](LlamaModel::Input& inp) {
    std::visit([](auto& val) { val.clear(); }, inp);
  };

  // Helper lambda to get size of variant input
  auto getInputSize = [](const LlamaModel::Input& inp) {
    return std::visit([](const auto& val) { return val.size(); }, inp);
  };

  while (running_) {
    std::unique_lock uniqueLock(mtx_);
    constexpr int K_PROCESS_WAIT_MS = 100;

    processCv_.wait_for(
        uniqueLock, std::chrono::milliseconds{K_PROCESS_WAIT_MS});

    // CRITICAL: Process signals FIRST, before checking status
    // This ensures that when activate() sets a signal from PAUSED state,
    // the signal is processed and status is updated before the status check
    if (signal_ != ProcessSignals::None) {
      switch (signal_) {
      case ProcessSignals::Activate:
        // Don't overwrite Finetuning status - if we're resuming, status is
        // already Finetuning
        if (status_ != AddonStatus::Finetuning) {
          status_ = AddonStatus::Processing;
        }
        break;
      case ProcessSignals::Finetune:
        // CRITICAL: Only ignore the signal if training completed AND we're not
        // resuming from pause If shouldResumeFromPause is true, we MUST process
        // the signal to resume training The flag is set by activate() when
        // resuming from PAUSED state
        if (this->finetuningFinished_ && !shouldResumeFromPause.load()) {
          // Training completed and we're not resuming - ignore the signal to
          // prevent restart
          break;
        }
        status_ = AddonStatus::Finetuning;
        // Reset finetuningFinished_ flag when starting new training session
        this->finetuningFinished_ = false;
        // Force the loop to process finetuning even if it was in Loading state
        break;
      case ProcessSignals::Stop:
        status_ = AddonStatus::Stopped;
        model_.reset();
        if (currentJob && currentJob.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob.reset();
        clearInput(input);
        break;
      case ProcessSignals::Pause:
        status_ = AddonStatus::Paused;
        break;
      case ProcessSignals::Cancel:
        if (currentJob &&
            (cancelJobId_ == 0 || currentJob->id == cancelJobId_)) {
          queueOutput(
              ModelOutput{
                  OutputEvent::JobEnded,
                  currentJob->id,
                  model_.runtimeStats()});
          model_.reset();
          if (currentJob.get() == lastAppendedJob_) {
            lastAppendedJob_ = nullptr;
          }
          currentJob.reset();
          cancelJobId_ = 0;
          clearInput(input);
        }
        break;
      default:
        std::cout << '\n';
        break;
      }
      signal_ = ProcessSignals::None;
    }

    if (status_ == AddonStatus::Stopped || status_ == AddonStatus::Paused ||
        status_ == AddonStatus::Loading) {
      continue;
    }

    if (status_ == AddonStatus::Finetuning) {
      // CRITICAL: Only call doFinetuning() if finetuningFinished_ is false OR
      // we're resuming from pause
      if (this->finetuningFinished_ && !shouldResumeFromPause.load()) {
        continue;
      }

      // Read and reset the flag atomically while holding the lock
      bool resumeFlag = shouldResumeFromPause.exchange(false);
      bool wasResuming =
          resumeFlag; // Save for use after doFinetuning() returns

      uniqueLock.unlock();
      try {
        currentResumeFlag = resumeFlag;
        doFinetuning();
      } catch (const std::exception& e) {
        std::scoped_lock logLock{this->mtx_};
        this->queueOutput(ModelOutput{
            OutputEvent::LogMsg,
            0,
            typename ModelOutput::LogMsg{
                std::string{"Finetuning error: "} + e.what()}});
      }

      auto logMsg = this->getLogMessage();
      if (!logMsg.empty()) {
        std::scoped_lock logLock{this->mtx_};
        this->queueOutput(
            ModelOutput{
                OutputEvent::LogMsg,
                0,
                typename ModelOutput::LogMsg{std::move(logMsg)}});
      }
      uniqueLock.lock();
      // doFinetuning() sets finetuningFinished_ = true when it completes
      // We don't need to set it again here - it's already set

      // CRITICAL: Use the saved resume flag value, not the atomic flag
      // The atomic flag was consumed by exchange(false) above, so reading it
      // now would always be false We saved wasResuming before calling
      // doFinetuning() to know if we were resuming
      bool isResuming = wasResuming;

      // CRITICAL: After doFinetuning() completes, training is done (either
      // normally or after resume) We should ALWAYS transition to Idle (unless
      // paused), regardless of whether we were resuming The "resume" flag only
      // matters for determining if we should load a checkpoint, not for
      // completion handling

      // If we're resuming, clear the signal to prevent duplicate processing
      if (isResuming) {
        if (signal_ == ProcessSignals::Finetune) {
          signal_ = ProcessSignals::None;
        }
      }

      // CRITICAL: Always transition from Finetuning to Idle after completion
      // (whether resuming or not) This prevents the loop from re-entering the
      // Finetuning block on the next iteration Note: If paused, status would
      // have been changed to Paused by pause() during doFinetuning(), in which
      // case we keep it as Paused (handled by the finetuningFinished_ block
      // below)
      if (status_ == AddonStatus::Finetuning) {
        // Training completed - set status to Idle (regardless of whether we
        // were resuming)
        status_ = AddonStatus::Idle;
        this->finetuningFinished_ =
            false; // Reset flag now that we've handled completion
        // Clear Finetune signal if present
        if (signal_ == ProcessSignals::Finetune) {
          signal_ = ProcessSignals::None;
        }
        // Notify waiting threads (e.g., JavaScript status() calls) that status
        // has changed
        uniqueLock.unlock();
        processCv_.notify_all();
        uniqueLock.lock();
      }
      // If status is not Finetuning (e.g., it was changed to Paused during
      // doFinetuning()), the finetuningFinished_ block below will handle it
      continue;
    }
    if (this->finetuningFinished_) {
      // This block handles completion from previous iterations
      // Only mark as complete if not paused (pause is temporary, training can
      // resume)
      if (status_ != AddonStatus::Paused) {
        this->finetuningFinished_ = false;
        status_ = AddonStatus::Idle;
        // Clear any pending Finetune signal to prevent restarting training
        if (signal_ == ProcessSignals::Finetune) {
          signal_ = ProcessSignals::None;
        }
        // Note: LoRA adapter is already saved in LlamaModel::finetune()
        // No need to call saveWeights() here
      } else {
        // If paused, keep status as PAUSED and don't save weights yet
        // Training can resume, so don't treat this as completion
        this->finetuningFinished_ = false; // Reset flag for potential resume
      }
      continue;
    }
    if (currentJob == nullptr) {
      // get next job
      if (jobQueue_.empty()) {
        status_ = AddonStatus::Idle;
        continue;
      }
      currentJob = std::move(jobQueue_.top().job);
      jobQueue_.pop();
      status_ = AddonStatus::Processing;
      queueOutput(ModelOutput{OutputEvent::JobStarted, currentJob->id});
    }
    if (isInputEmpty(input)) {
      // grab next chunk of input
      if (currentJob->chunks.empty()) {
        // no more input, check if end of job
        if (currentJob.get() != lastAppendedJob_) {
          // job ended
          queueOutput(
              ModelOutput{
                  OutputEvent::JobEnded,
                  currentJob->id,
                  model_.runtimeStats()});
          model_.reset();
          currentJob.reset();
          continue;
        }
        // wait for more input
        status_ = AddonStatus::Listening;
        continue;
      }
      input = std::move(currentJob->chunks.front());
      currentJob->chunks.pop_front();
      lastPieceEnd = 0;
      status_ = AddonStatus::Processing;
    }
    uniqueLock.unlock();
    // process input in small pieces
    auto piece = getNextPiece(input, lastPieceEnd);
    lastPieceEnd += getInputSize(piece);
    if (lastPieceEnd == getInputSize(input)) {
      clearInput(input);
    }
    try {
      auto queueOutputCb = [&](const std::string& tokenOut) {
        std::scoped_lock slk{mtx_};
        queueOutput(ModelOutput{OutputEvent::Output, currentJob->id, tokenOut});
      };
      model_.process(piece, queueOutputCb);
    } catch (const std::exception& e) {
      // Error, cancel current job
      auto jobId = currentJob->id;
      uniqueLock.lock();
      queueOutput(
          ModelOutput{
              OutputEvent::Error,
              jobId,
              typename ModelOutput::Error{e.what()}});
      queueOutput(
          ModelOutput{OutputEvent::JobEnded, jobId, model_.runtimeStats()});
      model_.reset();
      if (currentJob.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob.reset();
      clearInput(input);
    }
  }
}

template <>
void Addon<LlamaModel>::doFinetuning() {
  this->finetuningFinished_ = false;
  qvac_lib_inference_addon_cpp::FinetuningParameters tmp;
  if (qvac_lib_inference_addon_llama_detail::take(this, tmp)) {
    this->finetuningParameters_ = tmp;
  }

  if (!this->finetuningParameters_.has_value()) {
    this->finetuningFinished_ = true;
    return;
  }

  const auto& params = this->finetuningParameters_.value();

  std::ostringstream paramsLog;
  paramsLog << "Finetuning parameters: {"
            << "outputParametersDir=\"" << params.outputParametersDir << "\", "
            << "trainDatasetDir=\"" << params.trainDatasetDir << "\", "
            << "evalDatasetDir=\"" << params.evalDatasetDir << "\", "
            << "numberOfEpochs=" << params.numberOfEpochs << ", "
            << "learningRate=" << params.learningRate << "}";
  const auto formattedParams = paramsLog.str();
  QLOG_IF(logger::Priority::INFO, formattedParams);
  {
    std::scoped_lock logLock{this->mtx_};
    this->queueOutput(
        ModelOutput{
            OutputEvent::LogMsg,
            0,
            typename ModelOutput::LogMsg{formattedParams}});
  }

  auto enqueueLog = [this](std::string message) {
    std::scoped_lock logLock{this->mtx_};
    this->queueOutput(
        ModelOutput{
            OutputEvent::LogMsg,
            0,
            typename ModelOutput::LogMsg{std::move(message)}});
  };

  try {
    // Check if we should resume from pause checkpoint
    // Use thread-local variable set by the process loop to preserve the flag
    // value
    bool allowResume = currentResumeFlag;
    currentResumeFlag = false; // Reset after use

    this->model_.finetune(params, enqueueLog, allowResume);
  } catch (const std::exception& e) {
    enqueueLog(std::string{"Finetune error: "} + e.what());
  }

  this->finetuningFinished_ = true;
}

// Override cancel methods to immediately stop model processing
template <> void Addon<LlamaModel>::cancel(uint32_t jobId) {
  {
    std::scoped_lock lock{mtx_};
    cancelJobId_ = jobId;
    signal_ = ProcessSignals::Cancel;
    model_.stop();
  }
  processCv_.notify_one();
}

template <> void Addon<LlamaModel>::cancelAll() {
  {
    std::scoped_lock lock{mtx_};
    if (lastAppendedJob_ != nullptr) {
      lastAppendedJob_ = nullptr;
    }
    jobQueue_.clear();
    cancelJobId_ = 0;
    signal_ = ProcessSignals::Cancel;
    // Immediately stop any ongoing model processing
    model_.stop();
  }
  processCv_.notify_one();
}

template <> void Addon<LlamaModel>::pause() {
  {
    std::scoped_lock lock{mtx_};
    // If finetuning, request pause via model and set status immediately
    if (status_ == AddonStatus::Finetuning) {
      model_.requestPause();
      // Set status to PAUSED immediately so it's preserved when doFinetuning()
      // returns
      status_ = AddonStatus::Paused;

      // CRITICAL: Reset the resume flag when pausing
      // This ensures clean state - when we pause, we're not resuming
      // The flag will be set to true by activate() when resuming
      shouldResumeFromPause.store(false);
    }
    signal_ = ProcessSignals::Pause;
  }
  processCv_.notify_one();
}

template <> void Addon<LlamaModel>::activate() {
  // Wait for model initialization to complete (if supported)
  if constexpr (requires { model_.waitForLoadInitialization(); }) {
    model_.waitForLoadInitialization();
  }

  {
    std::scoped_lock lock{mtx_};
    if (status_ == AddonStatus::Paused) {
      model_.clearPauseRequest();
      // If we were finetuning, restart it and set status immediately
      if (this->finetuningParameters_.has_value()) {
        shouldResumeFromPause.store(
            true); // Mark that we should resume from pause checkpoint
        this->finetuningFinished_ =
            false; // Reset so doFinetuning() can be called again
        status_ =
            AddonStatus::Finetuning; // Set status immediately like pause does
        signal_ = ProcessSignals::Finetune;
      } else {
        signal_ = ProcessSignals::Activate;
      }
    } else {
      signal_ = ProcessSignals::Activate;
    }
  }

  processCv_.notify_one();
}

template <> void Addon<LlamaModel>::finetune() {
  // Follow the same pattern as pause() and activate() - simple scoped_lock
  // The process loop releases the lock during wait_for(), so we can acquire it
  {
    std::scoped_lock lock{mtx_};
    signal_ = ProcessSignals::Finetune;
  }
  processCv_.notify_one();
}
}
