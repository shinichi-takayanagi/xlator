# xlator Specification

Last updated: 2026-09-01
Status: Realtime connection MVP implemented; real-audio and live-API verification pending

## 1. Purpose

Build a local web app that captures a conversation containing both Japanese and English through a shared microphone and displays every utterance in both languages.

"Local" means that the UI and server run on `localhost`. Speech recognition and translation require an internet connection to the OpenAI API; the app is not fully offline.

## 2. Product decisions

- Use TypeScript for both browser and server code. It is a better fit than Python for this MVP because WebRTC, React, event-driven APIs, and shared data types can all use one language.
- Use `gpt-realtime-translate` as the translation model.
- Use one shared microphone as input.
- Allow speakers to switch freely between Japanese and English on every utterance.
- Store each utterance as one aligned record rather than treating the Japanese and English logs as separate conversations.
- Display Japanese on the left and English on the right on desktop.
- Stack Japanese above English on narrow screens.
- Keep speaker diarization outside the MVP; add `A` / `B` labels in the future.
- Keep the OpenAI API key on the server and never expose it to the browser.
- Do not currently implement log persistence, recording, or session history.

## 3. Input and output

Detect the source language of each utterance. Show a transcript on the source-language side and a translation on the opposite side.

| Input language | Japanese log | English log |
| --- | --- | --- |
| Japanese | Japanese transcript | English translation |
| English | Japanese translation | English transcript |

Minor ASR normalization is acceptable on the source-language side. For example, `こんちわ` may become `こんにちは`, and `YES` may become `Yes`.

### Acceptance example

Input:

```text
こんちわ、今日は暑いですね
Yes, too hot!
元気ですか？
Yep, I'm fine
```

Japanese log:

```text
こんちわ、今日は暑いですね
ええ、とてもあつね
元気ですか？
はい、元気です！
```

English log:

```text
Hello, it is hot today
YES, too hot!
How are you?
Yep, I'm fine
```

## 4. UI

### Layout

- Show the product name, `REALTIME`, `localhost`, and an icon link to the GitHub repository in the header.
- Provide controls for starting and stopping the conversation, connection status, elapsed time, translated audio, and downloads.
- Display the Japanese and English logs in two columns on desktop.
- Switch to a two-row vertical layout at widths of 620 px or less.
- Use almost the full viewport width for the workspace, with 12 px horizontal margins as the desktop baseline.
- Keep the conversation logs as the primary content; do not add an explanatory hero or text describing the shared row numbers.

### Transcript display

- Keep the same utterance count, order, and sequence numbers in both logs.
- Show the sequence number, start time, `原文` (Source), `翻訳` (Translation), or `処理中` (Processing), and the text in each row.
- Display unfinished rows with reduced emphasis.
- Allow each panel to scroll internally and independently.
- Scroll immediately to the latest position, without animation, when a new utterance or text delta arrives.
- Show 16 sample utterances on the initial screen for UI verification.
- Clear the sample data and switch to live rows when a conversation starts.
- Keep captured live rows visible after the conversation stops.
- Restore the sample data after a page reload.

### Connection status

- `待機中` (Idle): Before starting or after stopping.
- `APIキー未設定` (API key not configured): `OPENAI_API_KEY` was not found during the startup configuration check.
- `接続中` (Connecting): The microphone is available and the Realtime sessions are being established.
- `リスニング中` (Listening): Both the Japanese-target and English-target sessions are connected.
- `接続エラー` (Connection error): API configuration, microphone access, WebRTC, or a Realtime event failed.
- If only one of the two sessions connects, do not start; close both sessions and report an error.
- Do not treat setting the SDP answer as a completed connection. Move to `リスニング中` only after both `RTCPeerConnection.connectionState` values are `connected`.
- Apply one 15-second timeout to the full startup sequence, including short-lived secret acquisition, WebRTC offer and SDP answer exchange, and peer connection establishment.
- Stopping while `接続中` must cancel the in-progress WebRTC connection and prevent a late connection from returning the UI to `リスニング中`.
- If a connected session receives a Realtime API `error` event, stop the microphone, both WebRTC connections, VAD, and finalization timer, then move to `接続エラー`.

## 5. Data model

Keep aligned records in one array rather than maintaining separate Japanese and English log arrays.

```ts
type Utterance = {
  id: string;
  sequence: number;
  at: string;
  sourceLanguage: "ja" | "en" | "unknown";
  sourceText?: string;
  startMs?: number;
  endMs?: number;
  status?: "draft" | "final";
  ja: string;
  en: string;
};
```

