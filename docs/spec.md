# xlator Specification

Last updated: 2026-09-01
Status: Text-first Realtime connection MVP implemented; legacy translation-path benchmark completed; new browser path and physical-microphone verification pending

## 1. Purpose

Build a local web app that captures a conversation containing both Japanese and English through a shared microphone and displays every utterance in both languages.

"Local" means that the UI and server run on `localhost`. Speech recognition and translation require an internet connection to the OpenAI API; the app is not fully offline.

## 2. Product decisions

- Use TypeScript for both browser and server code. It is a better fit than Python for this MVP because WebRTC, React, event-driven APIs, and shared data types can all use one language.
- Use `gpt-live-transcribe` for the always-on browser speech-to-text path.
- Stream Japanese/English text translation through the Responses API, using `gpt-5.6-luna` by default.
- Use `gpt-realtime-translate` only when translated-audio playback is enabled.
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
- `リスニング中` (Listening): The transcription session is connected. If translated audio was enabled before startup, both target-language audio sessions are connected too.
- `接続エラー` (Connection error): API configuration, microphone access, WebRTC, or a Realtime event failed.
- A failed required transcription connection prevents startup. When translated audio is requested, a partial Japanese/English audio-session connection also prevents startup.
- Do not treat setting the SDP answer as a completed connection. Move to `リスニング中` only after the required peer connection, and any audio connections requested at startup, have `connectionState === "connected"`.
- Apply one 15-second timeout to the full startup sequence, including short-lived secret acquisition, WebRTC offer and SDP answer exchange, and peer connection establishment.
- Stopping while `接続中` must cancel the in-progress WebRTC connection and prevent a late connection from returning the UI to `リスニング中`.
- If a connected transcription or translated-audio session receives a Realtime API `error` event, stop the microphone, all WebRTC connections, text-translation work, VAD, and the finalization timer, then move to `接続エラー`.

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
  │    ├─ WebRTC transcription session: gpt-live-transcribe
  │    ├─ streaming text translation requests
  │    └─ optional WebRTC translated-audio sessions: target=en + target=ja
  ├─ useLocalVad
  │    └─ microphone capture + lightweight local voice activity detection
  └─ ConversationControls
       └─ transient control UI state and download actions
          │ short-lived client secrets + source text
Local Vinext server / TypeScript
  ├─ /api/realtime/transcription
  ├─ /api/realtime/session
  └─ /api/translate
          │ OPENAI_API_KEY
OpenAI APIs
  ├─ Realtime transcription: gpt-live-transcribe
  ├─ Responses text translation: gpt-5.6-luna by default
  └─ optional Realtime translated audio: gpt-realtime-translate
