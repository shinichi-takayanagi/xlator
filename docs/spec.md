# xlator Specification

Last updated: 2026-09-06
Status: Dual Realtime path with acoustic turn finalization, bounded stop draining, and timestamp-first translation routing implemented; automated verification completed; browser and translated-audio field verification pending

## 1. Purpose

Build a local web app that captures a conversation containing both Japanese and English through a shared microphone and displays every utterance in both languages.

"Local" means that the UI and server run on `localhost`. Speech recognition and translation require an internet connection to the OpenAI API; the app is not fully offline.

## 2. Product decisions

- Use TypeScript for both browser and server code. It is a better fit than Python for this MVP because WebRTC, React, event-driven APIs, and shared data types can all use one language.
- Use `gpt-live-transcribe` for the always-on browser speech-to-text path.
- Use `gpt-realtime-translate` for streaming translated text and translated audio.
- Keep both Japanese-target and English-target Translation sessions connected so the source language can alternate on every utterance.
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
- Display unfinished rows with reduced emphasis. A live row stays draft until its acoustic turn has ended and its source transcript has completed; this does not imply that the independent streaming translation is complete.
- Allow each panel to scroll internally and independently.
- Scroll immediately to the latest position, without animation, when a new utterance or text delta arrives.
- Show 16 sample utterances on the initial screen for UI verification.
- Clear the sample data and switch to live rows when a conversation starts.
- Keep captured live rows visible after the conversation stops. Stop the microphone, local VAD, and translated audio playback immediately, then accept final source and translated text for up to five seconds. The controls return to idle during this bounded drain. Starting again cancels the previous drain and starts a new log.
- Restore the sample data after a page reload.

### Connection status

- `待機中` (Idle): Before starting or after stopping.
- `APIキー未設定` (API key not configured): `OPENAI_API_KEY` was not found during the startup configuration check.
- `接続中` (Connecting): The microphone is available and the Realtime sessions are being established.
- `リスニング中` (Listening): The transcription session and both target-language Translation sessions are connected.
- `接続エラー` (Connection error): API configuration, microphone access, WebRTC, or a Realtime event failed.
- A failed transcription connection or either target-language Translation connection prevents startup.
- Do not treat setting the SDP answer as a completed connection. Move to `リスニング中` only after all three peer connections have `connectionState === "connected"` and their Realtime data channels are open.
- Apply one shared 15-second timeout to the full startup sequence, including microphone acquisition, short-lived secret acquisition, WebRTC offer and SDP answer exchange, peer connection establishment, and data-channel opening.
- Stopping while `接続中` must cancel the in-progress WebRTC connection and prevent a late connection from returning the UI to `リスニング中`.
- If a connected transcription or Translation session receives a Realtime API `error` event, or the transcription session receives `conversation.item.input_audio_transcription.failed`, stop the microphone, all WebRTC connections, VAD, and the finalization timer, then move to `接続エラー`.

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
  speechEndMs?: number;
  sourceStatus?: "pending" | "streaming" | "completed";
  status?: "draft" | "final";
  ja: string;
  en: string;
};
```

Initial sample data contains only display-time strings and translated text. Live data also contains `sourceText`, millisecond timestamps, and status. `speechEndMs` records the local acoustic silence-start time when available, or the local stop/end time; `endMs` continues to track source-text event arrival. `sourceStatus` distinguishes pending/partial source text from the completed source transcript. The legacy `status` becomes final only after both speech end and source completion; there is no per-utterance Translation completion event.

## 6. System architecture

```text
Browser / React / TypeScript
  ├─ app/page.tsx: screen composition only
  ├─ useConversationSession
  │    ├─ aligned utterance state
  │    ├─ WebRTC transcription session: gpt-live-transcribe
  │    └─ WebRTC Translation sessions: target=en + target=ja
  ├─ useLocalVad
  │    └─ microphone capture + lightweight local voice activity detection
  └─ ConversationControls
       └─ transient control UI state and download actions
          │ short-lived client secrets
Local Vinext server / TypeScript
  ├─ /api/realtime/transcription
  └─ /api/realtime/session
          │ OPENAI_API_KEY
OpenAI APIs
  ├─ Realtime transcription: gpt-live-transcribe
  └─ Realtime translated text and audio: gpt-realtime-translate
