import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_TOKENIZER_EN_CHATTERBOX,
  TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32,
  TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32,
  TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32,
  TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32,
} from "@qvac/sdk";
import {
  createWav,
  playAudio,
  int16ArrayToBuffer,
  createWavHeader,
} from "./utils";

// Chatterbox TTS with LavaSR neural speech enhancement.
// Produces 48kHz enhanced audio from Chatterbox's native 24kHz output.
// Usage: node chatterbox-enhanced.js <referenceAudioSrc> <enhancerBackbone> <enhancerSpecHead> [denoiserPath]
const [referenceAudioSrc, enhancerBackbonePath, enhancerSpecHeadPath, denoiserPath] =
  process.argv.slice(2);

if (!referenceAudioSrc || !enhancerBackbonePath || !enhancerSpecHeadPath) {
  console.error(
    "Usage: node chatterbox-enhanced.js <referenceAudioSrc> <enhancerBackbone> <enhancerSpecHead> [denoiserPath]",
  );
  process.exit(1);
}

const ENHANCED_SAMPLE_RATE = 48000;

try {
  const modelId = await loadModel({
    modelSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsTokenizerSrc: TTS_TOKENIZER_EN_CHATTERBOX.src,
      ttsSpeechEncoderSrc: TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32.src,
      ttsEmbedTokensSrc: TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32.src,
      ttsConditionalDecoderSrc: TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32.src,
      ttsLanguageModelSrc: TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32.src,
      referenceAudioSrc,
      enhance: true,
      ...(denoiserPath ? { denoise: true } : {}),
      ttsEnhancerBackboneSrc: enhancerBackbonePath,
      ttsEnhancerSpecHeadSrc: enhancerSpecHeadPath,
      ...(denoiserPath ? { ttsDenoiserSrc: denoiserPath } : {}),
    },
    onProgress: (progress: ModelProgressUpdate) => {
      console.log(progress);
    },
  });

  console.log(`Model loaded: ${modelId}`);

  // Enhanced synthesis (48kHz via LavaSR)
  console.log("🎵 Synthesizing with LavaSR enhancement...");
  const result = textToSpeech({
    modelId,
    text: "Hello! This audio was synthesized with Chatterbox and enhanced with LavaSR neural bandwidth extension to 48 kilohertz.",
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  const sampleRate = (await result.sampleRate) ?? ENHANCED_SAMPLE_RATE;
  console.log(`TTS complete. ${audioBuffer.length} samples @ ${sampleRate}Hz`);

  console.log("💾 Saving enhanced audio...");
  createWav(audioBuffer, sampleRate, "tts-enhanced-output.wav");
  console.log("✅ Audio saved to tts-enhanced-output.wav");

  console.log("🔊 Playing enhanced audio...");
  const audioData = int16ArrayToBuffer(audioBuffer);
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, sampleRate),
    audioData,
  ]);
  playAudio(wavBuffer);
  console.log("✅ Audio playback complete");

  // Per-request override: raw synthesis (24kHz, no enhancement)
  console.log("\n🎵 Synthesizing without enhancement (per-request override)...");
  const rawResult = textToSpeech({
    modelId,
    text: "This audio is raw, without any enhancement.",
    inputType: "text",
    stream: false,
    enhance: false,
    denoise: false,
  });

  const rawBuffer = await rawResult.buffer;
  const rawSampleRate = (await rawResult.sampleRate) ?? 24000;
  console.log(`Raw TTS complete. ${rawBuffer.length} samples @ ${rawSampleRate}Hz`);

  console.log("💾 Saving raw audio...");
  createWav(rawBuffer, rawSampleRate, "tts-raw-output.wav");
  console.log("✅ Audio saved to tts-raw-output.wav");

  console.log("🔊 Playing raw audio...");
  const rawAudioData = int16ArrayToBuffer(rawBuffer);
  const rawWavBuffer = Buffer.concat([
    createWavHeader(rawAudioData.length, rawSampleRate),
    rawAudioData,
  ]);
  playAudio(rawWavBuffer);
  console.log("✅ Audio playback complete");

  await unloadModel({ modelId });
  console.log("Model unloaded");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
