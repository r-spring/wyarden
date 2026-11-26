# Parakeet CLI: capabilities and Entomatical controls

Reviewed 2 November 2026. This report covers the installed **parakeet-cli.exe** from whisper.cpp, not every application or runtime that can load NVIDIA Parakeet models.

## Findings and scope

The installed command has ten switches. All ten are mapped below to Entomatical settings or actions. File arguments and standard-input transport are documented separately. The executable performs local transcription with the Parakeet engine; sharing a distribution directory with Whisper does not make the model Whisper-based.

The review used the executable's `--help`, native sample runs, and the matching CLI/source layout in the local whisper.cpp checkout at `482279b8a18855ba741d7b88c30fcb3874691f59`. The binary SHA-256 is `c63dce82c89354c4bf17ad277fbf71c9e3e05c2573f7262bde3fd15734a87d11`. A source checkout and matching behavior do not independently prove a reproducible binary build. The executable has no version switch in its parser.

Primary source references: [CLI implementation](https://github.com/ggml-org/whisper.cpp/blob/482279b8a18855ba741d7b88c30fcb3874691f59/examples/parakeet-cli/parakeet-cli.cpp), [audio decoder](https://github.com/ggml-org/whisper.cpp/blob/482279b8a18855ba741d7b88c30fcb3874691f59/examples/common-whisper.cpp), [Parakeet library](https://github.com/ggml-org/whisper.cpp/blob/482279b8a18855ba741d7b88c30fcb3874691f59/src/parakeet.cpp), and [public C API](https://github.com/ggml-org/whisper.cpp/blob/482279b8a18855ba741d7b88c30fcb3874691f59/include/parakeet.h).

## Every CLI switch

| Short / long form | CLI behavior | Entomatical exposure |
|---|---|---|
| `-h` / `--help` | Prints options and exits without loading a model | Parakeet tools → Installed CLI help; also a Command Palette action |
| `-t N` / `--threads N` | Sets inference CPU thread count; native default is at most four hardware threads | Speech: Parakeet Threads; Entomatical default 4, positive integer |
| `-m FILE` / `--model FILE` | Loads a compatible Parakeet model | Existing Parakeet folder and model dropdown, plus Parakeet Model Path |
| `-f FILE` / `--file FILE` | Adds an input audio file; may be repeated | Parakeet tools → Transcribe audio files; multiple selection supported |
| `-ng` / `--no-gpu` | Disables GPU inference | Speech: Parakeet Use Gpu = off |
| `-dev N` / `--device N` | Chooses a GPU device index; default 0 | Speech: Parakeet Gpu Device; nonnegative integer |
| `-ps` / `--print-segments` | Prints segment boundaries and detailed token records to stderr | Speech: Parakeet Print Segments; inspect Last transcription details afterward |
| `-otxt` / `--output-txt` | Writes recognized segment text to a text file | Transcribe audio files → Save text files to a folder; also used for dictation's temporary transcript |
| `-of PREFIX` / `--output-file PREFIX` | Sets the output prefix; the CLI appends `.txt` | Export destination picker. Entomatical uses isolated output then creates `<audio basename>.txt` in that folder. To choose a custom single filename, open the transcript and use VS Code Save As. |
| `-np` / `--no-prints` | Suppresses most Parakeet logs and timings | Speech: Parakeet Quiet; default off. Does not fully silence backend startup, audio decoding, or explicitly requested segment output. |

Changing Parakeet settings does not alter Whisper's model or credentials. Advanced controls apply to both new dictation sessions and imported files. Invalid values are rejected before starting recording. GPU index validation checks the numeric value; device availability is determined by the native runtime. GPU device 0 was tested on the installed RTX 4080 SUPER; another device index was not tested because there is one CUDA device on this computer.

## Inputs, batching and output

The CLI also accepts positional filenames, equivalent to repeated `-f`. It loads the model once and processes those files sequentially. Entomatical's editor-output mode passes all selected files to one invocation, returning their transcripts in order. The native stdout separates transcripts with newlines rather than filenames.

For text export, Entomatical processes each file independently and produces one named text file per source. This reloads the model per file. It intentionally avoids the CLI's behavior where using one `-of` prefix with several files overwrites that same output repeatedly. Existing destination files and duplicate basenames are refused; an exclusive-create write protects against a file appearing after the initial check. Cancelled or failed batches may retain already-completed exports; unfinished temporary files are removed.

The advertised formats are WAV, FLAC, MP3 and Ogg. The shared decoder converts supported audio to mono floating-point 16 kHz for inference. Actual codec support depends on how the executable was built; optional FFmpeg fallback is a compile-time feature. WAV was tested on this installation. FLAC, MP3 and Ogg were checked against source/help but were not independently decoded in this review.

A positional `-` reads encoded audio from standard input until EOF. This worked in a native probe with the WAV sample. It does not capture a microphone or stream live recognition. Entomatical's existing recorder supplies the equivalent audio through a temporary WAV file; there is no separate stdin toggle in the UI because stdin changes transport, not a dictation capability. The API does not accept arbitrary shell pipelines from settings.

The CLI prints token text to stdout incrementally while it decodes already-recorded audio. This is not true streaming recognition from a live microphone. Entomatical's Parakeet mode still records until Stop or silence, then transcribes. The mic recording limit and per-process transcription timeout remain two minutes; imported recordings do not have a two-minute audio-duration check but must finish inference within that timeout. Output capture is bounded to 1 MiB per stdout/stderr stream; unusually verbose token dumps can hit this limit.

## Details and timing fields

Last transcription details opens the most recent process's output in an editable plain-text document. Nothing is rendered as executable HTML. The underlying capture is held only in memory, replaced by the next run, and lost on window shutdown. The displayed document can be saved by the user; VS Code may retain open-document backups. Details contain the recognized speech and local paths, so they should not be treated as a harmless anonymous performance log.

With Print Segments enabled the CLI reports:

- Segment count, index, start/end boundaries and segment text. A segment may contain a whole clip; these are not speaker labels.
- Token index and vocabulary ID, decoder frame index, duration-class index and selected duration value.
- `p` and `plog`, emitted probability and log-probability fields. They are native token diagnostics, not a calibrated whole-transcript confidence score; this review did not validate their statistical calibration or consistency.
- `t0` / `t1`, time boundaries in mel-frame units. In this implementation one mel frame corresponds to 10 ms (160 samples at 16 kHz). Token decoder frames are mapped through the model's subsampling factor; the inspected model uses factor 8. The UI preserves the raw values rather than presenting them as verified word-level subtitle timing.
- `word_start`, a marker based on the tokenizer's word-boundary token convention, and the token's text piece.

Without Quiet mode, diagnostics also include model information, backend/device messages and native timing measurements. CPU mode can still print CUDA-backend discovery during startup; that message alone does not establish that inference ran on the GPU. With several imported files, Last transcription details covers the single native batch in editor-output mode, or only the most recent file in export mode.

## Environment behavior and failure handling

`PARAKEET_ARG_DEVICE` can set the CLI's initial GPU device; an explicit `-dev` is parsed afterward. A malformed environment value can fail before argument processing because the CLI parses it as an integer. Entomatical sends its chosen device explicitly but does not manage the system environment.

The shared decoder recognizes `WHISPER_COMMON_MINIAUDIO_SKIP`: a nonempty value other than `0` skips its normal decoder. That is a backend troubleshooting mechanism, not a Parakeet language or quality control. It can make decoding fail when no FFmpeg fallback is compiled in. Other GGML backend environment variables are runtime-specific and are not additional Parakeet CLI flags.

Native probes confirmed that an input-file failure can print `error:` and still exit zero. Entomatical now checks anchored native error lines as well as process failure, and treats a missing transcript output as failure. It does not publish an error body's contents in a popup. Details are available explicitly through Parakeet tools. Transcription cancellation aborts the process. There is no silent fallback to Whisper or a cloud provider.

## Features this CLI does not expose

There are no parser options for a language override, translation, vocabulary hints, hotwords, prompts, beam width, temperature, speaker diarization, VAD settings, microphone-device selection, a network server, or JSON/SRT/VTT output. Greedy decoding is selected internally. Model-driven punctuation/capitalization and automatic multilingual recognition do not have separate toggles. Selecting a different runtime does not automatically add model capabilities.

The linked C library offers more programmer-facing entry points: loading from files/buffers/custom loaders, separate state allocation, PCM-to-mel conversion and custom mel input, encoder calls, tokenization, full/chunk inference, token/segment getters, timings, logging, and callbacks. Its parameter structure declares offsets, durations, context size and callbacks. These are not CLI switches, and their presence in a header is not proof of a complete, tested user feature. This change does not introduce a native library binding or claim those internal APIs are exposed by Entomatical.

`parakeet-quantize` is a separate model-conversion executable, not a switch of parakeet-cli. Quantized-model loading is supported by the existing model file; this review does not change or regenerate that model.

## Other runtimes

| Runtime | Role and tradeoff |
|---|---|
| [NeMo / PyTorch](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | NVIDIA's reference model ecosystem, including training/fine-tuning. Larger Python/dependency stack than the current standalone executable. |
| [Hugging Face Transformers](https://huggingface.co/docs/transformers/model_doc/parakeet) | Python model and processor APIs for application integration. Uses its own supported checkpoint format, not the installed GGML file. |
| [ONNX Runtime / sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html) | Exported graphs and application-oriented runtimes, including Parakeet TDT v3. Exact hardware providers depend on the build. A candidate for future integration; not benchmarked here. |
| [parakeet-mlx](https://github.com/senstella/parakeet-mlx) | Community implementation for Apple Silicon; not a runtime for this Windows/NVIDIA installation. |
| [NVIDIA NIM](https://docs.nvidia.com/nim/speech/26.10.0/asr/index.html) | Containerized inference services. Streaming/offline capabilities depend on the specific model served; a streaming RNNT deployment is not the same checkpoint as this TDT GGML model. |
| Current whisper.cpp Parakeet CLI | Native local C++ execution, already installed and verified. Its own engine is independent of the Whisper model loader. |

These are runtime alternatives, not selections newly added to Entomatical. Model conversion or a matching export is needed when switching formats. No alternative runtime was installed or benchmarked during this change.

## Verification and remaining gaps

Native Windows tests used the public 11-second JFK WAV sample and the installed Parakeet TDT 0.6B v3 q8_0 model. No live user microphone audio or paid cloud endpoint was needed.

| Probe | Observed result |
|---|---|
| GPU, two CPU threads, device 0, Print Segments | Exit 0, 108 transcript characters, token/segment diagnostics; 0.977 s in one probe |
| CPU-only, two threads, Quiet | Exit 0, same 108 characters; 1.910 s in one probe |
| Two-file native batch | Exit 0, two transcripts; 0.981 s in one probe |
| Encoded WAV on stdin | Exit 0, 108 characters; 0.952 s in one probe |
| Missing audio input | Exit 0 but native error and no transcript: regression case now handled |
| Updated Entomatical adapter | GPU/device/threads, segment capture, batch, CPU/quiet, text prefix export and cancellation passed |

Those timings are individual smoke tests with one cached model and short public sample, not representative speed benchmarks. Accuracy on user speech, noisy/long recordings, other codecs/models/devices and Linux live audio remains unverified.

Automated checks: 385 total, 376 passed, 9 platform/environment skips, no failures. They cover typed argument construction, invalid settings, zero-exit native errors, literal spoken `error:` text, cancellation and busy-state cleanup, settings propagation, editor output, safe export/no-overwrite, and existing dictation behavior. Browser checks and visual inspection cover Parakeet tools at 360 and 1100 px. Updated native VS Code command interaction still needs a user retry after reloading the installed extension.
