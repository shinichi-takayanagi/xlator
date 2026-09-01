"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalVad } from "@/app/hooks/use-local-vad";
import {
  recordBrowserLatency,
  resetBrowserLatencyMeasurements,
} from "@/lib/browser-latency";
import { DEMO_UTTERANCES } from "@/lib/demo-utterances";
import {
  connectTranscription,
  prefetchTranscriptionClientSecret,
  type TranscriptionConnection,
  type TranscriptionEvent,
} from "@/lib/realtime-transcription";
import {
  connectTranslation,
  prefetchTranslationClientSecrets,
  type TranslationConnection,
  type TranslationEvent,
} from "@/lib/realtime-translation";
import { streamTextTranslation } from "@/lib/text-translation-client";
import type { Language, TargetLanguage, Utterance } from "@/lib/translation-types";
import {
  createLiveUtterance,
  detectLanguage,
  replaceRow,
} from "@/lib/utterance-alignment";

export type AudioMode = "off" | "ja" | "en" | "auto";
export type ConnectionStatus = "idle" | "connecting" | "live" | "error";

const FALLBACK_FINALIZE_MS = 1_200;
const TEXT_TRANSLATION_MIN_INTERVAL_MS = 160;
const RECENT_EMPTY_ROW_REUSE_MS = 3_000;

