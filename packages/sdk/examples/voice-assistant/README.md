# Real-time Voice Assistant

End-to-end voice assistant running fully locally:

```
microphone → Whisper (Silero VAD) → Llama 3.2 → Supertonic TTS → speakers
```

Each loop iteration:

1. The mic streams 16 kHz f32le audio into a `transcribeStream` session.
2. Silero VAD detects a pause and emits the transcribed utterance.
3. The utterance is appended to conversation history and sent to the LLM.
4. LLM tokens stream to stdout; the full response is sent to Supertonic.
5. TTS audio is played back through the system speaker.
6. While the assistant speaks, incoming mic audio is dropped so it does
   not transcribe itself.

## Run it

```bash
bun run examples/voice-assistant/voice-assistant.ts
```

Press `Ctrl+C` to quit. Models are downloaded on first run and cached
locally; subsequent runs work offline.

## Requirements

- **FFmpeg** installed and on `PATH` (used to capture raw mic audio).
  See [Installing FFmpeg](#installing-ffmpeg) below.
- **Microphone** access (on macOS, Terminal / your shell needs mic
  permission in _System Settings → Privacy & Security → Microphone_).
- **Speakers** — uses the platform default player (`afplay` on macOS,
  `aplay` on Linux, `powershell` on Windows).

### Installing FFmpeg

| Platform             | Command                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| macOS (Homebrew)     | `brew install ffmpeg`                                                                                |
| Debian / Ubuntu      | `sudo apt update && sudo apt install ffmpeg`                                                         |
| Fedora / RHEL        | `sudo dnf install ffmpeg` (enable [RPM Fusion](https://rpmfusion.org/Configuration) first if needed) |
| Arch Linux           | `sudo pacman -S ffmpeg`                                                                              |
| Windows (winget)     | `winget install Gyan.FFmpeg`                                                                         |
| Windows (Chocolatey) | `choco install ffmpeg`                                                                               |

Verify the install with:

```bash
ffmpeg -version
```

If `ffmpeg` is not on your `PATH` after install (common on Windows when
installed manually), download a static build from
[ffmpeg.org/download.html](https://ffmpeg.org/download.html) and add its
`bin/` directory to your `PATH`.

## Models used

| Stage | Model                    | Notes                                              |
| ----- | ------------------------ | -------------------------------------------------- |
| ASR   | `WHISPER_TINY`           | Fast, English-only, good enough for short commands |
| VAD   | `VAD_SILERO_5_1_2`       | Silero v5.1.2, loaded alongside Whisper            |
| LLM   | `LLAMA_3_2_1B_INST_Q4_0` | 1B instruct, 4-bit quantized                       |
| TTS   | Supertonic2 (English)    | 44.1 kHz general-purpose TTS                       |

## VAD tuning

The VAD parameters are tuned for natural conversation and match the
values used in `examples/transcription/whispercpp-filesystem-streaming.ts`:

```ts
{
  threshold: 0.5,              // Silero default sensitivity
  min_speech_duration_ms: 250, // drop short clicks / breaths
  min_silence_duration_ms: 500,// responsive without cutting mid-phrase
  max_speech_duration_s: 15.0, // cap runaway utterances
  speech_pad_ms: 200,          // edge padding improves accuracy
}
```

If you find the assistant cutting you off, increase
`min_silence_duration_ms` (e.g. to `700`). If it feels slow to respond
after you stop talking, lower it.

## Customizing

- **Different LLM:** swap `LLAMA_3_2_1B_INST_Q4_0` for any `*_LLM`
  model constant from `@qvac/sdk`. Larger models give better answers at
  the cost of latency.
- **Different voice:** replace the Supertonic constants with another
  TTS model (e.g. Chatterbox — see `examples/tts/chatterbox.ts`).
- **System prompt:** edit `SYSTEM_PROMPT` at the top of the script.
  The default instructs the LLM to be concise and avoid markdown so
  responses are pleasant to listen to.
