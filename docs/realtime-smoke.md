# Realtime API Smoke Test

This component-level manual test streams real audio files directly to the OpenAI Realtime Translation API and verifies the optional input transcript, translated transcript, translated audio, and clean session closure. It is excluded from normal pull request CI and must be started explicitly through the `Realtime API Smoke` GitHub Actions workflow. It exercises the same `gpt-realtime-translate` output path as the browser, but not the browser's separate `gpt-live-transcribe` connection or row-alignment composition.

## Evaluation data

Use uncompressed 16-bit PCM WAV audio. Mono and multi-channel files at any sample rate are accepted; the runner converts them to 24 kHz mono PCM16. Do not commit audio that contains personal or confidential information or that you are not licensed to use.

Copy `tests/fixtures/realtime/manifest.example.json` to `manifest.json` and place the WAV files in the same directory. Each case contains the following fields:

- `id`: Unique case name.
- `audio`: WAV path relative to the manifest.
- `sourceLanguage`: `ja`, `en`, or `mixed` for Japanese/English code-switching.
- `targetLanguage`: `ja` or `en`.
- `expectedSource`: Required reference transcript.
- `expectedTranslation`: Optional representative reference translation.
- `requiredTranslationTerms`: Optional required terms. Each nested array represents acceptable spelling variants.
- `thresholds`: Optional error-rate limits for transcription and translation, plus the required-term coverage threshold.
- `expectAudio`: Set to `false` to skip checking for translated audio. The default is `true`.

Japanese and `mixed` cases use the normalized character error rate (CER); English cases use the word error rate (WER). The default maximum error rates are 0.35 for source transcription and 0.65 for translation. Because multiple translations can be valid, do not rely only on `expectedTranslation` when evaluating accuracy. Also list proper nouns, numbers, dates, and similar critical content under `requiredTranslationTerms`.

## Local execution

```bash
OPENAI_API_KEY=... npm run test:smoke:api -- \
  --fixture tests/fixtures/realtime/manifest.json
```

Add `--case ja-to-en` to run one case. Add `--validate-only` to validate the manifest and WAV conversion without connecting to the API.

Add `--repeat 10` to run every selected case ten times. The runner prints nearest-rank p50 and p95 values for the first source delta, first translation delta, and `translation - source`, then identifies the model on the median critical path.

The runner streams each WAV file in real time in 100 ms chunks. At the end of the audio, it sends `session.close` and waits for `session.closed`. The output includes the source transcript, translation, individual evaluation results, and latency to the first source transcript, first translation, first translated audio, and session closure.

## Latest local benchmark

The basic fixtures were run ten times per direction on 2026-09-01. All 20 runs returned source text, translation text, translated audio, and `session.closed`.

| Direction | Source p50/p95 | Translation p50/p95 | Translation minus source p50/p95 | Median critical path |
| --- | --- | --- | --- | --- |
| Japanese to English | 3,904/4,920 ms | 4,199/10,364 ms | 294/6,207 ms | `gpt-realtime-translate` |
| English to Japanese | 2,973/3,146 ms | 2,619/3,852 ms | -329/910 ms | `gpt-live-transcribe` |

The command exited nonzero because the current representative translations and required-term lists do not cover all valid paraphrases. Human-confirm the Japanese source reference, especially whether `とても` is present in the audio, before changing thresholds or model settings.

A one-run-per-direction regression check on 2026-09-02 also returned non-empty source text, translated text, translated audio, and clean closure in both directions. Japanese-to-English first source/translation deltas were 3,947/6,157 ms; English-to-Japanese were 2,998/2,188 ms. The command again exited nonzero on translation error-rate and required-term assertions. The Japanese-to-English output used a valid paraphrase, while the English-to-Japanese output omitted the greeting required by the reference.

## GitHub Actions

1. Add `OPENAI_API_KEY` as a repository Actions secret.
2. Select `Realtime API Smoke` under Actions.
3. Enter the path of a committed manifest in the `fixture` field and run the workflow.

Because this test incurs API costs and is affected by model variability and external outages, it is currently available only through `workflow_dispatch` and is not a required pull request check. Do not expose the API key to pull requests from external contributors.

## Physical microphone verification

A physical microphone cannot be reproduced reliably in CI. Complete the following manual checks before a release:

1. Add the API key to `.env.local` and start the app with `npm run dev`.
2. Allow microphone access in the browser and speak at least three utterances, alternating between Japanese and English.
3. Keep translated audio at `再生しない`, start the conversation, and confirm that the transcription session plus both target-language Translation sessions reach `リスニング中`. Confirm that an empty aligned row appears when speech begins, the `gpt-live-transcribe` source and opposite-language Translation transcript stream under the same row number, and both translated audio outputs remain muted.
4. Stop, set translated audio to `自動` (Auto), and start again. Confirm that only the language opposite the source language is played. Switch back to `再生しない` and on again during the live session; confirm through browser network diagnostics that the Translation connections stay open while only their mute state changes.
5. Confirm that the session can be stopped both while connecting and after connecting, and that live transcript rows remain visible afterward.
6. Open the browser developer console and inspect `window.__xlatorLatency`. Confirm that each completed utterance records `speech-to-source-display`, `speech-to-translation-display`, and `silence-to-row-final` where local VAD detected the boundaries. Compare these measurements with the direct Translation benchmark only after collecting repeated representative microphone runs.

This is a separate manual smoke test covering microphone permission, WebRTC, and browser audio playback. It is not part of the file-based Realtime API accuracy evaluation.
