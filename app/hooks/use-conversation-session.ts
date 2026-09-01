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
import type { Language, TargetLanguage, Utterance } from "@/lib/translation-types";
import {
  alignSourceAndTranslation,
  appendTranslationCandidate,
  createLiveUtterance,
  detectLanguage,
  findReusableTranscriptionRow,
  findTranslationRowIndex,
  replaceRow,
} from "@/lib/utterance-alignment";

export type AudioMode = "off" | "ja" | "en" | "auto";
export type ConnectionStatus = "idle" | "connecting" | "live" | "error";

const FALLBACK_FINALIZE_MS = 1_200;
const EMPTY_ROW_CLEANUP_MS = 5_000;
const PENDING_TRANSLATION_MAX_AGE_MS = 3_000;

type PendingTranslation = {
  elapsedMs: number;
  text: string;
};

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
  const startAbortControllerRef = useRef<AbortController | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const rowsRef = useRef(rows);
  const activeRowIdRef = useRef<string | null>(null);
  const rowIdCounterRef = useRef(0);
  const transcriptionItemRowsRef = useRef(new Map<string, string>());
  const transcriptionRowItemsRef = useRef(new Map<string, string>());
  const unboundTranscriptionRowsRef = useRef<string[]>([]);
  const committedTranscriptionRowsRef = useRef(new Set<string>());
  const transcriptionClockOffsetRef = useRef(0);
  const finalizeTimerRef = useRef<number | null>(null);
  const emptyRowCleanupTimersRef = useRef(new Map<string, number>());
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
    rowId: string;
    startedAt: number;
  } | null>(null);
  const translationCandidatesRef = useRef(
    new Map<string, Partial<Record<TargetLanguage, string>>>(),
  );
  const pendingTranslationsRef = useRef(
    new Map<TargetLanguage, PendingTranslation>(),
  );
  const translationClockOffsetsRef = useRef(new Map<TargetLanguage, number>());

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
    const finalizedRow = pendingFinalization
      ? rows.find((row) => (
        row.id === pendingFinalization.rowId && row.status === "final"
      ))
      : undefined;
    if (pendingFinalization && finalizedRow) {
      recordBrowserLatency(
        finalizedRow.sequence,
        "silence-to-row-final",
        pendingFinalization.startedAt,
      );
      pendingFinalizationLatencyRef.current = null;
    }
  }, [rows]);

  useEffect(() => {
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
    void prefetchTranslationClientSecrets().catch(() => undefined);
  }, [apiConfigured]);

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

  const updateRows = useCallback((
    update: (current: Utterance[]) => Utterance[],
  ) => {
    const next = update(rowsRef.current);
    if (next === rowsRef.current) return;
    rowsRef.current = next;
    setRows(next);
  }, []);

  const clearEmptyRowCleanup = useCallback((rowId: string) => {
    const timer = emptyRowCleanupTimersRef.current.get(rowId);
    if (timer !== undefined) window.clearTimeout(timer);
    emptyRowCleanupTimersRef.current.delete(rowId);
  }, []);

  const discardEmptyRow = useCallback((rowId: string) => {
    const row = rowsRef.current.find((candidate) => candidate.id === rowId);
    if (!row || row.sourceText?.trim()) return;

    clearEmptyRowCleanup(rowId);
    const itemId = transcriptionRowItemsRef.current.get(rowId);
    if (itemId) transcriptionItemRowsRef.current.delete(itemId);
    transcriptionRowItemsRef.current.delete(rowId);
    unboundTranscriptionRowsRef.current = unboundTranscriptionRowsRef.current
      .filter((candidate) => candidate !== rowId);
    committedTranscriptionRowsRef.current.delete(rowId);
    translationCandidatesRef.current.delete(rowId);
    speechStartedAtByRowRef.current.delete(rowId);
    sourceDisplayMeasuredRowsRef.current.delete(rowId);
    translationDisplayMeasuredRowsRef.current.delete(rowId);

    if (activeRowIdRef.current === rowId) {
      activeRowIdRef.current = null;
      activeSourceTextRef.current = "";
    }

    updateRows((current) => {
      const next = current
        .filter((candidate) => candidate.id !== rowId)
        .map((candidate, index) => (
          candidate.sequence === index + 1
            ? candidate
            : { ...candidate, sequence: index + 1 }
        ));
      return next;
    });
  }, [clearEmptyRowCleanup, updateRows]);

  const scheduleEmptyRowCleanup = useCallback((rowId: string) => {
    clearEmptyRowCleanup(rowId);
    const timer = window.setTimeout(
      () => discardEmptyRow(rowId),
      EMPTY_ROW_CLEANUP_MS,
    );
    emptyRowCleanupTimersRef.current.set(rowId, timer);
  }, [clearEmptyRowCleanup, discardEmptyRow]);

  const finalizeRow = useCallback((rowId: string) => {
    const rowHasSource = Boolean(
      rowsRef.current.find((row) => row.id === rowId)?.sourceText?.trim(),
    );
    if (rowHasSource) clearEmptyRowCleanup(rowId);
    updateRows((current) => {
      const index = current.findIndex((row) => row.id === rowId);
      if (index < 0 || current[index].status === "final") return current;
      return replaceRow(current, index, {
        ...current[index],
        status: "final",
      });
    });

    if (activeRowIdRef.current !== rowId) return;
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
    activeRowIdRef.current = null;
    activeSourceTextRef.current = "";
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
  }, [clearEmptyRowCleanup, updateRows]);

  const createActiveRow = useCallback((elapsedMs: number) => {
    const sequence = (rowsRef.current.at(-1)?.sequence ?? 0) + 1;
    const row = createLiveUtterance(
      sequence,
      elapsedMs,
      `live-${sessionStartedAtRef.current}-${++rowIdCounterRef.current}`,
    );
    activeRowIdRef.current = row.id;
    const speechStartedAt = speechStartedAtRef.current;
    if (speechStartedAt !== null) {
      speechStartedAtByRowRef.current.set(row.id, speechStartedAt);
    }

    const pendingCandidates: Partial<Record<TargetLanguage, string>> = {};
    for (const [targetLanguage, pending] of pendingTranslationsRef.current) {
      if (Math.abs(pending.elapsedMs - elapsedMs) <= PENDING_TRANSLATION_MAX_AGE_MS) {
        pendingCandidates[targetLanguage] = pending.text;
      }
    }
    pendingTranslationsRef.current.clear();
    if (Object.keys(pendingCandidates).length > 0) {
      translationCandidatesRef.current.set(row.id, pendingCandidates);
    }

    updateRows((current) => [...current, row]);
    unboundTranscriptionRowsRef.current.push(row.id);
    scheduleEmptyRowCleanup(row.id);
    return row.id;
  }, [scheduleEmptyRowCleanup, updateRows]);

  const ensureTranscriptionRow = useCallback((
    itemId: string | undefined,
    elapsedMs: number,
  ) => {
    const reusableRowId = findReusableTranscriptionRow(
      itemId,
      transcriptionItemRowsRef.current,
      transcriptionRowItemsRef.current,
      activeRowIdRef.current,
      unboundTranscriptionRowsRef.current,
    );
    if (reusableRowId) {
      if (itemId && !transcriptionRowItemsRef.current.has(reusableRowId)) {
        transcriptionItemRowsRef.current.set(itemId, reusableRowId);
        transcriptionRowItemsRef.current.set(reusableRowId, itemId);
        unboundTranscriptionRowsRef.current = unboundTranscriptionRowsRef.current
          .filter((candidate) => candidate !== reusableRowId);
      }
      return reusableRowId;
    }

    const previousActiveRowId = activeRowIdRef.current;
    if (previousActiveRowId) finalizeRow(previousActiveRowId);
    const rowId = createActiveRow(elapsedMs);
    if (itemId) {
      transcriptionItemRowsRef.current.set(itemId, rowId);
      transcriptionRowItemsRef.current.set(rowId, itemId);
      unboundTranscriptionRowsRef.current = unboundTranscriptionRowsRef.current
        .filter((candidate) => candidate !== rowId);
    }
    return rowId;
  }, [createActiveRow, finalizeRow]);

  const commitTranscriptionRow = useCallback((rowId: string) => {
    if (committedTranscriptionRowsRef.current.has(rowId)) return;
    if (transcriptionConnectionRef.current?.commit()) {
      committedTranscriptionRowsRef.current.add(rowId);
    }
  }, []);

  const getActiveSourceText = useCallback(() => activeSourceTextRef.current, []);
  const handleVadSpeechStart = useCallback((at: number) => {
    const previousActiveRowId = activeRowIdRef.current;
    if (previousActiveRowId) {
      commitTranscriptionRow(previousActiveRowId);
      finalizeRow(previousActiveRowId);
    }
    beginSpeechMeasurement(at);
    const elapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    createActiveRow(elapsedMs);
    lastSourceLanguageRef.current = "unknown";
    queueMicrotask(syncAudioOutputs);
  }, [
    beginSpeechMeasurement,
    commitTranscriptionRow,
    createActiveRow,
    finalizeRow,
    syncAudioOutputs,
  ]);
  const handleVadSilenceStart = useCallback((at: number) => {
    silenceStartedAtRef.current = at;
  }, []);
  const handleVadSilenceCancel = useCallback(() => {
    silenceStartedAtRef.current = null;
  }, []);
  const handleVadSpeechEnd = useCallback(() => {
    const rowId = activeRowIdRef.current;
    const startedAt = silenceStartedAtRef.current;
    if (rowId && startedAt !== null) {
      pendingFinalizationLatencyRef.current = { rowId, startedAt };
    }
    if (rowId) {
      commitTranscriptionRow(rowId);
      finalizeRow(rowId);
    }
  }, [commitTranscriptionRow, finalizeRow]);

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

  const closeTranslationConnections = useCallback(() => {
    for (const connection of translationConnectionsRef.current) connection.close();
    translationConnectionsRef.current = [];
  }, []);

  const closeRealtimeResources = useCallback(() => {
    startAbortControllerRef.current?.abort();
    startAbortControllerRef.current = null;
    closeTranslationConnections();
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
    for (const timer of emptyRowCleanupTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    emptyRowCleanupTimersRef.current.clear();
  }, [closeTranslationConnections, stopLocalVad]);

  const failSession = useCallback((message: string) => {
    for (const row of [...rowsRef.current]) {
      if (!row.sourceText?.trim()) discardEmptyRow(row.id);
    }
    closeRealtimeResources();
    setErrorMessage(message);
    setConnectionStatus("error");
    setIsListening(false);
  }, [closeRealtimeResources, discardEmptyRow]);

  const handleTranscriptionText = useCallback((
    event: TranscriptionEvent,
    replaceWithCompletedTranscript: boolean,
  ) => {
    const text = (replaceWithCompletedTranscript ? event.transcript : event.delta) ?? "";
    if (!text && !replaceWithCompletedTranscript) return;

    const elapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    const measurementStartedAt = speechStartedAtRef.current ?? performance.now();
    const rowId = ensureTranscriptionRow(event.item_id, elapsedMs);
    speechStartedAtRef.current = measurementStartedAt;
    if (!speechStartedAtByRowRef.current.has(rowId)) {
      speechStartedAtByRowRef.current.set(rowId, measurementStartedAt);
    }

    const isActiveRow = rowId === activeRowIdRef.current;
    if (!replaceWithCompletedTranscript && isActiveRow) markSpeechDetected();
    clearEmptyRowCleanup(rowId);
    updateRows((current) => {
      const index = current.findIndex((row) => row.id === rowId);
      if (index < 0) return current;
      const row = current[index];
      const sourceText = replaceWithCompletedTranscript
        ? text
        : `${row.sourceText ?? ""}${text}`;
      if (sourceText === row.sourceText) return current;

      const sourceLanguage = detectLanguage(sourceText);
      const translationCandidates = translationCandidatesRef.current.get(row.id);
      const { ja, en } = alignSourceAndTranslation(
        row,
        sourceText,
        sourceLanguage,
        translationCandidates ?? {},
      );

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
        ja,
        en,
      });
    });

    if (replaceWithCompletedTranscript) {
      if (text.trim()) {
        finalizeRow(rowId);
      } else {
        discardEmptyRow(rowId);
      }
    } else if (isActiveRow) {
      if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = window.setTimeout(
        () => {
          commitTranscriptionRow(rowId);
          finalizeRow(rowId);
        },
        FALLBACK_FINALIZE_MS,
      );
    }
  }, [
    clearEmptyRowCleanup,
    commitTranscriptionRow,
    discardEmptyRow,
    ensureTranscriptionRow,
    finalizeRow,
    markSpeechDetected,
    syncAudioOutputs,
    updateRows,
  ]);

  const handleTranscriptionEvent = useCallback((event: TranscriptionEvent) => {
    if (event.type === "input_audio_buffer.speech_started") {
      const measurementStartedAt = speechStartedAtRef.current ?? performance.now();
      const elapsedMs = typeof event.audio_start_ms === "number"
        ? event.audio_start_ms + transcriptionClockOffsetRef.current
        : Math.max(0, Date.now() - sessionStartedAtRef.current);
      const rowId = ensureTranscriptionRow(event.item_id, elapsedMs);
      speechStartedAtRef.current = measurementStartedAt;
      speechStartedAtByRowRef.current.set(rowId, measurementStartedAt);
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
    ensureTranscriptionRow,
    failSession,
    handleTranscriptionText,
    markSpeechDetected,
    syncAudioOutputs,
  ]);

  const handleTranslationOutputDelta = useCallback((
    targetLanguage: TargetLanguage,
    event: TranslationEvent,
  ) => {
    if (!event.delta) return;
    const fallbackElapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    const elapsedMs = typeof event.elapsed_ms === "number"
      ? event.elapsed_ms + (translationClockOffsetsRef.current.get(targetLanguage) ?? 0)
      : fallbackElapsedMs;

    updateRows((current) => {
      const index = findTranslationRowIndex(
        current,
        activeRowIdRef.current,
        elapsedMs,
      );
      if (index < 0) {
        const pending = pendingTranslationsRef.current.get(targetLanguage);
        pendingTranslationsRef.current.set(targetLanguage, {
          elapsedMs,
          text: `${
            pending && elapsedMs - pending.elapsedMs <= PENDING_TRANSLATION_MAX_AGE_MS
              ? pending.text
              : ""
          }${event.delta}`,
        });
        return current;
      }

      const row = current[index];
      const candidates = translationCandidatesRef.current.get(row.id) ?? {};
      const nextCandidates = appendTranslationCandidate(
        candidates,
        targetLanguage,
        event.delta!,
      );
      const translatedText = nextCandidates[targetLanguage] ?? "";
      translationCandidatesRef.current.set(row.id, nextCandidates);

      if (
        row.sourceLanguage === "unknown" ||
        row.sourceLanguage === targetLanguage
      ) {
        return current;
      }
      return replaceRow(current, index, {
        ...row,
        [targetLanguage]: translatedText,
      });
    });
  }, [updateRows]);

  const handleTranslationEvent = useCallback((
    targetLanguage: TargetLanguage,
    event: TranslationEvent,
  ) => {
    if (event.type === "session.output_transcript.delta") {
      handleTranslationOutputDelta(targetLanguage, event);
    } else if (event.type === "error") {
      failSession(
        event.error?.message ?? "Realtime翻訳中にエラーが発生しました。",
      );
    }
  }, [failSession, handleTranslationOutputDelta]);

  const connectTranslationSessions = useCallback(async (
    sourceStream: MediaStream,
    signal: AbortSignal,
  ) => {
    const results = await Promise.allSettled(
      (["en", "ja"] as const).map((targetLanguage) => {
        translationClockOffsetsRef.current.set(
          targetLanguage,
          Math.max(0, Date.now() - sessionStartedAtRef.current),
        );
        return connectTranslation({
          targetLanguage,
          sourceStream,
          muted: true,
          signal,
          onEvent: handleTranslationEvent,
          onConnectionState: (_language, state) => {
            if (state === "failed" && !signal.aborted) {
              failSession("Realtime翻訳との接続が切れました。");
            }
          },
        });
      }),
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
  }, [failSession, handleTranslationEvent, syncAudioOutputs]);

  useEffect(() => {
    audioModeRef.current = audioMode;
    syncAudioOutputs();
  }, [audioMode, syncAudioOutputs]);

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
    rowIdCounterRef.current = 0;
    transcriptionItemRowsRef.current.clear();
    transcriptionRowItemsRef.current.clear();
    unboundTranscriptionRowsRef.current = [];
    committedTranscriptionRowsRef.current.clear();
    transcriptionClockOffsetRef.current = 0;
    translationCandidatesRef.current.clear();
    pendingTranslationsRef.current.clear();
    translationClockOffsetsRef.current.clear();
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

      transcriptionClockOffsetRef.current = Math.max(
        0,
        Date.now() - sessionStartedAtRef.current,
      );
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
      const translationPromise = connectTranslationSessions(
        sourceStream,
        startAbortController.signal,
      );
      await Promise.all([transcriptionPromise, translationPromise]);

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
    const activeRowId = activeRowIdRef.current;
    if (activeRowId) {
      const activeRow = rowsRef.current.find((row) => row.id === activeRowId);
      if (activeRow?.sourceText?.trim()) {
        commitTranscriptionRow(activeRowId);
        finalizeRow(activeRowId);
      }
    }
    for (const row of [...rowsRef.current]) {
      if (!row.sourceText?.trim()) discardEmptyRow(row.id);
    }
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
