#pragma once

#include "qvac-lib-inference-addon-cpp/Addon.hpp"
#include "model-interface/LlamaModel.hpp"
#include <qvac-lib-inference-addon-cpp/FinetuningParameters.hpp>
#include <deque>

namespace qvac_lib_inference_addon_cpp {

template<>
struct Job<LlamaModel::Input> {
  explicit Job(uint32_t jobId) : id{jobId} {}

  uint32_t id;
  std::deque<LlamaModel::Input> chunks;
};

template<>
void Addon<LlamaModel>::process();
template <>
void Addon<LlamaModel>::doFinetuning();

template <>
uint32_t
Addon<LlamaModel>::append(int priority, LlamaModel::InputView inputView);

template <> void Addon<LlamaModel>::cancel(uint32_t jobId);

template <> void Addon<LlamaModel>::cancelAll();

template <> bool Addon<LlamaModel>::supportsFinetuning();

template <> void Addon<LlamaModel>::pause();

template <> void Addon<LlamaModel>::activate();

template <> void Addon<LlamaModel>::finetune();

template <>
template <>
Addon<LlamaModel>::Addon(
    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<const std::string> projectionPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
        configFilemap,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb);

template <>
template <>
Addon<LlamaModel>::Addon(
    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    std::reference_wrapper<const qvac_lib_inference_addon_cpp::FinetuningParameters>
      finetuningArgs,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb);

template <>
template <>
Addon<LlamaModel>::Addon(
    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb);

}

namespace qvac_lib_inference_addon_llama {

using Addon = qvac_lib_inference_addon_cpp::Addon<LlamaModel>;

}