type TextTranslationJob = {
  controller: AbortController | null;
  timer: number | null;
  running: boolean;
  lastStartedAt: number;
  pending: {
    sourceText: string;
    sourceLanguage: Language;
    targetLanguage: Language;
  } | null;
};

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useConversationSession() {
  const [isListening, setIsListening] = useState(false);
  const [rows, setRows] = useState<Utterance[]>(DEMO_UTTERANCES);
  const [elapsed, setElapsed] = useState(91);
  const [audioMode, setAudioMode] = useState<AudioMode>("off");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const transcriptionConnectionRef = useRef<TranscriptionConnection | null>(null);
  const translationConnectionsRef = useRef<TranslationConnection[]>([]);
  const audioConnectionPromiseRef = useRef<Promise<void> | null>(null);
  const audioConnectionAbortControllerRef = useRef<AbortController | null>(null);
  const startAbortControllerRef = useRef<AbortController | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const rowsRef = useRef(rows);
  const isListeningRef = useRef(false);
  const activeRowIdRef = useRef<string | null>(null);
  const activeRowSequenceRef = useRef<number | null>(null);
  const transcriptionItemRowsRef = useRef(new Map<string, string>());
  const finalizeTimerRef = useRef<number | null>(null);
  const activeSourceTextRef = useRef("");
  const sessionStartedAtRef = useRef(0);
  const lastSourceLanguageRef = useRef<Language | "unknown">("unknown");
  const audioModeRef = useRef<AudioMode>("off");
  const speechStartedAtRef = useRef<number | null>(null);
  const speechStartedAtByRowRef = useRef(new Map<string, number>());
  const silenceStartedAtRef = useRef<number | null>(null);
  const sourceDisplayMeasuredRowsRef = useRef(new Set<string>());
  const translationDisplayMeasuredRowsRef = useRef(new Set<string>());
  const pendingFinalizationLatencyRef = useRef<{
    sequence: number;
    startedAt: number;
  } | null>(null);
  const textTranslationJobsRef = useRef(new Map<string, TextTranslationJob>());
  const lastTranslatedInputRef = useRef(new Map<string, string>());

  useEffect(() => {
    rowsRef.current = rows;
    for (const row of rows) {
      const speechStartedAt = speechStartedAtByRowRef.current.get(row.id);
      if (speechStartedAt === undefined) continue;
      if (row.sourceText && !sourceDisplayMeasuredRowsRef.current.has(row.id)) {
        recordBrowserLatency(
          row.sequence,
          "speech-to-source-display",
          speechStartedAt,
        );
        sourceDisplayMeasuredRowsRef.current.add(row.id);
      }
      if (
        row.sourceLanguage !== "unknown" &&
        !translationDisplayMeasuredRowsRef.current.has(row.id)
      ) {
        const targetLanguage = row.sourceLanguage === "ja" ? "en" : "ja";
        if (row[targetLanguage].trim()) {
          recordBrowserLatency(
            row.sequence,
            "speech-to-translation-display",
            speechStartedAt,
          );
          translationDisplayMeasuredRowsRef.current.add(row.id);
        }
      }
    }

    const pendingFinalization = pendingFinalizationLatencyRef.current;
    if (
      pendingFinalization &&
      rows.some((row) => (
        row.sequence === pendingFinalization.sequence && row.status === "final"
      ))
    ) {
      recordBrowserLatency(
        pendingFinalization.sequence,
        "silence-to-row-final",
        pendingFinalization.startedAt,
      );
      pendingFinalizationLatencyRef.current = null;
    }
  }, [rows]);

  useEffect(() => {
    isListeningRef.current = isListening;
    if (!isListening) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [isListening]);

  useEffect(() => {
    fetch("/api/realtime/session")
      .then((response) => response.json())
      .then((payload: { configured?: boolean }) => setApiConfigured(Boolean(payload.configured)))
      .catch(() => setApiConfigured(false));
  }, []);

  useEffect(() => {
    if (apiConfigured !== true) return;
    void prefetchTranscriptionClientSecret().catch(() => undefined);
    if (audioMode !== "off") {
      void prefetchTranslationClientSecrets().catch(() => undefined);
    }
  }, [apiConfigured, audioMode]);

  const syncAudioOutputs = useCallback(() => {
    const mode = audioModeRef.current;
    const sourceLanguage = lastSourceLanguageRef.current;

    for (const connection of translationConnectionsRef.current) {
      const outputIsTranslation = (
        (sourceLanguage === "ja" && connection.targetLanguage === "en") ||
        (sourceLanguage === "en" && connection.targetLanguage === "ja")
      );
      const languageMatches = mode === "auto" || mode === connection.targetLanguage;
      const shouldPlay = outputIsTranslation && languageMatches;
      connection.audio.muted = !shouldPlay;
      if (shouldPlay) void connection.audio.play().catch(() => undefined);
    }
  }, []);

  const beginSpeechMeasurement = useCallback((at: number) => {
    speechStartedAtRef.current = at;
    silenceStartedAtRef.current = null;
  }, []);

  const ensureActiveRow = useCallback((elapsedMs: number) => {
    if (activeRowIdRef.current) {
      const speechStartedAt = speechStartedAtRef.current;
      if (speechStartedAt !== null) {
        speechStartedAtByRowRef.current.set(activeRowIdRef.current, speechStartedAt);
      }
      return activeRowIdRef.current;
    }
    const sequence = (rowsRef.current.at(-1)?.sequence ?? 0) + 1;
    const row = createLiveUtterance(
      sequence,
      elapsedMs,
      `live-${sessionStartedAtRef.current}-${sequence}`,
    );
    activeRowIdRef.current = row.id;
    activeRowSequenceRef.current = row.sequence;
    const speechStartedAt = speechStartedAtRef.current;
    if (speechStartedAt !== null) {
      speechStartedAtByRowRef.current.set(row.id, speechStartedAt);
    }
    rowsRef.current = [...rowsRef.current, row];
    setRows((current) => (
      current.some((candidate) => candidate.id === row.id)
        ? current
        : [...current, row]
    ));
    return row.id;
  }, []);

  const finalizeCurrentRow = useCallback(() => {
    const activeId = activeRowIdRef.current;
    if (!activeId) return;
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
    setRows((current) => current.map((row) => (
      row.id === activeId ? { ...row, status: "final" as const } : row
    )));
    activeRowIdRef.current = null;
    activeRowSequenceRef.current = null;
    activeSourceTextRef.current = "";
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
  }, []);

  const getActiveSourceText = useCallback(() => activeSourceTextRef.current, []);
  const handleVadSpeechStart = useCallback((at: number) => {
    beginSpeechMeasurement(at);
    const elapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    ensureActiveRow(elapsedMs);
    lastSourceLanguageRef.current = "unknown";
    queueMicrotask(syncAudioOutputs);
  }, [beginSpeechMeasurement, ensureActiveRow, syncAudioOutputs]);
  const handleVadSilenceStart = useCallback((at: number) => {
    silenceStartedAtRef.current = at;
  }, []);
  const handleVadSilenceCancel = useCallback(() => {
    silenceStartedAtRef.current = null;
  }, []);
  const handleVadSpeechEnd = useCallback(() => {
    const sequence = activeRowSequenceRef.current;
    const startedAt = silenceStartedAtRef.current;
    if (sequence !== null && startedAt !== null) {
      pendingFinalizationLatencyRef.current = { sequence, startedAt };
    }
    finalizeCurrentRow();
  }, [finalizeCurrentRow]);

  const {
    markSpeechDetected,
    startLocalVad,
    stopLocalVad,
  } = useLocalVad({
    getActiveSourceText,
    onSpeechStart: handleVadSpeechStart,
    onSilenceStart: handleVadSilenceStart,
    onSilenceCancel: handleVadSilenceCancel,
    onSpeechEnd: handleVadSpeechEnd,
  });

  const closeTextTranslationJobs = useCallback(() => {
    for (const job of textTranslationJobsRef.current.values()) {
      if (job.timer !== null) window.clearTimeout(job.timer);
      job.controller?.abort();
    }
    textTranslationJobsRef.current.clear();
    lastTranslatedInputRef.current.clear();
  }, []);

  const closeTranslatedAudio = useCallback(() => {
    audioConnectionAbortControllerRef.current?.abort();
    audioConnectionAbortControllerRef.current = null;
    for (const connection of translationConnectionsRef.current) connection.close();
    translationConnectionsRef.current = [];
  }, []);

  const closeRealtimeResources = useCallback(() => {
    startAbortControllerRef.current?.abort();
    startAbortControllerRef.current = null;
    closeTextTranslationJobs();
    closeTranslatedAudio();
    stopLocalVad();
    activeSourceTextRef.current = "";
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    pendingFinalizationLatencyRef.current = null;
    transcriptionConnectionRef.current?.close();
    transcriptionConnectionRef.current = null;
    sourceStreamRef.current?.getTracks().forEach((track) => track.stop());
    sourceStreamRef.current = null;
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
  }, [closeTextTranslationJobs, closeTranslatedAudio, stopLocalVad]);

  const failSession = useCallback((message: string) => {
    closeRealtimeResources();
    setErrorMessage(message);
    setConnectionStatus("error");
    setIsListening(false);
  }, [closeRealtimeResources]);

  const handleTranscriptionText = useCallback((
    event: TranscriptionEvent,
    replaceWithCompletedTranscript: boolean,
  ) => {
    const text = replaceWithCompletedTranscript ? event.transcript : event.delta;
    if (!text) return;

    const elapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    let rowId = event.item_id
      ? transcriptionItemRowsRef.current.get(event.item_id)
      : undefined;
    rowId ??= activeRowIdRef.current ?? undefined;
    if (!rowId) {
      const latest = rowsRef.current.at(-1);
      const latestTime = latest?.endMs ?? latest?.startMs ?? 0;
      if (
        latest &&
        !latest.sourceText &&
        elapsedMs - latestTime <= RECENT_EMPTY_ROW_REUSE_MS
      ) {
        rowId = latest.id;
      }
    }
    if (!rowId) {
      if (speechStartedAtRef.current === null) {
        beginSpeechMeasurement(performance.now());
      }
      rowId = ensureActiveRow(elapsedMs);
      if (event.item_id) transcriptionItemRowsRef.current.set(event.item_id, rowId);
    }

    const isActiveRow = rowId === activeRowIdRef.current;
    if (!replaceWithCompletedTranscript && isActiveRow) markSpeechDetected();
    setRows((current) => {
      const index = current.findIndex((row) => row.id === rowId);
      if (index < 0) return current;
      const row = current[index];
      const sourceText = replaceWithCompletedTranscript
        ? text
        : `${row.sourceText ?? ""}${text}`;
      if (sourceText === row.sourceText) return current;

      const sourceLanguage = detectLanguage(sourceText);
      let ja = row.ja;
      let en = row.en;
      if (
        sourceLanguage !== "unknown" &&
        row.sourceLanguage !== "unknown" &&
        sourceLanguage !== row.sourceLanguage
      ) {
        ja = "";
        en = "";
      }
      if (sourceLanguage === "ja") ja = sourceText;
      if (sourceLanguage === "en") en = sourceText;

      if (row.id === activeRowIdRef.current) {
        activeSourceTextRef.current = sourceText;
        if (
          sourceLanguage !== "unknown" &&
          sourceLanguage !== lastSourceLanguageRef.current
        ) {
          lastSourceLanguageRef.current = sourceLanguage;
          queueMicrotask(syncAudioOutputs);
        }
      }

      return replaceRow(current, index, {
        ...row,
        sourceText,
        sourceLanguage,
        endMs: Math.max(row.endMs ?? 0, elapsedMs),
        status: row.id === activeRowIdRef.current ? "draft" : row.status,
        ja,
        en,
      });
    });

    if (isActiveRow) {
      if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = window.setTimeout(
        finalizeCurrentRow,
        FALLBACK_FINALIZE_MS,
      );
    }
  }, [
    beginSpeechMeasurement,
    ensureActiveRow,
    finalizeCurrentRow,
    markSpeechDetected,
    syncAudioOutputs,
  ]);

  const handleTranscriptionEvent = useCallback((event: TranscriptionEvent) => {
    if (event.type === "input_audio_buffer.speech_started") {
      if (speechStartedAtRef.current === null) {
        beginSpeechMeasurement(performance.now());
      }
      const elapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
      const rowId = ensureActiveRow(elapsedMs);
      if (event.item_id) transcriptionItemRowsRef.current.set(event.item_id, rowId);
      lastSourceLanguageRef.current = "unknown";
      queueMicrotask(syncAudioOutputs);
      markSpeechDetected();
    } else if (event.type === "conversation.item.input_audio_transcription.delta") {
      handleTranscriptionText(event, false);
    } else if (
      event.type === "conversation.item.input_audio_transcription.completed"
    ) {
      handleTranscriptionText(event, true);
    } else if (event.type === "error") {
      failSession(
        event.error?.message ?? "Realtime文字起こし中にエラーが発生しました。",
      );
    }
  }, [
    beginSpeechMeasurement,
    ensureActiveRow,
    failSession,
    handleTranscriptionText,
    markSpeechDetected,
    syncAudioOutputs,
  ]);

  const handleTranslatedAudioEvent = useCallback((
    _targetLanguage: TargetLanguage,
    event: TranslationEvent,
  ) => {
    if (event.type === "error") {
      failSession(
        event.error?.message ?? "翻訳音声の処理中にエラーが発生しました。",
      );
    }
  }, [failSession]);

  const connectTranslatedAudio = useCallback(async (
    sourceStream: MediaStream,
    signal: AbortSignal,
  ) => {
    if (translationConnectionsRef.current.length === 2) return;
    if (audioConnectionPromiseRef.current) return audioConnectionPromiseRef.current;

    const pending = (async () => {
      const results = await Promise.allSettled(
        (["en", "ja"] as const).map((targetLanguage) => connectTranslation({
          targetLanguage,
          sourceStream,
          muted: true,
          signal,
          onEvent: handleTranslatedAudioEvent,
          onConnectionState: (_language, state) => {
            if (state === "failed" && !signal.aborted) {
              failSession("翻訳音声のRealtime接続が切れました。");
            }
          },
        })),
      );
      const liveConnections = results.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      const failed = results.find((result) => result.status === "rejected");
      if (signal.aborted) {
        liveConnections.forEach((connection) => connection.close());
        return;
      }
      if (failed?.status === "rejected") {
        liveConnections.forEach((connection) => connection.close());
        throw failed.reason;
      }
      translationConnectionsRef.current = liveConnections;
      syncAudioOutputs();
    })();

    audioConnectionPromiseRef.current = pending;
    try {
      await pending;
    } finally {
      if (audioConnectionPromiseRef.current === pending) {
        audioConnectionPromiseRef.current = null;
      }
    }
  }, [failSession, handleTranslatedAudioEvent, syncAudioOutputs]);

  useEffect(() => {
    audioModeRef.current = audioMode;
    if (!isListening) {
      syncAudioOutputs();
      return;
    }

    if (audioMode === "off") {
      closeTranslatedAudio();
      return;
    }

    syncAudioOutputs();
    if (translationConnectionsRef.current.length === 2) return;
    const sourceStream = sourceStreamRef.current;
    if (!sourceStream) return;
    const reportConnectionError = (error: unknown, signal: AbortSignal) => {
      if (signal.aborted || isAbortError(error)) return;
      const message = error instanceof Error
        ? error.message
        : "翻訳音声を開始できませんでした。";
      failSession(message);
    };
    const pending = audioConnectionPromiseRef.current;
    const currentController = audioConnectionAbortControllerRef.current;
    if (pending && currentController && !currentController.signal.aborted) return;

    const controller = new AbortController();
    audioConnectionAbortControllerRef.current = controller;
    if (pending) {
      void pending.catch(() => undefined).then(() => {
        if (
          controller.signal.aborted ||
          audioModeRef.current === "off" ||
          !isListeningRef.current
        ) {
          return;
        }
        return connectTranslatedAudio(sourceStream, controller.signal)
          .catch((error) => reportConnectionError(error, controller.signal));
      });
      return;
    }

    void connectTranslatedAudio(sourceStream, controller.signal)
      .catch((error) => reportConnectionError(error, controller.signal));
  }, [
    audioMode,
    closeTranslatedAudio,
    connectTranslatedAudio,
    failSession,
    isListening,
    syncAudioOutputs,
  ]);

  useEffect(() => {
    if (!isListening) return;
    for (const row of rows) {
      if (row.sourceLanguage === "unknown" || !row.sourceText?.trim()) continue;
      const sourceLanguage = row.sourceLanguage;
      const targetLanguage: Language = sourceLanguage === "ja" ? "en" : "ja";
      const inputKey = `${sourceLanguage}:${row.sourceText}`;
      if (lastTranslatedInputRef.current.get(row.id) === inputKey) continue;
      lastTranslatedInputRef.current.set(row.id, inputKey);

      const previous = textTranslationJobsRef.current.get(row.id);
      const job = previous ?? {
        controller: null,
        timer: null,
        running: false,
        lastStartedAt: 0,
        pending: null,
      } satisfies TextTranslationJob;
      job.pending = {
        sourceText: row.sourceText,
        sourceLanguage,
        targetLanguage,
      };
      textTranslationJobsRef.current.set(row.id, job);

      const runNextTranslation = () => {
        const latestJob = textTranslationJobsRef.current.get(row.id);
        if (
          !latestJob ||
          latestJob.running ||
          latestJob.timer !== null ||
          !latestJob.pending
        ) {
          return;
        }
        const delay = Math.max(
          0,
          TEXT_TRANSLATION_MIN_INTERVAL_MS -
            (performance.now() - latestJob.lastStartedAt),
        );
        latestJob.timer = window.setTimeout(() => {
          const activeJob = textTranslationJobsRef.current.get(row.id);
          const request = activeJob?.pending;
          if (!activeJob || !request) return;
          activeJob.pending = null;
          activeJob.timer = null;
          activeJob.running = true;
          activeJob.lastStartedAt = performance.now();
          const controller = new AbortController();
          activeJob.controller = controller;
          let receivedDelta = false;

          void streamTextTranslation({
            text: request.sourceText,
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            signal: controller.signal,
            onDelta: (delta) => {
              if (controller.signal.aborted) return;
              const replaceExisting = !receivedDelta;
              receivedDelta = true;
              setRows((current) => {
                const index = current.findIndex((candidate) => candidate.id === row.id);
                if (index < 0) return current;
                const currentRow = current[index];
                if (
                  currentRow.sourceLanguage !== request.sourceLanguage ||
                  !currentRow.sourceText?.startsWith(request.sourceText)
                ) {
                  return current;
                }
                return replaceRow(current, index, {
                  ...currentRow,
                  [request.targetLanguage]: replaceExisting
                    ? delta
                    : `${currentRow[request.targetLanguage]}${delta}`,
                });
              });
            },
          }).catch((error) => {
            if (controller.signal.aborted || isAbortError(error)) return;
            const message = error instanceof Error
              ? error.message
              : "テキスト翻訳に失敗しました。";
            if (isListeningRef.current) failSession(message);
          }).finally(() => {
            const completedJob = textTranslationJobsRef.current.get(row.id);
            if (!completedJob || completedJob.controller !== controller) return;
            completedJob.controller = null;
            completedJob.running = false;
            runNextTranslation();
          });
        }, delay);
      };
      runNextTranslation();
    }
  }, [failSession, isListening, rows]);

  useEffect(() => () => closeRealtimeResources(), [closeRealtimeResources]);

  const startConversation = async () => {
    if (apiConfigured === false) {
      setConnectionStatus("error");
      setErrorMessage("OPENAI_API_KEY が設定されていません。.env.local を設定してサーバーを再起動してください。");
      return;
    }

    closeRealtimeResources();
    setErrorMessage("");
    setConnectionStatus("connecting");
    setIsListening(false);
    setElapsed(0);
    setRows([]);
    rowsRef.current = [];
    activeRowIdRef.current = null;
    activeRowSequenceRef.current = null;
    transcriptionItemRowsRef.current.clear();
    lastSourceLanguageRef.current = "unknown";
    activeSourceTextRef.current = "";
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    speechStartedAtByRowRef.current.clear();
    sourceDisplayMeasuredRowsRef.current.clear();
    translationDisplayMeasuredRowsRef.current.clear();
    pendingFinalizationLatencyRef.current = null;
    resetBrowserLatencyMeasurements();
    sessionStartedAtRef.current = Date.now();
    const startAbortController = new AbortController();
    startAbortControllerRef.current = startAbortController;

    try {
      const sourceStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (startAbortController.signal.aborted) {
        sourceStream.getTracks().forEach((track) => track.stop());
        return;
      }
      sourceStreamRef.current = sourceStream;
      startLocalVad(sourceStream);

      const transcriptionPromise = connectTranscription({
        sourceStream,
        signal: startAbortController.signal,
        onEvent: handleTranscriptionEvent,
        onConnectionState: (state) => {
          if (state === "failed" && !startAbortController.signal.aborted) {
            failSession("Realtime文字起こしとの接続が切れました。");
          }
        },
      }).then((connection) => {
        transcriptionConnectionRef.current = connection;
      });
      const audioPromise = audioModeRef.current === "off"
        ? Promise.resolve()
        : connectTranslatedAudio(sourceStream, startAbortController.signal);
      await Promise.all([transcriptionPromise, audioPromise]);

      if (startAbortController.signal.aborted) return;
      setApiConfigured(true);
      setConnectionStatus("live");
      setIsListening(true);
    } catch (error) {
      if (startAbortController.signal.aborted) return;
      closeRealtimeResources();
      const message = error instanceof Error ? error.message : "接続を開始できませんでした。";
      setErrorMessage(message);
      setConnectionStatus("error");
      setIsListening(false);
      if (message.includes("OPENAI_API_KEY")) setApiConfigured(false);
    }
  };

  const stopConversation = () => {
    finalizeCurrentRow();
    closeRealtimeResources();
    setIsListening(false);
    setConnectionStatus("idle");
  };

  return {
    apiConfigured,
    audioMode,
    connectionStatus,
    dismissError: () => setErrorMessage(""),
    elapsed,
    errorMessage,
    isListening,
    rows,
    setAudioMode,
    startConversation,
    stopConversation,
  };
}
