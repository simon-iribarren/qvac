/**
 * Microphone → Whisper streaming transcription with native VAD.
 *
 * Usage: bun run examples/transcription/whispercpp-microphone-record.ts
 *
 * Speak into your mic; transcriptions appear automatically when you pause.
 * Press Ctrl+C to quit.
 *
 * Requirements: FFmpeg installed, microphone access.
 */
import {
  loadModel,
  unloadModel,
  transcribeStream,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";
import { spawn, spawnSync } from "child_process";
import { platform } from "os";

const SAMPLE_RATE = 16000;

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

console.log("Loading model (whisper-tiny + Silero VAD)...");
const modelId = await loadModel({
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
    vad_params: {
      threshold: 0.6,
      min_speech_duration_ms: 250,
      min_silence_duration_ms: 300,
      max_speech_duration_s: 15.0,
      speech_pad_ms: 100,
    },
  },
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
    "flt",
    "-f",
    "f32le",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
if (!ffmpeg.stdout) throw new Error("Failed to open microphone");

const session = await transcribeStream({ modelId });

ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));

console.log("Listening... speak and pause to see transcriptions.\n");

for await (const text of session) {
  console.log(`> ${text.trim()}`);
}

async function cleanup() {
  console.log("\n\nStopping...");
  ffmpeg.kill();
  await unloadModel({ modelId });
  console.log("Done.");
}

process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
