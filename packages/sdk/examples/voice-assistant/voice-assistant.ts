/**
 * Real-time Voice Assistant: mic → Whisper (with Silero VAD) → Llama → Supertonic TTS.
 *
 * Usage: bun run examples/voice-assistant/voice-assistant.ts
 *
 * Speak a question; the VAD detects when you pause, the utterance is
 * transcribed, sent to the LLM, and the response is spoken back. The loop
 * continues until you press Ctrl+C. While the assistant is speaking, mic
 * audio is dropped so it does not hear itself.
 *
 * Requirements: FFmpeg installed, microphone access, speakers.
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  completion,
  textToSpeech,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  LLAMA_3_2_1B_INST_Q4_0,
  TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE,
  TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import { platform } from "os";
import { createWavHeader, int16ArrayToBuffer, playAudio } from "../tts/utils";

const MIC_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 44100;

const SYSTEM_PROMPT =
  "You are a concise, friendly voice assistant. Keep responses under two sentences. " +
  "Never use markdown, lists, or code blocks — your output will be spoken aloud.";

// VAD parameters tuned for conversational speech. These values are consistent
// across the mic and file-based streaming examples so behavior is predictable:
//   - threshold 0.5: Silero default; sensitive enough for normal speaking volume.
//   - min_speech_duration_ms 250: drops short noises (clicks, breaths).
//   - min_silence_duration_ms 500: feels responsive without cutting mid-phrase.
//   - max_speech_duration_s 15: caps runaway utterances.
//   - speech_pad_ms 200: padding improves accuracy on utterance edges.
const VAD_PARAMS = {
  threshold: 0.5,
  min_speech_duration_ms: 250,
  min_silence_duration_ms: 500,
  max_speech_duration_s: 15.0,
  speech_pad_ms: 200,
};

function getAudioInputArgs(): string[] {
  switch (platform()) {
    case "darwin":
      return ["-f", "avfoundation", "-i", ":0"];
    case "win32":
      return [
        "-f",
        "dshow",
        "-i",
        "audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{58C07110-A4FD-4FF8-BA10-5A3C14389F71}",
      ];
    case "linux":
      return ["-f", "pulse", "-i", "default"];
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

function startMicrophone() {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...getAudioInputArgs(),
      "-ar",
      String(MIC_SAMPLE_RATE),
      "-ac",
      "1",
      "-sample_fmt",
      "flt",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!ffmpeg.stdout) throw new Error("Failed to open microphone");
  return ffmpeg;
}

function isMeaningfulTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("[No speech detected]")) return false;
  // Whisper sometimes emits non-linguistic cues on silence, e.g. "[BLANK_AUDIO]".
  if (/^\[[^\]]+\]$/.test(trimmed)) return false;
  return true;
}

// ── Main ──

try {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) throw new Error("FFmpeg not found");
} catch {
  console.error("FFmpeg is required. Install it and try again.");
  process.exit(1);
}

console.log("Loading whisper-tiny + Silero VAD...");
const asrModelId = await loadModel({
  modelSrc: WHISPER_TINY,
  modelType: "whisper",
  modelConfig: {
    vadModelSrc: VAD_SILERO_5_1_2,
    audio_format: "f32le",
    strategy: "greedy",
    n_threads: 4,
    language: "en",
    no_timestamps: true,
    suppress_blank: true,
    suppress_nst: true,
    temperature: 0.0,
    vad_params: VAD_PARAMS,
  },
});

console.log("Loading Llama 3.2 1B...");
const llmModelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  modelConfig: {
    ctx_size: 4096,
  },
});

console.log("Loading Supertonic TTS...");
const ttsModelId = await loadModel({
  modelSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32.src,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "supertonic",
    language: "en",
    speed: 1.05,
    numInferenceSteps: 5,
    supertonicMultilingual: false,
    ttsTextEncoderSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32.src,
    ttsDurationPredictorSrc:
      TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32.src,
    ttsVectorEstimatorSrc:
      TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32.src,
    ttsVocoderSrc: TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32.src,
    ttsUnicodeIndexerSrc:
      TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32.src,
    ttsTtsConfigSrc: TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE.src,
    ttsVoiceStyleSrc: TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE.src,
  },
});

console.log("All models loaded.\n");

const ffmpeg = startMicrophone();
const session = await transcribeStream({ modelId: asrModelId });

const history: Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> = [{ role: "system", content: SYSTEM_PROMPT }];

// Dropped-chunk gate: while the assistant is speaking we stop feeding the mic
// stream into the ASR session. Using a flag (rather than pausing the ffmpeg
// pipe) keeps the pipe drained so we never accumulate stale audio, and the
// VAD starts fresh on the next user turn.
let isSpeaking = false;

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  if (isSpeaking) return;
  session.write(chunk);
});

let shuttingDown = false;
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\nStopping...");
  ffmpeg.kill();
  try {
    session.end();
  } catch {
    // session may already be closed
  }
  await unloadModel({ modelId: ttsModelId }).catch(() => {});
  await unloadModel({ modelId: llmModelId }).catch(() => {});
  await unloadModel({ modelId: asrModelId }).catch(() => {});
  console.log("Done.");
  process.exit(0);
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());

console.log("🎙️  Listening. Speak a question and pause. Ctrl+C to quit.\n");

for await (const rawText of session) {
  if (!isMeaningfulTranscript(rawText)) continue;
  const userText = rawText.trim();

  console.log(`🗣️  You: ${userText}`);
  history.push({ role: "user", content: userText });

  isSpeaking = true;
  try {
    process.stdout.write("🤖 Assistant: ");
    const llmResult = completion({
      modelId: llmModelId,
      history,
      stream: true,
    });
    let assistantText = "";
    for await (const token of llmResult.tokenStream) {
      process.stdout.write(token);
      assistantText += token;
    }
    process.stdout.write("\n");
    history.push({ role: "assistant", content: assistantText });

    const spoken = assistantText.trim();
    if (spoken.length > 0) {
      const ttsResult = textToSpeech({
        modelId: ttsModelId,
        text: spoken,
        inputType: "text",
        stream: false,
      });
      const samples = await ttsResult.buffer;
      const audioData = int16ArrayToBuffer(samples);
      const wavBuffer = Buffer.concat([
        createWavHeader(audioData.length, TTS_SAMPLE_RATE),
        audioData,
      ]);
      playAudio(wavBuffer);
    }
  } catch (turnError) {
    console.error(
      "\n⚠️  Turn failed:",
      turnError instanceof Error ? turnError.message : turnError,
    );
  } finally {
    isSpeaking = false;
    console.log("\n🎙️  Listening...\n");
  }
}