Initial sample data contains only display-time strings and translated text. Live data also contains `sourceText`, millisecond timestamps, and status.

## 6. System architecture

```text
Browser / React / TypeScript
  ├─ app/page.tsx: screen composition only
  ├─ useConversationSession
  │    ├─ aligned utterance state
  │    ├─ WebRTC translation session: target=en
  │    └─ WebRTC translation session: target=ja
  ├─ useLocalVad
  │    └─ microphone capture + lightweight local voice activity detection
  └─ ConversationControls
       └─ transient control UI state and download actions
          │ short-lived client secrets
Local Vinext server / TypeScript
  └─ /api/realtime/session
          │ OPENAI_API_KEY
OpenAI Realtime Translation API
  └─ gpt-realtime-translate
```

On the React side, limit `app/page.tsx` to screen composition. `useConversationSession` owns the Realtime connections, aligned utterance state, and translated-audio control. `useLocalVad` owns the Web Audio API and RMS-based VAD lifecycle. `ConversationControls` owns transient UI-only state such as the download menu. Preserve these responsibility boundaries when adding features; do not move connection or VAD implementation back into the page component.

Send the same microphone audio track to two WebRTC sessions in parallel: one targeting English output and one targeting Japanese output. Create both sessions in parallel as well.

Use the dedicated Realtime Translation endpoints for browser-to-OpenAI connections:

- Client secrets: `/v1/realtime/translations/client_secrets`
- WebRTC calls: `/v1/realtime/translations/calls`

## 7. OpenAI API configuration and security

- Read the long-lived key only from the `OPENAI_API_KEY` environment variable.
- Store it in the gitignored `.env.local` file during local development.
- Keep the API key empty in `.env.example`; only include a non-sensitive default for the transcription model.
- Return only short-lived client secrets from the local API to the browser.
- Never store the API key in browser-exposed environment variables such as `NEXT_PUBLIC_*`.
- Configure the Realtime input transcription model through the server-side `OPENAI_TRANSCRIPTION_MODEL` environment variable.
- Use `gpt-live-transcribe` when `OPENAI_TRANSCRIPTION_MODEL` is unset or empty. Record the same default in `.env.example`.
- Use `far_field` input noise reduction.

`GET /api/realtime/session` returns only whether a key is configured; it never returns the key value. `POST` accepts `ja` or `en` and creates a short-lived secret with a ten-minute lifetime.

After the key configuration check succeeds, the browser prefetches the Japanese-target and English-target secrets in parallel. It reuses each secret in memory until five seconds before expiration. If prefetching fails or a secret expires, it fetches a replacement when the connection starts. Secrets are not stored in page storage or persisted.

## 8. Realtime event processing

### Source transcript

Treat `session.input_transcript.delta` from both sessions as source-transcript candidates; do not depend exclusively on the English-target session.

- Keep a candidate string and the latest `elapsed_ms` for each session.
- Prefer the longer candidate.
- Switch to another candidate when its timestamp advances by at least 600 ms, even if its text is shorter.
- This allows one session to take over if the other session's input transcript is delayed or stops.
- Classify text containing Japanese characters as `ja`, text containing Latin characters as `en`, and unclassifiable text as `unknown`.
- After the source language is known, overwrite that language's field with the selected candidate text.

### Translation

Append `session.output_transcript.delta` to the target-language side. Do not append it when the target language matches the source language.

### Utterance boundaries and alignment

The current MVP combines lightweight local VAD through the Web Audio API with a fallback timer for transcript deltas.

- Infer active speech from the microphone's RMS level and a tracking noise floor.
- After speech is detected, finalize the current row after 320 ms of silence when the source candidate ends in sentence punctuation (`。.!！？?…`), or after 450 ms otherwise.
- Late input-transcript deltas alone do not reset the silence interval that began from local audio.
- If VAD does not detect the end of speech, finalize the row after 1.2 seconds without an input-transcript delta.
- Align translation deltas with the nearest recent row using `elapsed_ms` and utterance start times.
- Allow a 400 ms tolerance in timestamp comparisons.
- Route delayed input deltas back to the preceding row for up to 700 ms after finalization.

This approach can combine a long utterance without silence into one row, misidentify boundaries for quiet speech or loud background noise, treat a mid-sentence pause as an utterance boundary, or drift because of timing differences between the two sessions. VAD based on a high-accuracy audio classification model is not implemented.

## 9. Translated audio