```

On the React side, limit `app/page.tsx` to screen composition. `useConversationSession` owns the transcription and Translation Realtime connections, aligned utterance state, and translated-audio control. `useLocalVad` owns the Web Audio API and RMS-based VAD lifecycle. `ConversationControls` owns transient UI-only state such as the download menu. Preserve these responsibility boundaries when adding features; do not move connection or VAD implementation back into the page component.

Always send the microphone track to one Realtime transcription WebRTC session and two Realtime Translation WebRTC sessions in parallel. The transcription session supplies the source transcript. The English-target and Japanese-target Translation sessions supply translated transcript deltas and translated audio.

Use source-language detection from the transcription session to select only the opposite Translation session for display and playback. Keep output-transcript candidates buffered by row and target language until the source language is known. The audio control only mutes or unmutes the already-connected Translation audio tracks; it does not create or close Translation sessions.

Use these browser-to-OpenAI endpoints:

- Transcription client secrets: `/v1/realtime/client_secrets`
- Transcription WebRTC calls: `/v1/realtime/calls`
- Client secrets: `/v1/realtime/translations/client_secrets`
- WebRTC calls: `/v1/realtime/translations/calls`

## 7. OpenAI API configuration and security

- Read the long-lived key only from the `OPENAI_API_KEY` environment variable.
- Store it in the gitignored `.env.local` file during local development.
- Keep the API key empty in `.env.example`; include only non-sensitive model and latency defaults.
- Return only short-lived Realtime client secrets from the local API to the browser.
- Never store the API key in browser-exposed environment variables such as `NEXT_PUBLIC_*`.
- Configure the Realtime input transcription model through the server-side `OPENAI_TRANSCRIPTION_MODEL` environment variable.
- Use `gpt-live-transcribe` when `OPENAI_TRANSCRIPTION_MODEL` is unset or empty. Record the same default in `.env.example`.
- Configure transcription latency through `OPENAI_TRANSCRIPTION_DELAY`. Accept `minimal`, `low`, `medium`, `high`, or `xhigh`; use `minimal` when unset, empty, or invalid.
- Optionally configure transcription recording context with `OPENAI_TRANSCRIPTION_PROMPT` and literal term hints with `OPENAI_TRANSCRIPTION_KEYWORDS`, a JSON array of non-empty strings. Trim the prompt and keyword whitespace, deduplicate keywords, and omit blank context or an empty keyword list. Reject malformed JSON, non-string or blank keywords, and keywords containing `<`, `>`, CR, or LF with a local 503 `invalid_transcription_context` response before requesting a secret. Upstream model limits still apply to context. Both settings default to absent and do not change the existing model, language hints, delay, or noise reduction.
- Context settings are configured on the server and sent to OpenAI; they are not secret data and may appear in upstream session metadata. Restart the server and reload the browser after changing hints to replace prefetched secrets. Hints are not mandatory output and do not configure the independent audio Translation sessions or implement a translation dictionary.
- Use `far_field` input noise reduction.

`GET /api/realtime/session` returns only whether a non-empty key is configured; it never returns the key value. `POST /api/realtime/transcription` creates a ten-minute transcription secret configured for Japanese and English with low-latency deltas. `POST /api/realtime/session` accepts `ja` or `en` and creates a ten-minute Translation secret for `gpt-realtime-translate`. Successful secret routes return only `value` and `expires_at`; they do not forward the effective upstream session object.

After the key configuration check succeeds, the browser prefetches the transcription secret and both target-language Translation secrets. It reuses each secret in memory until five seconds before expiration. If prefetching fails or a secret expires, it fetches a replacement when the connection starts. Secrets are not stored in page storage or persisted.

## 8. Realtime event processing

### Source transcript

Configure the transcription session with automatic turn detection disabled. After all required connections are ready, clear audio accumulated during startup and begin local VAD. Local VAD creates one draft row and commits the input audio buffer after the configured silence interval. Bind each `input_audio_buffer.committed` event's server `item_id` to the oldest unbound local row, then keep later delta and completion events associated through `item_id`. Append each `conversation.item.input_audio_transcription.delta` from the dedicated transcription session to that row. A new `item_id` never reuses a row already bound to another item. A `conversation.item.input_audio_transcription.completed` event replaces the accumulated source text with the final transcript so that model corrections and normalization are preserved. If local VAD misses speech, the first transcription delta creates and binds the row.

Classify text containing Japanese characters as `ja`, text containing Latin characters as `en`, and unclassifiable text as `unknown`. After the source language is known, write the source transcript into that language's field and translate only the opposite field.

### Translation

Consume `session.output_transcript.delta` from both target-language Translation sessions. Append each delta without inserting spaces. Select an existing row using `elapsed_ms` plus the local Translation-connection clock offset before considering the active row. A delayed event whose timestamp belongs to an earlier turn stays on that turn even while another row is active. Do not look ahead across an existing next-turn boundary. Allow a 200 ms tolerance before the first row's start for coarse timestamps. Reject timing more than three seconds after an inactive row's acoustic end (or its available end/start fallback). Translation events never create rows.

For missing timestamps, continue the most recent assignment for that target session for up to three seconds; untimed continuation does not extend that anchor's lifetime. Without an anchor, assign only when receipt time leaves exactly one recent eligible row. Buffer unresolved deltas individually, retaining their original timestamps and monotonic receipt times. Reconcile on row creation and each subsequent translation event; expire each fragment after three seconds without refreshing older text when a newer delta arrives. Bound unresolved storage to 256 fragments and 65,536 characters, evicting oldest fragments first. A newly created row must start within 200 ms of a pending fragment's timestamp (or receipt time when untimed); untimed fragments can use only the first subsequent row. Clear pending fragments and anchors on session reset.

This is best-effort alignment: Translation `elapsed_ms` is coarse timing, not a shared transcription `item_id` or an exact input-speech boundary. A timestamp already in the next turn's interval can still select that turn; untimed continuation can remain on an older anchor. Ambiguous or unmatched fragments expire rather than being indiscriminately appended to the active row. In particular, a late source-created row after missed local VAD can fall outside the pre-row tolerance. Physical-microphone verification of these cases remains pending.

Keep one accumulated candidate per row and target language. If the source language is not known yet, buffer both candidates. Once the dedicated transcription session identifies the source language, render only the candidate in the opposite language. Continue appending later deltas from that target session and ignore the same-language target for display. The source-language field always comes from `gpt-live-transcribe`, never from a Translation session.

### Stop draining

For a live session, stop microphone tracks, VAD, timers, and translated playback immediately; commit any active captured utterance even if its source text has not arrived. Send `session.close` to both Translation data channels, continue consuming their transcript events until `session.closed`, and wait for pending source completions. Close all connections after these conditions or one shared five-second deadline, preserving populated rows and removing empty ones. A deadline does not claim that partial source text or translated output is complete. Repeated stop calls are idempotent. A new start, startup cancellation, an error, or unmount aborts old resources immediately; old events and drain callbacks cannot modify or close the new session. WebRTC drain behavior is covered with mocked transports and requires live-browser confirmation.

### Utterance boundaries and alignment

The current MVP uses debounced local VAD to commit Realtime transcription turns, then uses the returned `item_id` as the authority for later events within each turn. A silence watchdog covers a missed VAD end callback; source completion is tracked separately.

- Require 120 ms of sustained audio above the adaptive RMS threshold before confirming local speech and creating an empty aligned draft row.
- Infer local speech timing from the microphone's RMS level and a tracking noise floor.
- Commit the transcription input buffer and end the acoustic turn after 320 ms of silence when the source candidate ends in sentence punctuation (`。.!！？?…`), or after 450 ms otherwise. Source completion may arrive later and updates its original row; it never ends a different active turn.
- Arm a 1.2-second watchdog only when local acoustic silence begins and cancel it when speech resumes. It covers a missed VAD end callback while silence persists. Neither speech start nor transcript arrival arms or restarts it, so text-processing delay cannot force a commit during continuous speech. For a source-created row that VAD missed, mark the VAD tracker as having detected a turn so subsequent acoustic samples can detect silence; a late delta for an ended row does not reactivate speech.
- A five-second cleanup removes only abandoned empty rows. Keep active speech and rows with committed/bound audio while source transcription is pending, even beyond five seconds. Remove ended empty rows on an empty source completion, and retain discarded item IDs until session reset so duplicates cannot attach to the next row. On normal stop, retain pending rows during the five-second drain and remove remaining empty rows when it ends. Errors remove empty rows immediately.
- Associate every Realtime transcription delta and completion event with its committed local row by `item_id`; a distinct item never shares a bound row.

This prevents Translation timing from creating rows and keeps successive locally committed transcription turns separate. A committed row whose source completion never arrives stays pending until stop or error cleanup. Local VAD can still misidentify boundaries for quiet speech, loud background noise, or a mid-sentence pause. VAD based on a high-accuracy audio classification model is not implemented.

## 9. Translated audio

The options are `再生しない` (Do not play), `日本語` (Japanese), `English`, and `自動` (Auto). The default is `再生しない`.

Always connect one `gpt-live-transcribe` session and both target-language `gpt-realtime-translate` sessions. In the default `再生しない` mode, keep both remote audio elements muted while continuing to consume translated transcript deltas. Selecting a playback mode unmutes only the matching opposite-language translated audio.

Always play only the translation, which is the language opposite the source language.

- Japanese input may play only English audio.
- English input may play only Japanese audio.
- Do not play audio when an explicitly selected language matches the source language.
- `自動` plays the opposite language after source-language detection.
- Reset language detection to `unknown` at session start and whenever audio for the next utterance is detected. Mute both outputs until the source language is known.
- Changing the playback mode during a session only updates which translated audio element is muted. It does not reconnect the Translation sessions.

## 10. Downloads

Generate files in the browser from the current aligned records. Do not use server-side persistence or an export API. Use the filename `xlator-log.{format}`.

- TXT: Export the Japanese and English logs under separate headings.
- CSV: Export sequence number, time, source language, Japanese, and English.
- JSON: Export `Utterance[]`.
- SRT: For live data, use `startMs` from local speech detection and `endMs` from the local session time when the latest transcription delta or completion arrives, and include both languages in one subtitle. These are application timings, not exact word or physical-speech timestamps. For initial sample data, use synthetic timestamps at four-second intervals.

## 11. Latency strategy

- Stream browser audio directly over WebRTC.
- Prefetch the transcription client secret and both Translation client secrets after confirming the API key configuration.
- Create the transcription session and both target-language Translation sessions in parallel.
- Fetch each client secret and create its WebRTC offer in parallel.
- Create an empty draft row after 120 ms of sustained local speech and render transcription plus opposite-language Translation transcript deltas as soon as the source language is known.
- Use `gpt-live-transcribe` with `minimal` delay by default and `gpt-realtime-translate` for translated text and audio.
- Commit local turns at the 320/450 ms silence boundary, with a 1.2-second acoustic-silence watchdog. Finalize displayed source state only once the corresponding source completion arrives.
- Do not rerender an unchanged source snapshot, and keep each Realtime `item_id` bound to one aligned row.
- Do not animate automatic scrolling.
- Client logic cannot eliminate model processing or network latency.
- Measure connection startup, first source transcript, first translation, and utterance finalization separately during evaluation.
- The live-API smoke CLI accepts `--repeat <count>` and reports nearest-rank p50 and p95 values for the first Translation-session source delta, first output-transcript delta, and their difference.
- In the browser, measure local-VAD speech start to the first rendered source and translation text, plus silence start to the rendered final-row state.
- Store browser measurements without transcript content in `window.__xlatorLatency`, dispatch an `xlator:latency` event, and log the same structured record to the developer console.

## 12. Testing and quality evaluation

Normal CI runs `npm run verify` and requires linting, type checking, a production build, and behavioral tests that do not call the live API.

Use `npm run test:smoke:api` for direct Realtime Translation real-audio and live-API verification. The runner reads uncompressed 16-bit PCM WAV files, downmixes their channels, converts them to 24 kHz PCM16, and sends them to Realtime Translation over WebSocket in real time in 100 ms chunks. The browser's combined transcription-plus-Translation composition still requires the separate physical-microphone checks described below.

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
| Dual Realtime browser path | Dedicated `gpt-live-transcribe` source transcription plus English-target and Japanese-target `gpt-realtime-translate` text/audio sessions are implemented; locally committed rows, commit-event `item_id` binding, target-language candidate buffering, timestamp-first translation selection with bounded per-fragment buffering and target-specific untimed anchors, one full-startup deadline, and late-resource cleanup preserve alignment and lifecycle safety | Production build and automated route, item-binding, row-selection, candidate-buffering, delayed and untimed translation routing, per-fragment expiry, mounted-hook late-output and pre-source candidate integration, alignment, startup-cancellation, data-channel, and connection utility tests pass. On 2026-09-02, the earlier implementation received the registered Japanese fixture followed by the English fixture through the microphone with aligned rows and empty-row cleanup. The lifecycle and commit-binding fixes from the implementation-to-spec audit have not yet been repeated with a physical microphone. | Automated verification passes; post-audit browser text, translated-audio playback, natural alternating conversation, and representative latency field verification remain pending |
| Live API sanity | The server can create transcription and Translation client secrets | On 2026-09-01, both secret request types returned 200. One real-audio transcription run per direction succeeded with `minimal` delay and `languages: ["en", "ja"]`: Japanese first delta 3,186 ms and English 2,387 ms. | API components verified individually; the post-audit three-session browser composition still needs field re-verification |
| Optional transcription context | Recording context and normalized keyword hints can be configured through server environment variables | Mocked route tests cover hint propagation, omission, validation, and response filtering; live-API context behavior and vocabulary accuracy improvements are not verified | Keep defaults unchanged; evaluate representative domain audio with and without hints before claiming accuracy gains |
| Acoustic lifecycle and stop drain | Acoustic-only watchdog, separate source completion, pending-row retention, discarded-item isolation, and bounded stop drain are implemented | Mounted React-hook tests with mocked VAD/transports and controlled clocks cover continuous speech, resumed speech, late correction, quiet-speech recovery, stop-before-source, stop/restart, errors, and mute behavior; transport tests cover drain completion, deadline, and cancellation | Physical microphone/WebRTC timing and final-output delivery remain unverified |
| Normal CI | GitHub Actions runs `npm run verify` | On 2026-09-06, lint, type checking, the production build, and 67 tests passed locally after adding acoustic lifecycle, stop-drain, and translation-alignment regression coverage. On 2026-09-05, `npm audit` reported no known vulnerabilities after the runtime and build-tool maintenance update | Required pull request quality gate |
| Live-API smoke CLI | WAV conversion, WebSocket streaming, CER/WER, translation terms, translated audio, repeated runs, p50/p95 summaries, latency comparison, and clean closure checks are implemented | On 2026-09-01, both registered cases ran ten times locally. On 2026-09-02, one regression run per direction again returned source text, translation text, translated audio, and clean session closure. The command exited nonzero on translation error-rate and required-term assertions; the English-to-Japanese output omitted the required greeting. | Covers the same Translation model and output events as the browser, but uses the Translation session's optional input transcript instead of the browser's dedicated transcription session |
| Real-audio fixture | Japanese-to-English and English-to-Japanese real-speech WAV files and reference data are registered | The local `--validate-only` check passes, and both files were processed successfully in ten live runs per direction | Human confirmation of the Japanese reference is pending because all ten live transcripts included `とても`, which is absent from the current reference; mixed-language, numbers, dates, times, and proper-noun coverage remains incomplete |
| Browser latency diagnostics | Speech-to-source-display, speech-to-translation-display, and silence-to-row-final measurements are implemented without storing transcript content | Pure timing calculations and the production build pass automated verification | Dual Realtime physical-microphone measurements have not been collected |
| Manual GitHub Actions workflow | The `workflow_dispatch` `Realtime API Smoke` workflow is implemented | Normal CI passes after adding the workflow; a live GitHub Actions run has not been performed | API key registration and execution from the default branch remain incomplete |
| Physical microphone verification | Manual procedure is defined in `docs/realtime-smoke.md` | On 2026-09-02, speaker playback of the two basic fixtures through the earlier browser implementation verified muted-mode text alignment and stopping; natural speech and translated-audio playback were not tested, and the audited connection/item-binding changes have not received a new physical-microphone run | Manual pre-release check, not automated CI |

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
   - The 2026-09-02 fixture-playback run verified that transcription and both Translation sessions connect in `再生しない`, opposite-language text stays aligned across Japanese then English input, transient empty rows are removed, and stopping preserves only populated rows.
   - Repeat the muted-mode check with natural speech and at least three alternating utterances.
   - Re-run the basic fixtures against the audited shared-startup timeout, startup-buffer clearing, data-channel readiness, and `input_audio_buffer.committed` item binding. Verify continuous speech longer than five seconds without transcript output, source corrections after silence, and stopping before the first source delta; confirm pending final text drains while microphone and playback stay stopped.
   - Verify delayed translation while the next same-language or opposite-language turn is active, missing timestamps, source language initially unknown, and missed-VAD fallback rows. Confirm usable opposite-side text without stale fragments crossing turns; record omissions or coarse-timing misalignment before changing routing tolerances.
   - With playback enabled, verify alternating Japanese/English speech, one row per transcription `item_id`, no persistent empty rows, opposite-language translated audio, live mute-mode changes without reconnection, and stopping both during and after connection.
4. Tune thresholds using the first measured results.
   - The 2026-09-01 direct-Translation benchmark measured Japanese-to-English source p50/p95 at 3,904/4,920 ms, translation at 4,199/10,364 ms, and paired translation-minus-source at 294/6,207 ms. Translation was the median critical path and had the largest tail.
   - The same benchmark measured English-to-Japanese source p50/p95 at 2,973/3,146 ms, translation at 2,619/3,852 ms, and paired translation-minus-source at -329/910 ms. Source transcription was the median critical path.
   - Add a browser-composed benchmark for the dedicated `gpt-live-transcribe` source path plus `gpt-realtime-translate` output path before claiming a latency improvement.
   - The current 0.35 source and 0.65 translation thresholds accepted all source runs and all English-to-Japanese translation error-rate checks, but Japanese-to-English WER passed only 5 of 10 runs. Required-term coverage passed 0 of 10 Japanese-to-English runs and 5 of 10 English-to-Japanese runs because valid paraphrases are not fully represented.
   - Human-confirm the source references and expand acceptable semantic variants before changing thresholds or model settings.
   - Do not further change local VAD thresholds or transcription-model settings until the dual Realtime browser benchmark and physical-microphone measurements are available.
   - Optional transcription context is implemented with unchanged defaults. Compare representative terms with and without hints, recording CER/WER, critical-term coverage, and first-source latency; context effectiveness remains unverified.

Until items 1 through 3 succeed, describe the direct Translation live-API smoke test as completed with evaluation failures, and the dual Realtime browser path as "implemented but field verification pending."

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
2. Add an automated browser media-stream regression test for local commits and Realtime `item_id` alignment.
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
app/hooks/use-conversation-session.ts    Transcription, Realtime translation, utterance state, and audio control
app/hooks/use-local-vad.ts               Local VAD using the Web Audio API
app/globals.css                          Layout and styles
app/api/realtime/transcription/route.ts  Short-lived transcription secret issuance
app/api/realtime/session/route.ts        Short-lived Translation secret issuance
lib/demo-utterances.ts                   Initial-screen fixture
lib/download-log.ts                      TXT / CSV / JSON / SRT generation
lib/browser-latency.ts                   Browser latency measurement records
lib/local-vad.ts                         Pure VAD silence-duration logic
lib/realtime-client-secret.ts            Validated short-lived secret responses
lib/realtime-connection.ts               Shared startup cancellation, deadline, and connection-readiness utilities
lib/realtime-transcription.ts            Realtime transcription WebRTC connection
lib/realtime-translation.ts              Realtime translated text/audio WebRTC connection
lib/translation-types.ts                 Shared data types
lib/utterance-alignment.ts               Language detection and utterance alignment
lib/translation-fragments.ts             Timestamp-first translation routing and bounded pending fragments
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
- Starting a conversation connects one transcription Realtime session and both target-language Translation sessions after microphone permission is granted.
- `再生しない` keeps both translated audio outputs muted without disconnecting Translation text.
- Prefetched short-lived client secrets are reused at connection start if they have not expired.
- Sustained local speech creates one empty aligned draft row before transcript text arrives; Translation events do not create rows.
- Alternating Japanese and English speech produces both languages under the same sequence number.
- Local VAD commits one transcription turn at each confirmed silence boundary and displayed source state becomes final only after source completion.
- Realtime transcription deltas and completions stay associated with their row through `item_id`, and distinct item IDs never share a row.
- Continuous speech and pending committed rows survive empty-row cleanup. Ended empty completed rows disappear; normal stop drains pending text for up to five seconds, and failure removes empty rows immediately.
- Realtime Translation output-transcript deltas render only on the side opposite the detected source language.
- Translated audio plays only in the language opposite the source language.
- TXT, CSV, JSON, and SRT files can be downloaded.
- Real-audio fixtures can be validated for structure and WAV conversion without an API connection.
- Repeated live-API runs report p50/p95 first-delta latency summaries.
- Browser latency records contain timing metadata without transcript content.
- The live-API smoke test can be started from the manual workflow.
- The API key does not appear in browser HTML, JavaScript, or downloads.
- The GitHub icon in the header opens this repository in a new tab.
- `npm run verify` passes.
