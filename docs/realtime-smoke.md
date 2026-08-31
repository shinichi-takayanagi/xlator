# Realtime API Smoke Test

This manual test streams real audio files to the OpenAI Realtime Translation API in real time and verifies the input transcript, translated transcript, translated audio, and clean session closure. It is excluded from normal pull request CI and must be started explicitly through the `Realtime API Smoke` GitHub Actions workflow.

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

The runner streams each WAV file in real time in 100 ms chunks. At the end of the audio, it sends `session.close` and waits for `session.closed`. The output includes the source transcript, translation, individual evaluation results, and latency to the first source transcript, first translation, first translated audio, and session closure.

## GitHub Actions

1. Add `OPENAI_API_KEY` as a repository Actions secret.
2. Select `Realtime API Smoke` under Actions.
3. Enter the path of a committed manifest in the `fixture` field and run the workflow.

Because this test incurs API costs and is affected by model variability and external outages, it is currently available only through `workflow_dispatch` and is not a required pull request check. Do not expose the API key to pull requests from external contributors.

## Physical microphone verification

A physical microphone cannot be reproduced reliably in CI. Complete the following manual checks before a release:

1. Add the API key to `.env.local` and start the app with `npm run dev`.
2. Allow microphone access in the browser and speak at least three utterances, alternating between Japanese and English.
3. Confirm that both Realtime sessions reach `リスニング中` (Listening), and that each source utterance and translation appear under the same row number.
4. Set translated audio to `自動` (Auto) and confirm that only the language opposite the source language is played.
5. Confirm that the session can be stopped both while connecting and after connecting, and that live transcript rows remain visible afterward.

This is a separate manual smoke test covering microphone permission, WebRTC, and browser audio playback. It is not part of the file-based Realtime API accuracy evaluation.