The options are `再生しない` (Do not play), `日本語` (Japanese), `English`, and `自動` (Auto). The default is `再生しない`.

Always play only the translation, which is the language opposite the source language.

- Japanese input may play only English audio.
- English input may play only Japanese audio.
- Do not play audio when an explicitly selected language matches the source language.
- `自動` plays the opposite language after source-language detection.
- Reset language detection to `unknown` at session start and whenever audio for the next utterance is detected. Mute both outputs until the source language is known.

## 10. Downloads

Generate files in the browser from the current aligned records. Do not use server-side persistence or an export API. Use the filename `xlator-log.{format}`.

- TXT: Export the Japanese and English logs under separate headings.
- CSV: Export sequence number, time, source language, Japanese, and English.
- JSON: Export `Utterance[]`.
- SRT: For live data, use `startMs` / `endMs` derived from Realtime event `elapsed_ms` values and include both languages in one subtitle. `endMs` is the timestamp of the most recently selected input-transcript delta, not the exact end of the physical speech. For initial sample data, use synthetic timestamps at four-second intervals.

## 11. Latency strategy

- Stream browser audio directly over WebRTC.
- Prefetch two short-lived client secrets after confirming the API key configuration.
- Create both sessions in parallel.
- Fetch the client secret and create the WebRTC offer in parallel within each session.
- Render transcript and translation deltas immediately as they arrive.
- Finalize utterances after 320 ms of silence when terminal punctuation is present, or 450 ms otherwise, without letting late deltas rewind the silence timer.
- Avoid duplicate rendering from a lagging source candidate.
- Search for utterance timestamps from the newest row backward, and do not rerender unchanged rows.
- Do not animate automatic scrolling.
- Client logic cannot eliminate model processing or network latency.
- Measure connection startup, first source transcript, first translation, and utterance finalization separately during evaluation.

## 12. Testing and quality evaluation

Normal CI runs `npm run verify` and requires linting, type checking, a production build, and behavioral tests that do not call the live API.

Use `npm run test:smoke:api` for real-audio and live-API verification. The runner reads uncompressed 16-bit PCM WAV files, downmixes their channels, converts them to 24 kHz PCM16, and sends them to Realtime Translation over WebSocket in real time in 100 ms chunks.

- Compare `session.input_transcript.delta` with the reference transcript.
- Use CER for Japanese and Japanese/English mixed input, and WER for English.
- Evaluate `session.output_transcript.delta` using both its error rate against a representative translation and required-term coverage.
- Confirm that translated-audio deltas are not empty.
- Send `session.close` at the end of the audio and wait for `session.closed`.
- Report latency to the first source transcript, first translation, first translated audio, and session closure.

Because of API cost, model variability, and external outages, the live-API smoke test is not a required normal pull request check. Run it through the manual `Realtime API Smoke` GitHub Actions workflow. Pass the API key only through the `OPENAI_API_KEY` Actions secret.

CI does not reproduce a physical microphone. Before a release, manually verify browser microphone permission, WebRTC connection, alternating Japanese/English utterances, translated audio, and stopping. `docs/realtime-smoke.md` is authoritative for the detailed procedure and fixture format.

### Current implementation and verification status

| Area | Implementation | Verification | Current treatment |
| --- | --- | --- | --- |
| Browser Realtime connection MVP | Implemented | Production build and automated connection/event-processing tests pass | Combined physical-microphone and live-API verification has not been performed |
| Normal CI | GitHub Actions runs `npm run verify` | Lint, type checking, build, and 26 tests pass on the current change branch | Required pull request quality gate |
| Live-API smoke CLI | WAV conversion, WebSocket streaming, CER/WER, translation terms, translated audio, latency, and clean closure checks are implemented | The API-free `--validate-only` path passes through the CLI entry point in automated tests | Live API has not been called |
| Real-audio fixture | Manifest example and input validation are implemented | Conversion passes automated tests with a synthetic WAV | Real speech WAV files, reference transcripts, and reference translations are not registered |
| Manual GitHub Actions workflow | The `workflow_dispatch` `Realtime API Smoke` workflow is implemented | Normal CI passes after adding the workflow; live API has not been called | Required fixture, API key registration, and execution from the default branch remain incomplete |
| Physical microphone verification | Manual procedure is defined in `docs/realtime-smoke.md` | Not performed | Manual pre-release check, not automated CI |

### Remaining work and completion conditions

