#include "GenerationParamsApply.hpp"

#include <exception>
#include <string>

#include <nlohmann/json.hpp>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"
#include "common/json-schema-to-grammar.h"

void applyGenerationOverridesToSampling(
    common_params& params, const GenerationParams& overrides) {
  auto setIf = [](const auto& src, auto& dst) {
    if (src) {
      dst = *src;
    }
  };

  setIf(overrides.temp, params.sampling.temp);
  setIf(overrides.top_p, params.sampling.top_p);
  setIf(overrides.top_k, params.sampling.top_k);
  setIf(overrides.n_predict, params.n_predict);
  setIf(overrides.seed, params.sampling.seed);
  setIf(overrides.frequency_penalty, params.sampling.penalty_freq);
  setIf(overrides.presence_penalty, params.sampling.penalty_present);
  setIf(overrides.repeat_penalty, params.sampling.penalty_repeat);

  // `json_schema` and `grammar` are mutually exclusive at the JS boundary
  // and in `AddonJs::runJob::parseText`. Defensive precedence here just in
  // case a future caller bypasses both checks: schema wins, since it is
  // the higher-level surface.
  if (overrides.json_schema) {
    try {
      auto parsed = nlohmann::ordered_json::parse(*overrides.json_schema);
      params.sampling.grammar = json_schema_to_grammar(parsed);
    } catch (const std::exception& ex) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          std::string("invalid generationParams.json_schema: ") + ex.what());
    }
  } else if (overrides.grammar) {
    params.sampling.grammar = *overrides.grammar;
  }
}
