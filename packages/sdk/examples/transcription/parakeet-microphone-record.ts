/**
 * Microphone → Parakeet transcription using chunked `transcribe` calls.
 *
 * Usage: bun run examples/transcription/parakeet-microphone-record.ts
 *
 * Captures 3-second audio chunks from the microphone and sends each to the
 * batch `transcribe` API. Press Ctrl+C to quit.
 *
 * Requirements: FFmpeg installed, microphone access.
 */
import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import { platform } from "os";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // s16le
const CHUNK_DURATION_S = 3;
const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_DURATION_S;

function listWindowsAudioDevices(): string[] {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8" },
  );
  const stderr = result.stderr ?? "";
  const devices: string[] = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.includes("DirectShow audio devices")) {
      inAudioSection = true;
      continue;
    }
    if (line.includes("DirectShow video devices")) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;
    const match = line.match(/"([^"]+)"/);
    if (!match) continue;
    const name = match[1];
    if (!name || name.startsWith("@device")) continue;
    devices.push(name);
  }
  return devices;
}

function getAudioInputArgs(): string[] {
  const env = process.env as Record<string, string | undefined>;
  const override = env["MIC_DEVICE"];
  switch (platform()) {
    case "darwin":
      return ["-f", "avfoundation", "-i", override ?? ":0"];
    case "linux":
      return ["-f", "pulse", "-i", override ?? "default"];
    case "win32": {
      const deviceName = override ?? listWindowsAudioDevices()[0];
      if (!deviceName) {
        throw new Error(
          "No Windows audio input device found. List devices with:\n" +
            "  ffmpeg -hide_banner -list_devices true -f dshow -i dummy\n" +
            'Then set MIC_DEVICE="Your Device Name" and retry.',
        );
      }
      return ["-f", "dshow", "-i", `audio=${deviceName}`];
    }
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

// ── Main ──

try {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) throw new Error("FFmpeg not found");
} catch {
  console.error("FFmpeg is required. Install it and try again.");
  process.exit(1);
}

console.log("Loading Parakeet model...");
const modelId = await loadModel({
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
  onProgress: (p) => console.log(`Download: ${p.percentage.toFixed(1)}%`),
});
console.log("Model loaded.\n");

const ffmpeg = spawn(
  "ffmpeg",
  [
    ...getAudioInputArgs(),
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-sample_fmt",
    "s16",
    "-f",
    "s16le",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
if (!ffmpeg.stdout) throw new Error("Failed to open microphone");

let buffer = Buffer.alloc(0);
let processing = false;

console.log("Listening... speak and pause to see transcriptions.\n");

ffmpeg.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (buffer.length >= CHUNK_SIZE && !processing) {
    const audioChunk = buffer.subarray(0, CHUNK_SIZE);
    buffer = buffer.subarray(CHUNK_SIZE);
    processing = true;

    void (async () => {
      try {
        const text = await transcribe({ modelId, audioChunk });
        if (text.trim() && !text.includes("[No speech detected]")) {
          console.log(`> ${text.trim()}`);
        }
      } catch (err) {
        console.error(
          "Transcription error:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        processing = false;
      }
    })();
  }
});

async function cleanup() {
  console.log("\n\nStopping...");
  ffmpeg.kill();
  await unloadModel({ modelId });
  console.log("Done.");
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
