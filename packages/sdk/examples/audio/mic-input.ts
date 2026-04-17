/**
 * Shared microphone-capture helpers for the transcription and
 * voice-assistant examples. Wraps ffmpeg so the examples don't each
 * re-implement device selection.
 *
 * The default device is the system default mic. Override on any OS
 * with the MIC_DEVICE environment variable. On Windows, if no override
 * is set, the first DirectShow audio device reported by ffmpeg is used.
 */
import { spawn, spawnSync } from "child_process";
import { platform } from "os";

export type MicFormat = "f32le" | "s16le";

// Parses the DirectShow audio device list printed by:
//   ffmpeg -hide_banner -list_devices true -f dshow -i dummy
// Output goes to stderr; ffmpeg always exits non-zero because `-i dummy`
// isn't a real device — that's expected.
export function listWindowsAudioDevices() {
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
    // Modern ffmpeg: `  "Microphone (Realtek Audio)" (audio)`
    // Older ffmpeg:  `  "Microphone (Realtek Audio)"`
    const match = line.match(/"([^"]+)"/);
    if (!match) continue;
    const name = match[1];
    if (!name) continue;
    // Skip the alternative-name line that starts with `@device_...`
    if (name.startsWith("@device")) continue;
    devices.push(name);
  }
  return devices;
}

export function getAudioInputArgs() {
  const env = process.env as Record<string, string | undefined>;
  const override = env["MIC_DEVICE"];
  switch (platform()) {
    case "darwin":
      // AVFoundation device spec is `<video>:<audio>`. `:0` = default audio.
      // Override with e.g. MIC_DEVICE=":1" to pick another device, or run
      // `ffmpeg -f avfoundation -list_devices true -i ""` to enumerate.
      return ["-f", "avfoundation", "-i", override ?? ":0"];
    case "linux":
      // PulseAudio source name. `default` follows the system default mic.
      // Override with MIC_DEVICE="alsa_input.pci-..." etc.; list with
      // `pactl list short sources`.
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

export interface StartMicrophoneOptions {
  sampleRate: number;
  format: MicFormat;
}

export function startMicrophone(options: StartMicrophoneOptions) {
  const formatArgs =
    options.format === "f32le"
      ? ["-sample_fmt", "flt", "-f", "f32le"]
      : ["-sample_fmt", "s16", "-f", "s16le"];
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...getAudioInputArgs(),
      "-ar",
      String(options.sampleRate),
      "-ac",
      "1",
      ...formatArgs,
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!ffmpeg.stdout) throw new Error("Failed to open microphone");
  return ffmpeg;
}
