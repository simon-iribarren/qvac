#include <any>
#include <filesystem>
#include <iostream>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <variant>

#include <gtest/gtest.h>
#include <picojson/picojson.h>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>
#include <llama.h>
#include "utils/Qwen3ToolsDynamicTemplate.hpp"
#include "utils/ChatTemplateUtils.hpp"

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

namespace {
double getStatValue(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& stat : stats) {
    if (stat.first == key) {
      return std::visit(
          [](const auto& value) -> double {
            if constexpr (std::is_same_v<
                              std::decay_t<decltype(value)>,
                              double>) {
              return value;
            } else {
              return static_cast<double>(value);
            }
          },
          stat.second);
    }
  }
  return 0.0;
}

std::string processPromptString(
    const std::unique_ptr<LlamaModel>& model, const std::string& input) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  return model->processPrompt(prompt);
}

bool isQwen3ModelPath(const std::string& path) {
  std::string lowerPath = path;
  std::transform(
      lowerPath.begin(), lowerPath.end(), lowerPath.begin(),
      [](unsigned char c) { return std::tolower(c); });
  return lowerPath.find("qwen3") != std::string::npos;
}

std::vector<common_chat_msg> parseChatMessages(const std::string& input) {
  picojson::value chatJson;
  std::string err = picojson::parse(chatJson, input);
  if (!err.empty()) {
    throw std::runtime_error("Failed to parse JSON: " + err);
  }
  if (!chatJson.is<picojson::array>()) {
    throw std::runtime_error("Expected JSON array");
  }
  std::vector<common_chat_msg> messages;
  auto& obj = chatJson.get<picojson::array>();
  for (const auto& subObj : obj) {
    if (subObj.is<picojson::object>()) {
      picojson::object jsonObj = subObj.get<picojson::object>();
      // Skip function type (tools)
      auto it = jsonObj.find("type");
      if (it != jsonObj.end() && it->second.get<std::string>() == "function") {
        continue;
      }
      common_chat_msg msg;
      msg.role = jsonObj["role"].get<std::string>();
      msg.content = jsonObj["content"].get<std::string>();
      messages.push_back(msg);
    }
  }
  return messages;
}
} // namespace

class CacheManagementQwen3Test : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";
    config_files["tools"] = "true";

    test_model_path = test_common::BaseTestModelPath::get("Qwen3-1.7B-Q4_0.gguf", "Llama-3.2-1B-Instruct-Q4_0.gguf");
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();

    session1_path = "test_session1_qwen3.bin";
    session2_path = "test_session2_qwen3.bin";
    temp_session_path = "temp_session_qwen3.bin";
  }

  void TearDown() override {
    for (const auto& session_file :
         {session1_path,
          session2_path,
          temp_session_path,
          std::string("test_large_cache_qwen3.bin")}) {
      if (fs::exists(session_file)) {
        fs::remove(session_file);
      }
    }
  }

  bool hasValidModel() { return fs::exists(test_model_path); }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;
  std::string session1_path;
  std::string session2_path;
  std::string temp_session_path;
};

TEST_F(CacheManagementQwen3Test, CacheWithToolsAtEndTrueTrimsToolTokens) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string inputWithTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, inputWithTools);
    EXPECT_GE(output.length(), 0);
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementQwen3Test, CacheReloadWithToolsAtEndTrue) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model1 = createModel();
  if (!model1) {
    FAIL() << "Model failed to load";
  }

  std::string inputWithTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model1, inputWithTools);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools1 = model1->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools1, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model1, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  model1.reset();

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptString(
        model2,
        R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is the weather in London?"}])");
    EXPECT_GE(output.length(), 0);
  });

  auto statsAfterReload = model2->runtimeStats();
  double cacheTokensAfterReload = getStatValue(statsAfterReload, "CacheTokens");
  EXPECT_GT(cacheTokensAfterReload, 0.0);

  llama_pos nPastBeforeTools2 = model2->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools2, -1);
}