```

On the React side, limit `app/page.tsx` to screen composition. `useConversationSession` owns the transcription and optional translated-audio Realtime connections, streaming text-translation scheduling, aligned utterance state, and translated-audio control. `useLocalVad` owns the Web Audio API and RMS-based VAD lifecycle. `ConversationControls` owns transient UI-only state such as the download menu. Preserve these responsibility boundaries when adding features; do not move connection or VAD implementation back into the page component.

Always send the microphone track to one Realtime transcription WebRTC session. As source transcript deltas arrive, translate the accumulated source text through a streaming Responses API request and render each proxied text delta. Keep at most one text-translation request in flight per row; retain only the newest pending source snapshot, start successive requests at least 160 ms apart, and replace the displayed translation when the first delta for a newer snapshot arrives.

When translated audio is enabled, also send the same microphone track to two Realtime Translation WebRTC sessions in parallel: one targeting English audio and one targeting Japanese audio. Ignore their transcript output because the text columns use the independent text-first path. When translated audio is `off`, do not create either Translation session. Turning audio off during a live session closes both; turning it on connects both for subsequent microphone audio.

Use these browser-to-OpenAI endpoints:

- Transcription client secrets: `/v1/realtime/client_secrets`
- Transcription WebRTC calls: `/v1/realtime/calls`
- Client secrets: `/v1/realtime/translations/client_secrets`
- WebRTC calls: `/v1/realtime/translations/calls`

## 7. OpenAI API configuration and security

- Read the long-lived key only from the `OPENAI_API_KEY` environment variable.
- Store it in the gitignored `.env.local` file during local development.
- Keep the API key empty in `.env.example`; include only non-sensitive model and latency defaults.
- Return only short-lived Realtime client secrets from the local API to the browser. Proxy Responses text translation through the local server.
- Never store the API key in browser-exposed environment variables such as `NEXT_PUBLIC_*`.
- Configure the Realtime input transcription model through the server-side `OPENAI_TRANSCRIPTION_MODEL` environment variable.
- Use `gpt-live-transcribe` when `OPENAI_TRANSCRIPTION_MODEL` is unset or empty. Record the same default in `.env.example`.
- Configure transcription latency through `OPENAI_TRANSCRIPTION_DELAY`. Accept `minimal`, `low`, `medium`, `high`, or `xhigh`; use `minimal` when unset, empty, or invalid.
- Configure the text translation model through `OPENAI_TEXT_TRANSLATION_MODEL`; use `gpt-5.6-luna` when unset or empty.
- Use `far_field` input noise reduction.

`GET /api/realtime/session` returns only whether a key is configured; it never returns the key value. `POST /api/realtime/transcription` creates a ten-minute transcription secret configured for Japanese and English with low-latency deltas. `POST /api/realtime/session` accepts `ja` or `en` and creates a ten-minute translated-audio secret. `POST /api/translate` accepts source text and an opposite Japanese/English direction, calls the Responses API with `reasoning.effort: "none"`, and proxies only output-text deltas as a no-store plain-text stream.

After the key configuration check succeeds, the browser prefetches the transcription secret. It prefetches the Japanese-target and English-target translated-audio secrets only when audio playback is enabled. It reuses each secret in memory until five seconds before expiration. If prefetching fails or a secret expires, it fetches a replacement when the connection starts. Secrets are not stored in page storage or persisted.

## 8. Realtime event processing

### Source transcript

Consume `input_audio_buffer.speech_started` to associate the server's `item_id` with the draft row created by local VAD. Append each `conversation.item.input_audio_transcription.delta` from the dedicated transcription session to that row. Keep later delta and completion events associated through `item_id`. A `conversation.item.input_audio_transcription.completed` event replaces the accumulated source text with the final transcript so that model corrections and normalization are preserved. If the server speech-start event is unavailable, reuse a recent empty row for up to three seconds before creating another row.

Classify text containing Japanese characters as `ja`, text containing Latin characters as `en`, and unclassifiable text as `unknown`. After the source language is known, write the source transcript into that language's field and translate only the opposite field.

### Translation

Send accumulated source-text snapshots to `POST /api/translate`. The server streams Responses API `response.output_text.delta` content back as plain text, and the browser renders each chunk on the opposite-language side.

Start the first request for a row immediately. Keep no more than one request in flight per row and retain only the newest pending snapshot while one is running. A translation for an earlier source prefix may render while the source continues growing. The first delta for the next snapshot replaces that provisional translation, and later deltas append to it. This avoids aborting every request during frequent transcription deltas while still converging to the latest source text.

Do not use `session.output_transcript.delta` from optional translated-audio sessions for the text columns.

### Utterance boundaries and alignment

The current MVP combines lightweight local VAD through the Web Audio API with a fallback timer for transcription deltas.

- Create an empty aligned draft row immediately when local VAD detects speech start. This allows the first source and translation text to render without waiting for another event to establish a row.
- Infer active speech from the microphone's RMS level and a tracking noise floor.
- After speech is detected, finalize the current row after 320 ms of silence when the source candidate ends in sentence punctuation (`。.!！？?…`), or after 450 ms otherwise.
- Late input-transcript deltas alone do not reset the silence interval that began from local audio.
- If VAD does not detect the end of speech, finalize the row after 1.2 seconds without an input-transcript delta.
- Associate Realtime transcription speech-start, delta, and completion events with rows by `item_id`; if a quiet utterance produces a server event before local VAD starts a row, create the draft row from that first event.

This approach can combine a long utterance without silence into one row, misidentify boundaries for quiet speech or loud background noise, or treat a mid-sentence pause as an utterance boundary. Realtime `item_id` boundaries and local VAD boundaries can still disagree. VAD based on a high-accuracy audio classification model is not implemented.

## 9. Translated audio

The options are `再生しない` (Do not play), `日本語` (Japanese), `English`, and `自動` (Auto). The default is `再生しない`.

In the default `再生しない` mode, keep the runtime text-only: one `gpt-live-transcribe` Realtime connection plus streaming Responses text translation. Do not connect `gpt-realtime-translate`. When any playback mode is selected, connect both target-language `gpt-realtime-translate` sessions in parallel and use them only for translated audio.

Always play only the translation, which is the language opposite the source language.

- Japanese input may play only English audio.
- English input may play only Japanese audio.
- Do not play audio when an explicitly selected language matches the source language.
- `自動` plays the opposite language after source-language detection.
- Reset language detection to `unknown` at session start and whenever audio for the next utterance is detected. Mute both outputs until the source language is known.
- Changing to `再生しない` during a session closes both translated-audio connections. Changing from `再生しない` to a playback mode reconnects them for subsequent audio.

## 10. Downloads

Generate files in the browser from the current aligned records. Do not use server-side persistence or an export API. Use the filename `xlator-log.{format}`.

- TXT: Export the Japanese and English logs under separate headings.
- CSV: Export sequence number, time, source language, Japanese, and English.
- JSON: Export `Utterance[]`.
- SRT: For live data, use `startMs` from local speech detection and `endMs` from the local session time when the latest transcription delta or completion arrives, and include both languages in one subtitle. These are application timings, not exact word or physical-speech timestamps. For initial sample data, use synthetic timestamps at four-second intervals.

## 11. Latency strategy

- Stream browser audio directly over WebRTC.
- Prefetch the transcription client secret after confirming the API key configuration; prefetch translated-audio secrets only when playback is enabled.
- In text-only mode, create one transcription session and no Translation sessions.
- When playback is enabled, create both target-language audio sessions in parallel with the transcription session.
- Fetch each client secret and create its WebRTC offer in parallel.
- Create an empty draft row at local speech start and render transcription and Responses translation deltas immediately as they arrive.
- Use `gpt-live-transcribe` with `minimal` delay by default, and use `gpt-5.6-luna` with no reasoning as the default lightweight text translator.
- Serialize text-translation requests per row, retain the latest pending source snapshot, and impose a 160 ms minimum start interval.
- Finalize utterances after 320 ms of silence when terminal punctuation is present, or 450 ms otherwise, without letting late deltas rewind the silence timer.
- Do not rerender an unchanged source snapshot, and keep each Realtime `item_id` bound to one aligned row.
- Do not animate automatic scrolling.
- Client logic cannot eliminate model processing or network latency.
- Measure connection startup, first source transcript, first translation, and utterance finalization separately during evaluation.
- The existing live-API smoke CLI accepts `--repeat <count>` and reports nearest-rank p50 and p95 values for the first source delta, first Translation API output-transcript delta, and their difference. It benchmarks the legacy audio-translation path, not the new Responses text path.
- In the browser, measure local-VAD speech start to the first rendered source and translation text, plus silence start to the rendered final-row state.
- Store browser measurements without transcript content in `window.__xlatorLatency`, dispatch an `xlator:latency` event, and log the same structured record to the developer console.

## 12. Testing and quality evaluation

Normal CI runs `npm run verify` and requires linting, type checking, a production build, and behavioral tests that do not call the live API.

Use `npm run test:smoke:api` for legacy direct-Translation real-audio and live-API verification. The runner reads uncompressed 16-bit PCM WAV files, downmixes their channels, converts them to 24 kHz PCM16, and sends them to Realtime Translation over WebSocket in real time in 100 ms chunks. The new text-first browser path requires its separate physical-microphone and A/B checks described below.

- Compare `session.input_transcript.delta` with the reference transcript.
- Use CER for Japanese and Japanese/English mixed input, and WER for English.
- Evaluate `session.output_transcript.delta` using both its error rate against a representative translation and required-term coverage.
- Confirm that translated-audio deltas are not empty.
- Send `session.close` at the end of the audio and wait for `session.closed`.
- Report latency to the first source transcript, first translation, first translated audio, and session closure.
- Pass `--repeat 10` to run every selected direction ten times and print p50/p95 summaries.

Because of API cost, model variability, and external outages, the live-API smoke test is not a required normal pull request check. Run it through the manual `Realtime API Smoke` GitHub Actions workflow. Pass the API key only through the `OPENAI_API_KEY` Actions secret.

CI does not reproduce a physical microphone. Before a release, manually verify browser microphone permission, WebRTC connection, alternating Japanese/English utterances, translated audio, and stopping. `docs/realtime-smoke.md` is authoritative for the detailed procedure and fixture format.

### Current implementation and verification status

| Area | Implementation | Verification | Current treatment |
| --- | --- | --- | --- |
| Text-first browser path | Dedicated transcription secret and WebRTC connection, speech-start draft rows, serialized streaming Responses translation, and conditional translated-audio connections are implemented | Production build and automated route, SSE parsing, row-creation, and connection utility tests pass | Physical-microphone behavior and end-to-end latency are not verified |
| Text-first live API sanity | The server can create transcription and translated-audio client secrets, and both text directions stream through Responses | On 2026-09-01, both secret requests returned 200. One real-audio transcription run per direction succeeded with `minimal` delay and `languages: ["en", "ja"]`: Japanese first delta 3,186 ms and English 2,387 ms. After prompt tuning, one final text request per direction returned the first delta in 1,435 ms for Japanese-to-English and 889 ms for English-to-Japanese. | API components verified individually; browser WebRTC composition, partial-text scheduling, repeated-run percentiles, and A/B improvement are not verified |
| Normal CI | GitHub Actions runs `npm run verify` | Lint, type checking, build, and 34 tests pass on the current change branch | Required pull request quality gate |
| Live-API smoke CLI | WAV conversion, WebSocket streaming, CER/WER, translation terms, translated audio, repeated runs, p50/p95 summaries, latency comparison, and clean closure checks are implemented | On 2026-09-01, both registered cases ran ten times locally against the direct Realtime Translation path. All 20 runs returned source text, translation text, translated audio, and clean session closure. The command exited nonzero because some translation WER and required-term assertions failed. | Legacy-path benchmark only; it does not validate the new transcription-plus-Responses browser architecture |
| Real-audio fixture | Japanese-to-English and English-to-Japanese real-speech WAV files and reference data are registered | The local `--validate-only` check passes, and both files were processed successfully in ten live runs per direction | Human confirmation of the Japanese reference is pending because all ten live transcripts included `とても`, which is absent from the current reference; mixed-language, numbers, dates, times, and proper-noun coverage remains incomplete |
| Browser latency diagnostics | Speech-to-source-display, speech-to-translation-display, and silence-to-row-final measurements are implemented without storing transcript content | Pure timing calculations and the production build pass automated verification | New-path physical-microphone measurements and a legacy/new A/B comparison have not been collected |
| Manual GitHub Actions workflow | The `workflow_dispatch` `Realtime API Smoke` workflow is implemented | Normal CI passes after adding the workflow; a live GitHub Actions run has not been performed | API key registration and execution from the default branch remain incomplete |
| Physical microphone verification | Manual procedure is defined in `docs/realtime-smoke.md` | Not performed | Manual pre-release check, not automated CI |

### Remaining work and completion conditions

1. Expand the registered real-speech fixture coverage.
   - Basic Japanese-to-English and English-to-Japanese cases are registered and pass `--validate-only`.
   - Re-listen to the Japanese fixture and confirm whether `とても` belongs in the reference transcript before changing the source threshold.
   - Add utterance-by-utterance language switching, numbers, dates, times, and proper nouns.
2. Prepare the GitHub Actions environment for live-API execution.
   - Local live-API access succeeded on 2026-09-01 after loading the intended project key.
   - Add `OPENAI_API_KEY` as an Actions secret or in a protected environment.
   - After the workflow exists on the default branch, run `Realtime API Smoke` manually.
   - Preserve a successful result for input transcription, translation, translated audio, and `session.closed`.
3. Verify the browser MVP with a physical microphone.
   - Complete the six steps in `docs/realtime-smoke.md`.
   - In `再生しない`, verify that only transcription connects, the empty row appears at speech start, Responses translation streams into the opposite column, and no translated audio plays.
   - With playback enabled, verify both optional Translation sessions, alternating Japanese/English speech, row alignment, translated audio, live mode changes, and stopping both during and after connection.
4. Tune thresholds using the first measured results.
   - The legacy 2026-09-01 direct-Translation benchmark measured Japanese-to-English source p50/p95 at 3,904/4,920 ms, translation at 4,199/10,364 ms, and paired translation-minus-source at 294/6,207 ms. Translation was the median critical path and had the largest tail.
   - The same legacy benchmark measured English-to-Japanese source p50/p95 at 2,973/3,146 ms, translation at 2,619/3,852 ms, and paired translation-minus-source at -329/910 ms. Source transcription was the median critical path.
   - Add an equivalent benchmark for the new `gpt-live-transcribe` plus Responses text path and compare first visible source/translation p50 and p95 before claiming a latency improvement.
   - The current 0.35 source and 0.65 translation thresholds accepted all source runs and all English-to-Japanese translation error-rate checks, but Japanese-to-English WER passed only 5 of 10 runs. Required-term coverage passed 0 of 10 Japanese-to-English runs and 5 of 10 English-to-Japanese runs because valid paraphrases are not fully represented.
   - Human-confirm the source references and expand acceptable semantic variants before changing thresholds or model settings.
   - Do not further change local VAD thresholds or transcription-model settings until the new-path live benchmark and physical-microphone measurements are available.

Until items 1 through 3 succeed, describe the legacy live-API smoke test as completed with evaluation failures, and the new text-first browser path as "implemented but field verification pending."

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
2. Improve alignment between local VAD boundaries and Realtime transcription `item_id` boundaries.
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
app/hooks/use-conversation-session.ts    Transcription, text translation, utterance state, and optional audio control
app/hooks/use-local-vad.ts               Local VAD using the Web Audio API
app/globals.css                          Layout and styles
app/api/realtime/transcription/route.ts  Short-lived transcription secret issuance
app/api/realtime/session/route.ts        Optional translated-audio secret issuance
app/api/translate/route.ts               Streaming Responses text-translation proxy
lib/demo-utterances.ts                   Initial-screen fixture
lib/download-log.ts                      TXT / CSV / JSON / SRT generation
lib/browser-latency.ts                   Browser latency measurement records
lib/local-vad.ts                         Pure VAD silence-duration logic
lib/realtime-transcription.ts            Realtime transcription WebRTC connection
lib/realtime-translation.ts              Optional translated-audio WebRTC connection
lib/text-translation.ts                  Responses request and SSE delta handling
lib/text-translation-client.ts           Browser text-translation stream reader
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
- Starting a conversation in `再生しない` connects one transcription Realtime session after microphone permission is granted and does not connect Realtime Translation.
- Starting with translated audio enabled connects the transcription session and both target-language audio sessions.
- Prefetched short-lived client secrets are reused at connection start if they have not expired.
- Local speech start creates an empty aligned draft row before transcript text arrives.
- Alternating Japanese and English speech produces both languages under the same sequence number.
- When local VAD detects silence after speech, rows finalize after approximately 320 ms with terminal punctuation or 450 ms otherwise.
- Realtime transcription deltas and completions stay associated with their row through `item_id`.
- Responses text deltas render only on the side opposite the detected source language.
- Translated audio plays only in the language opposite the source language.
- TXT, CSV, JSON, and SRT files can be downloaded.
- Real-audio fixtures can be validated for structure and WAV conversion without an API connection.
- Repeated live-API runs report p50/p95 first-delta latency summaries.
- Browser latency records contain timing metadata without transcript content.
- The live-API smoke test can be started from the manual workflow.
- The API key does not appear in browser HTML, JavaScript, or downloads.
- The GitHub icon in the header opens this repository in a new tab.
- `npm run verify` passes.
