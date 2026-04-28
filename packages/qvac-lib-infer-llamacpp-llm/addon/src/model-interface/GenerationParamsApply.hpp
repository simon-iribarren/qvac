#pragma once

#include "LlmContext.hpp"
#include "common/common.h"

// Apply per-request `generationParams` overrides onto a `common_params`
// sampling block in place. Mutates `params.sampling` and `params.n_predict`
// for fields that are set on `overrides`; leaves the rest untouched.
//
// If `overrides.json_schema` is set, parses the JSON Schema and converts
// it to GBNF via llama.cpp's `json_schema_to_grammar()`, mirroring what
// the `--json-schema` load-time flag does. If `overrides.grammar` is set,
// the GBNF is used verbatim. The two are mutually exclusive (validated at
// the JS boundary and again in `AddonJs::runJob::parseText`); if both are
// present here only `json_schema` is honoured.
//
// Throws `qvac_errors::StatusError(InvalidArgument)` when `json_schema`
// fails to parse or convert. Caller is responsible for re-initialising
// the sampler after this call so the new sampling block takes effect.
void applyGenerationOverridesToSampling(
    common_params& params, const GenerationParams& overrides);