TEST_F(CacheManagementQwen3Test, CacheWithoutToolsWithToolsAtEndTrue) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string inputNoTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What is bitcoin? Answer shortly."}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, inputNoTools);
    EXPECT_GE(output.length(), 0);
  });

  // Compute expected token count for the no-tools prompt
  std::string chatTemplate = qvac_lib_inference_addon_llama::utils::getToolsDynamicQwen3Template();
  common_chat_templates_ptr tmpls_ = common_chat_templates_init(model->getModel(), chatTemplate);

  // Parse input into chat messages
  auto messages = parseChatMessages(inputNoTools);
  std::cout << "\n=== DEBUG: Parsed messages (before session removal) ===" << std::endl;
  std::cout << "Number of messages: " << messages.size() << std::endl;
  for (size_t i = 0; i < messages.size(); i++) {
    std::cout << "  [" << i << "] role='" << messages[i].role << "' content='" << messages[i].content << "'" << std::endl;
  }
  std::cout << "=== END DEBUG ===\n" << std::endl;

  // Build inputs for template
  common_chat_templates_inputs inputs;
  inputs.use_jinja = true;  // tools=true sets use_jinja=true in commonParamsParse
  inputs.add_generation_prompt = true; // first message, nPast==0 => add generation prompt
  inputs.messages = messages;

  auto promptNoTools = qvac_lib_inference_addon_llama::utils::getPrompt(tmpls_.get(), inputs);

  std::cout << "\n=== DEBUG: Test expected prompt ===" << std::endl;
  std::cout << promptNoTools << std::endl;
  std::cout << "=== END DEBUG ===\n" << std::endl;

  // For first prefill, addSpecial = true
  auto tokensNoTools = common_tokenize(llama_model_get_vocab(model->getModel()), promptNoTools, true, true);

  std::cout << "=== DEBUG: tokensNoTools.size() = " << tokensNoTools.size() << " ===" << std::endl;

  // Also get the actual prompt from the model by parsing messages like the model does
  auto modelMessages = parseChatMessages(inputNoTools);
  // Simulate what CacheManager does: remove session messages
  auto it = modelMessages.begin();
  while (it != modelMessages.end()) {
    if (it->role == "session") {
      it = modelMessages.erase(it);
    } else {
      ++it;
    }
  }

  common_chat_templates_inputs modelInputs;
  modelInputs.use_jinja = true;
  modelInputs.add_generation_prompt = true;
  modelInputs.messages = modelMessages;

  auto actualPrompt = qvac_lib_inference_addon_llama::utils::getPrompt(tmpls_.get(), modelInputs);
  std::cout << "=== DEBUG: Actual model prompt (after session removal) ===" << std::endl;
  std::cout << actualPrompt << std::endl;
  std::cout << "=== END DEBUG ===\n" << std::endl;

  auto actualTokens = common_tokenize(llama_model_get_vocab(model->getModel()), actualPrompt, true, true);
  std::cout << "=== DEBUG: actualTokens.size() = " << actualTokens.size() << " ===" << std::endl;

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  std::cout << "=== DEBUG: cacheTokensBeforeSave = " << cacheTokensBeforeSave << " ===" << std::endl;

  // The test should compare with the model's actual behavior (after session removal)
  EXPECT_EQ(cacheTokensBeforeSave, static_cast<double>(actualTokens.size()));

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementQwen3Test, CacheToolsAtEndModeWithMultiplePrompts) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string input1 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hi"}, {"type": "function", "name": "get_weather", "description": "Get detailed weather forecast data with temperature humidity wind speed precipitation UV visibility pressure sunrise sunset alerts", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "The name of the city to get weather for"}, "country": {"type": "string", "description": "Country code or name"}, "lat": {"type": "number", "description": "Latitude coordinate"}, "lon": {"type": "number", "description": "Longitude coordinate"}, "zip": {"type": "string", "description": "ZIP postal code"}, "units": {"type": "string", "description": "Temperature units metric imperial or kelvin"}, "lang": {"type": "string", "description": "Language code for localized descriptions"}, "forecast_days": {"type": "integer", "description": "Number of days to forecast from 1 to 7"}, "hourly": {"type": "boolean", "description": "Include hourly forecast data"}, "alerts": {"type": "boolean", "description": "Include weather alerts and warnings"}, "aqi": {"type": "boolean", "description": "Include air quality index data"}, "tides": {"type": "boolean", "description": "Include tide information"}, "solar": {"type": "boolean", "description": "Include solar data like sunrise sunset"}, "tz": {"type": "string", "description": "Timezone identifier"}, "start_dt": {"type": "string", "description": "Start datetime for historical data"}, "end_dt": {"type": "string", "description": "End datetime for historical data"}, "cnt": {"type": "integer", "description": "Number of data points to return"}, "mode": {"type": "string", "description": "Response mode json xml or html"}, "appid": {"type": "string", "description": "API key for authentication"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, input1);
    EXPECT_GE(output.length(), 0);
  });

  // START

  // Compute expected token count for the no-tools prompt
  std::string chatTemplate = qvac_lib_inference_addon_llama::utils::getToolsDynamicQwen3Template();
  common_chat_templates_ptr tmpls_ = common_chat_templates_init(model->getModel(), chatTemplate);

  // Parse input into chat messages
  auto messages = parseChatMessages(input1);
  std::cout << "\n=== DEBUG: Parsed messages (before session removal) ===" << std::endl;
  std::cout << "Number of messages: " << messages.size() << std::endl;
  for (size_t i = 0; i < messages.size(); i++) {
    std::cout << "  [" << i << "] role='" << messages[i].role << "' content='" << messages[i].content << "'" << std::endl;
  }
  std::cout << "=== END DEBUG ===\n" << std::endl;

  // Build inputs for template
  common_chat_templates_inputs inputs;
  inputs.use_jinja = true;  // tools=true sets use_jinja=true in commonParamsParse
  inputs.add_generation_prompt = false; // first message, nPast==0 => add generation prompt
  inputs.messages = messages;

  auto promptWithTools = qvac_lib_inference_addon_llama::utils::getPrompt(tmpls_.get(), inputs);

  std::cout << "\n=== DEBUG: Test expected prompt ===" << std::endl;
  std::cout << promptWithTools << std::endl;
  std::cout << "=== END DEBUG ===\n" << std::endl;

  // For first prefill, addSpecial = true
  auto tokensNoTools = common_tokenize(llama_model_get_vocab(model->getModel()), promptWithTools, true, true);

  std::cout << "=== DEBUG: tokensNoTools.size() = " << tokensNoTools.size() << " ===" << std::endl;

  // Also get the actual prompt from the model by parsing messages like the model does
  auto modelMessages = parseChatMessages(input1);
  // Simulate what CacheManager does: remove session messages
  auto it = modelMessages.begin();
  while (it != modelMessages.end()) {
    if (it->role == "session") {
      it = modelMessages.erase(it);
    } else {
      ++it;
    }
  }

  common_chat_templates_inputs modelInputs;
  modelInputs.use_jinja = true;
  modelInputs.add_generation_prompt = false;
  modelInputs.messages = modelMessages;

  auto actualPrompt = qvac_lib_inference_addon_llama::utils::getPrompt(tmpls_.get(), modelInputs);
  std::cout << "=== DEBUG: Actual model prompt (after session removal) ===" << std::endl;
  std::cout << actualPrompt << std::endl;
  std::cout << "=== END DEBUG ===\n" << std::endl;

  auto actualTokens = common_tokenize(llama_model_get_vocab(model->getModel()), actualPrompt, true, true);
  std::cout << "=== DEBUG: actualTokens.size() = " << actualTokens.size() << " ===" << std::endl;

  auto stats1 = model->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");
  std::cout << "=== DEBUG: cacheTokens1 = " << cacheTokens1 << " ===" << std::endl;
  double promptTokens1 = getStatValue(stats1, "promptTokens");
  // The test should compare with the model's actual behavior (after session removal)
  EXPECT_EQ(cacheTokens1, static_cast<double>(tokensNoTools.size()));
  EXPECT_EQ(cacheTokens1, static_cast<double>(actualTokens.size()));
  // EXPECT_GT(cacheTokens1, 0.0);
  EXPECT_GT(promptTokens1, 500.0);

  const int maxExpectedCacheTokens = 50;
  EXPECT_GT(cacheTokens1, 0);
  EXPECT_LE(cacheTokens1, maxExpectedCacheTokens)
      << "Cache tokens (" << cacheTokens1 << ") should not exceed "
      << maxExpectedCacheTokens << " - function tokens should be trimmed";

  std::string input2 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What about London?"}])";

  // START
  std::string inputFull2 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hi"}, {"role": "user", "content": "What about London?"}])";
  // Parse input into chat messages
  auto messages2 = parseChatMessages(inputFull2);
  std::cout << "\n=== DEBUG: Parsed messages (before session removal) ===" << std::endl;
  std::cout << "Number of messages: " << messages2.size() << std::endl;
  for (size_t i = 0; i < messages2.size(); i++) {
    std::cout << "  [" << i << "] role='" << messages2[i].role << "' content='" << messages2[i].content << "'" << std::endl;
  }
  std::cout << "=== END DEBUG ===\n" << std::endl;

  // Build inputs for template
  common_chat_templates_inputs inputs2;
  inputs2.use_jinja = true;  // tools=true sets use_jinja=true in commonParamsParse
  inputs2.add_generation_prompt = true; // first message, nPast==0 => add generation prompt
  inputs2.messages = messages2;

  auto promptWithoutTools = qvac_lib_inference_addon_llama::utils::getPrompt(tmpls_.get(), inputs2);

  std::cout << "\n=== DEBUG: Test expected prompt ===" << std::endl;
  std::cout << promptWithoutTools << std::endl;
  std::cout << "=== END DEBUG ===\n" << std::endl;

  // For first prefill, addSpecial = true
  auto tokensFinal = common_tokenize(llama_model_get_vocab(model->getModel()), promptWithoutTools, false, true);
  // END

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, input2);
    EXPECT_GE(output.length(), 0);
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  double promptTokens2 = getStatValue(stats2, "promptTokens");
  EXPECT_EQ(cacheTokens2, static_cast<double>(tokensFinal.size()));
  EXPECT_GT(cacheTokens2, cacheTokens1);
  EXPECT_LT(promptTokens2, 500.0);
  EXPECT_LE(cacheTokens2, maxExpectedCacheTokens)
      << "Cache tokens (" << cacheTokens1 << ") should not exceed "
      << maxExpectedCacheTokens << " - function tokens should be trimmed";

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  model.reset();

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model2 failed to load";
  }

  std::string input3 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What about Paris?"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model2, input3);
    EXPECT_GE(output.length(), 0);
  });

  auto stats3 = model2->runtimeStats();
  double cacheTokens3 = getStatValue(stats3, "CacheTokens");
  double promptTokens3 = getStatValue(stats3, "promptTokens");

  EXPECT_GT(cacheTokens3, cacheTokens2);
  EXPECT_LT(promptTokens3, 100.0);

  auto model3 = createModel();
  if (!model3) {
    FAIL() << "Model3 failed to load";
  }

  std::string getTokensInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "getTokens"}])";
  EXPECT_NO_THROW({
    std::string output = processPromptString(model3, getTokensInput);
    EXPECT_EQ(output.length(), 0);
  });

  auto stats4 = model3->runtimeStats();
  double cacheTokens4 = getStatValue(stats4, "CacheTokens");
  EXPECT_EQ(cacheTokens4, cacheTokens2);
}

TEST_F(CacheManagementQwen3Test, CacheToolsAtEndModeTrimOnlyWhenNPastBeforeToolsPositive) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string inputNoTools =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hello"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, inputNoTools);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  auto statsAfterSave = model->runtimeStats();
  double cacheTokensAfterSave = getStatValue(statsAfterSave, "CacheTokens");
  EXPECT_EQ(cacheTokensAfterSave, cacheTokensBeforeSave);
}

TEST_F(CacheManagementQwen3Test, CacheToolsAtEndModeRestoresNPastBeforeTools) {
  if (!isQwen3ModelPath(test_model_path)) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string input1 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "Hi"}, {"type": "function", "name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model, input1);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools1 = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools1, -1);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = processPromptString(model, saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  auto model2 = createModel();
  if (!model2) {
    FAIL() << "Model2 failed to load";
  }

  std::string input2 =
      R"([{"role": "session", "content": "test_session1_qwen3.bin"}, {"role": "user", "content": "What about London?"}])";

  EXPECT_NO_THROW({
    std::string output = processPromptString(model2, input2);
    EXPECT_GE(output.length(), 0);
  });

  llama_pos nPastBeforeTools2 = model2->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools2, -1);
}