1. Register real-speech WAV files and reference data.
   - Include at least Japanese-to-English and English-to-Japanese cases.
   - Include utterance-by-utterance language switching, numbers, dates, times, and proper nouns.
   - Add `tests/fixtures/realtime/manifest.json` and its referenced WAV files, then make `--validate-only` pass.
2. Prepare the GitHub Actions environment for live-API execution.
   - Add `OPENAI_API_KEY` as an Actions secret or in a protected environment.
   - After the workflow exists on the default branch, run `Realtime API Smoke` manually.
   - Preserve a successful result for input transcription, translation, translated audio, and `session.closed`.
3. Verify the browser MVP with a physical microphone.
   - Complete the five steps in `docs/realtime-smoke.md`.
   - Verify connection, alternating Japanese/English speech, row alignment, translated audio, and stopping both during and after connection.
4. Tune thresholds using the first measured results.
   - Start with 0.35 for the source transcript and 0.65 for translation. Confirm normal-case variability and important errors that must not be missed before fixing the thresholds.

Until items 1 through 3 succeed, describe the live-API smoke test and physical-microphone verification as "infrastructure and procedures implemented; field verification pending," not simply "implemented."

## 13. Currently unsupported

- Speaker diarization and speaker labels.
- Separation of overlapping speech.
- Audio recording and reprocessing.
- Persistent storage such as SQLite.
- Session history.
- Manual transcript editing.
- Proper-noun dictionaries.
- Automatic connection retry.
- High-accuracy utterance boundaries using a dedicated VAD model.
- Automated end-to-end tests using a physical microphone.

## 14. Future candidates

1. Expand the Japanese/English code-switching golden set with real-speech WAV files.
2. Improve utterance boundaries and alignment between the two sessions.
3. Add recording persistence and session history.
4. Add post-processing speaker diarization (`A` / `B`).
5. Add manual correction of recognition and translation errors.
6. Add a proper-noun dictionary.

## 15. Key files

```text
AGENTS.md                                Codex working rules
docs/spec.md                             This specification
app/page.tsx                             Screen composition only
app/components/conversation-controls.tsx Conversation controls, translated-audio selection, and download UI
app/components/session-error-toast.tsx   Connection error display
app/components/site-header.tsx           Header
app/components/transcript-panel.tsx      Japanese and English transcript panels
app/components/ui-icons.tsx              UI icons and waveform
app/hooks/use-conversation-session.ts    Realtime connections, utterance state, and translated-audio control
app/hooks/use-local-vad.ts               Local VAD using the Web Audio API
app/globals.css                          Layout and styles
app/api/realtime/session/route.ts        Short-lived secret issuance
lib/demo-utterances.ts                   Initial-screen fixture
lib/download-log.ts                      TXT / CSV / JSON / SRT generation
lib/local-vad.ts                         Pure VAD silence-duration logic
lib/realtime-translation.ts              WebRTC connection
lib/translation-types.ts                 Shared data types
lib/utterance-alignment.ts               Language detection and utterance alignment
lib/realtime-smoke.ts                    WAV conversion, Realtime WebSocket, and accuracy evaluation
scripts/realtime-smoke.ts                Live-API smoke-test CLI
tests/fixtures/realtime/                 Real-audio manifest and golden set
.github/workflows/realtime-smoke.yml     Manual live-API smoke test
docs/realtime-smoke.md                   Fixture, execution, and physical-microphone procedures
worker/index.ts                          Vinext Worker entry point
.env.example                             Environment variable example
```

Do not keep scaffold code for databases, authentication, sample APIs, or other features unused by the current MVP.

## 16. Acceptance checks

- The latest rows in both columns are visible on the initial screen.
- Desktop horizontal margins are minimal.
- Both panels automatically follow the final row in the 16-utterance sample data.
- Starting a conversation connects two Realtime sessions after microphone permission is granted.
- A prefetched short-lived client secret is reused at connection start if it has not expired.
- Alternating Japanese and English speech produces both languages under the same sequence number.
- When local VAD detects silence after speech, rows finalize after approximately 320 ms with terminal punctuation or 450 ms otherwise.
- If one input transcript stops, the app follows the other session's candidate.
- Translated audio plays only in the language opposite the source language.
- TXT, CSV, JSON, and SRT files can be downloaded.
- Real-audio fixtures can be validated for structure and WAV conversion without an API connection.
- The live-API smoke test can be started from the manual workflow.
- The API key does not appear in browser HTML, JavaScript, or downloads.
- The GitHub icon in the header opens this repository in a new tab.
- `npm run verify` passes.
