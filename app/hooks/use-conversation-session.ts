"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalVad } from "@/app/hooks/use-local-vad";
import {
  recordBrowserLatency,
  resetBrowserLatencyMeasurements,
} from "@/lib/browser-latency";
import { DEMO_UTTERANCES } from "@/lib/demo-utterances";
import {
  CONNECTION_TIMEOUT_MS,
  createConnectionAbortScope,
  withAbortCleanup,
  type ConnectionAbortScope,
} from "@/lib/realtime-connection";
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
import { SILENCE_WATCHDOG_MS } from "@/lib/local-vad";
import {
  alignSourceAndTranslation,
  appendTranslationCandidate,
  bindTranscriptionItemToOldestRow,
  createLiveUtterance,
  detectLanguage,
  findReusableTranscriptionRow,
  replaceRow,
} from "@/lib/utterance-alignment";

import {
  TranslationFragmentBuffer,
  type AssignedTranslationFragment,
} from "@/lib/translation-fragments";

export type AudioMode = "off" | "ja" | "en" | "auto";
export type ConnectionStatus = "idle" | "connecting" | "live" | "error";

const EMPTY_ROW_CLEANUP_MS = 5_000;
const STOP_DRAIN_TIMEOUT_MS = 5_000;

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
  const startAbortScopeRef = useRef<ConnectionAbortScope | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const rowsRef = useRef(rows);
  const activeRowIdRef = useRef<string | null>(null);
  const rowIdCounterRef = useRef(0);
  const transcriptionItemRowsRef = useRef(new Map<string, string>());
  const transcriptionRowItemsRef = useRef(new Map<string, string>());
  const discardedTranscriptionItemsRef = useRef(new Set<string>());
  const unboundTranscriptionRowsRef = useRef<string[]>([]);
  const committedTranscriptionRowsRef = useRef(new Set<string>());
  const transcriptionClockOffsetRef = useRef(0);
  const stoppingRef = useRef(false);
  const liveRef = useRef(false);
  const stopDrainTimerRef = useRef<number | null>(null);
  const finishStopRef = useRef<(() => void) | null>(null);
  const translationsDrainedRef = useRef(false);
  const finalizeTimerRef = useRef<number | null>(null);
  const emptyRowCleanupTimersRef = useRef(new Map<string, number>());
  const activeSourceTextRef = useRef("");
  const sessionStartedAtRef = useRef(0);
  const lastSourceLanguageRef = useRef<Language | "unknown">("unknown");
  const playbackRowIdRef = useRef<string | null>(null);
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
  const pendingTranslationsRef = useRef(new TranslationFragmentBuffer());
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
    const controller = new AbortController();
    void fetch("/api/realtime/session", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("起動設定を確認できませんでした。");
        return response.json() as Promise<{ configured?: boolean }>;
      })
      .then((payload) => setApiConfigured(Boolean(payload.configured)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setApiConfigured(null);
        setErrorMessage("起動設定を確認できませんでした。");
        setConnectionStatus("error");
      });
    return () => controller.abort();
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
      const shouldPlay = !stoppingRef.current && outputIsTranslation && languageMatches;
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

  const discardEmptyRow = useCallback((rowId: string, force = false) => {
    const row = rowsRef.current.find((candidate) => candidate.id === rowId);
    if (!row || row.sourceText?.trim()) return;
    // Acoustic activity and committed audio remain authoritative while ASR is pending.
    if (!force && activeRowIdRef.current === rowId) return;
    if (!force && row.sourceStatus !== "completed" && (
      committedTranscriptionRowsRef.current.has(rowId) ||
      transcriptionRowItemsRef.current.has(rowId)
    )) return;

    clearEmptyRowCleanup(rowId);
    const itemId = transcriptionRowItemsRef.current.get(rowId);
    if (itemId) {
      discardedTranscriptionItemsRef.current.add(itemId);
      transcriptionItemRowsRef.current.delete(itemId);
    }
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
    if (playbackRowIdRef.current === rowId) {
      playbackRowIdRef.current = null;
      lastSourceLanguageRef.current = "unknown";
      queueMicrotask(syncAudioOutputs);
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
  }, [clearEmptyRowCleanup, syncAudioOutputs, updateRows]);

  const scheduleEmptyRowCleanup = useCallback((rowId: string) => {
    clearEmptyRowCleanup(rowId);
    const timer = window.setTimeout(
      () => discardEmptyRow(rowId),
      EMPTY_ROW_CLEANUP_MS,
    );
    emptyRowCleanupTimersRef.current.set(rowId, timer);
  }, [clearEmptyRowCleanup, discardEmptyRow]);

  const finalizeRow = useCallback((rowId: string) => {
    const elapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    const speechEndMs = silenceStartedAtRef.current === null
      ? elapsedMs
      : Math.max(0, elapsedMs - (performance.now() - silenceStartedAtRef.current));
    const rowHasSource = Boolean(
      rowsRef.current.find((row) => row.id === rowId)?.sourceText?.trim(),
    );
    if (rowHasSource) clearEmptyRowCleanup(rowId);
    updateRows((current) => {
      const index = current.findIndex((row) => row.id === rowId);
      if (index < 0 || current[index].speechEndMs !== undefined) return current;
      return replaceRow(current, index, {
        ...current[index],
        status: current[index].sourceStatus === "completed" ? "final" : "draft",
        speechEndMs,
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

  const applyTranslationFragments = useCallback((
    fragments: AssignedTranslationFragment[],
  ) => {
    if (fragments.length === 0) return;
    updateRows((current) => {
      let next = current;
      for (const { rowId, targetLanguage, text } of fragments) {
        const index = next.findIndex((row) => row.id === rowId);
        if (index < 0) continue;
        const row = next[index];
        const candidates = appendTranslationCandidate(
          translationCandidatesRef.current.get(rowId) ?? {},
          targetLanguage,
          text,
        );
        translationCandidatesRef.current.set(rowId, candidates);
        if (row.sourceLanguage !== "unknown" && row.sourceLanguage !== targetLanguage) {
          next = replaceRow(next, index, {
            ...row,
            [targetLanguage]: candidates[targetLanguage] ?? "",
          });
        }
      }
      return next;
    });
  }, [updateRows]);

  const createActiveRow = useCallback((elapsedMs: number) => {
    const sequence = (rowsRef.current.at(-1)?.sequence ?? 0) + 1;
    const row = createLiveUtterance(
      sequence,
      elapsedMs,
      `live-${sessionStartedAtRef.current}-${++rowIdCounterRef.current}`,
    );
    row.sourceStatus = "pending";
    activeRowIdRef.current = row.id;
    playbackRowIdRef.current = row.id;
    const speechStartedAt = speechStartedAtRef.current;
    if (speechStartedAt !== null) {
      speechStartedAtByRowRef.current.set(row.id, speechStartedAt);
    }

    updateRows((current) => [...current, row]);
    applyTranslationFragments(pendingTranslationsRef.current.reconcile(
      rowsRef.current,
      row.id,
      performance.now(),
    ));
    unboundTranscriptionRowsRef.current.push(row.id);
    scheduleEmptyRowCleanup(row.id);
    return row.id;
  }, [applyTranslationFragments, scheduleEmptyRowCleanup, updateRows]);

  const bindTranscriptionItem = useCallback((itemId: string) => {
    const rowId = bindTranscriptionItemToOldestRow(
      itemId,
      transcriptionItemRowsRef.current,
      transcriptionRowItemsRef.current,
      unboundTranscriptionRowsRef.current,
    );
    if (rowId) {
      unboundTranscriptionRowsRef.current = unboundTranscriptionRowsRef.current
        .filter((candidate) => candidate !== rowId);
    }
    return rowId;
  }, []);

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
        bindTranscriptionItem(itemId);
      }
      return reusableRowId;
    }

    const previousActiveRowId = activeRowIdRef.current;
    if (previousActiveRowId) finalizeRow(previousActiveRowId);
    const rowId = createActiveRow(elapsedMs);
    if (itemId) {
      bindTranscriptionItem(itemId);
    }
    return rowId;
  }, [bindTranscriptionItem, createActiveRow, finalizeRow]);

  const commitTranscriptionRow = useCallback((rowId: string) => {
    if (committedTranscriptionRowsRef.current.has(rowId)) return;
    if (transcriptionConnectionRef.current?.commit()) {
      committedTranscriptionRowsRef.current.add(rowId);
    }
  }, []);

  const scheduleFallbackFinalization = useCallback((rowId: string) => {
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = window.setTimeout(() => {
      if (activeRowIdRef.current !== rowId || silenceStartedAtRef.current === null) return;
      commitTranscriptionRow(rowId);
      finalizeRow(rowId);
    }, SILENCE_WATCHDOG_MS);
  }, [commitTranscriptionRow, finalizeRow]);

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
    const rowId = activeRowIdRef.current;
    if (rowId) scheduleFallbackFinalization(rowId);
  }, [scheduleFallbackFinalization]);
  const handleVadSilenceCancel = useCallback(() => {
    silenceStartedAtRef.current = null;
    if (finalizeTimerRef.current !== null) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
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
      discardEmptyRow(rowId);
    }
  }, [commitTranscriptionRow, discardEmptyRow, finalizeRow]);

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
    liveRef.current = false;
    stoppingRef.current = false;
    finishStopRef.current = null;
    if (stopDrainTimerRef.current !== null) window.clearTimeout(stopDrainTimerRef.current);
    stopDrainTimerRef.current = null;
    const startAbortScope = startAbortScopeRef.current;
    startAbortScopeRef.current = null;
    startAbortScope?.abort();
    startAbortScope?.dispose();
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
      if (!row.sourceText?.trim()) discardEmptyRow(row.id, true);
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

    if (!replaceWithCompletedTranscript && rowId === activeRowIdRef.current && !stoppingRef.current) {
      // Recover a turn missed by local VAD; its next acoustic sample still decides silence.
      markSpeechDetected();
    }
    clearEmptyRowCleanup(rowId);
    updateRows((current) => {
      const index = current.findIndex((row) => row.id === rowId);
      if (index < 0) return current;
      const row = current[index];
      const sourceText = replaceWithCompletedTranscript
        ? text
        : `${row.sourceText ?? ""}${text}`;
      const sourceStatus = replaceWithCompletedTranscript ? "completed" : "streaming";
      if (sourceText === row.sourceText && row.sourceStatus === sourceStatus) return current;

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
      }
      if (
        row.id === playbackRowIdRef.current &&
        sourceLanguage !== "unknown" &&
        sourceLanguage !== lastSourceLanguageRef.current
      ) {
        lastSourceLanguageRef.current = sourceLanguage;
        queueMicrotask(syncAudioOutputs);
      }

      return replaceRow(current, index, {
        ...row,
        sourceText,
        sourceStatus,
        status: sourceStatus === "completed" && row.speechEndMs !== undefined ? "final" : row.status,
        sourceLanguage,
        endMs: Math.max(row.endMs ?? 0, elapsedMs),
        ja,
        en,
      });
    });

    if (replaceWithCompletedTranscript) {
      if (!text.trim()) discardEmptyRow(rowId);
      finishStopRef.current?.();
    }
  }, [
    clearEmptyRowCleanup,
    discardEmptyRow,
    ensureTranscriptionRow,
    markSpeechDetected,
    syncAudioOutputs,
    updateRows,
  ]);

  const handleTranscriptionEvent = useCallback((event: TranscriptionEvent) => {
    if (event.item_id && discardedTranscriptionItemsRef.current.has(event.item_id)) return;
    if (event.type === "input_audio_buffer.committed" && event.item_id) {
      bindTranscriptionItem(event.item_id);
    } else if (event.type === "input_audio_buffer.speech_started") {
      const measurementStartedAt = speechStartedAtRef.current ?? performance.now();
      const elapsedMs = typeof event.audio_start_ms === "number"
        ? event.audio_start_ms + transcriptionClockOffsetRef.current
        : Math.max(0, Date.now() - sessionStartedAtRef.current);
      const rowId = ensureTranscriptionRow(event.item_id, elapsedMs);
      speechStartedAtRef.current = measurementStartedAt;
      speechStartedAtByRowRef.current.set(rowId, measurementStartedAt);
      lastSourceLanguageRef.current = "unknown";
      queueMicrotask(syncAudioOutputs);
      if (!stoppingRef.current) markSpeechDetected();
    } else if (event.type === "conversation.item.input_audio_transcription.delta") {
      handleTranscriptionText(event, false);
    } else if (
      event.type === "conversation.item.input_audio_transcription.completed"
    ) {
      handleTranscriptionText(event, true);
    } else if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      failSession(
        event.error?.message ?? "Realtime文字起こし中にエラーが発生しました。",
      );
    }
  }, [
    bindTranscriptionItem,
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
    const receivedElapsedMs = Math.max(0, Date.now() - sessionStartedAtRef.current);
    const elapsedMs = typeof event.elapsed_ms === "number"
      ? event.elapsed_ms + (translationClockOffsetsRef.current.get(targetLanguage) ?? 0)
      : undefined;
    const fragments = pendingTranslationsRef.current.receive(
      rowsRef.current,
      activeRowIdRef.current,
      {
        targetLanguage,
        text: event.delta,
        elapsedMs,
        receivedElapsedMs,
        receivedAt: performance.now(),
      },
    );
    applyTranslationFragments(fragments);
  }, [applyTranslationFragments]);

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
          onEvent: (language, event) => {
            if (!signal.aborted) handleTranslationEvent(language, event);
          },
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
      setConnectionStatus("idle");
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
    discardedTranscriptionItemsRef.current.clear();
    unboundTranscriptionRowsRef.current = [];
    committedTranscriptionRowsRef.current.clear();
    transcriptionClockOffsetRef.current = 0;
    translationCandidatesRef.current.clear();
    pendingTranslationsRef.current.clear();
    translationClockOffsetsRef.current.clear();
    lastSourceLanguageRef.current = "unknown";
    playbackRowIdRef.current = null;
    activeSourceTextRef.current = "";
    speechStartedAtRef.current = null;
    silenceStartedAtRef.current = null;
    speechStartedAtByRowRef.current.clear();
    sourceDisplayMeasuredRowsRef.current.clear();
    translationDisplayMeasuredRowsRef.current.clear();
    pendingFinalizationLatencyRef.current = null;
    resetBrowserLatencyMeasurements();
    sessionStartedAtRef.current = Date.now();
    const startAbortScope = createConnectionAbortScope(
      undefined,
      CONNECTION_TIMEOUT_MS,
    );
    startAbortScopeRef.current = startAbortScope;
    const { signal } = startAbortScope;

    try {
      const sourceStream = await withAbortCleanup(
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
        signal,
        (lateStream) => lateStream.getTracks().forEach((track) => track.stop()),
      );
      if (signal.aborted) return;
      sourceStreamRef.current = sourceStream;

      transcriptionClockOffsetRef.current = Math.max(
        0,
        Date.now() - sessionStartedAtRef.current,
      );
      const transcriptionPromise = connectTranscription({
        sourceStream,
        signal,
        onEvent: (event) => {
          if (!signal.aborted) handleTranscriptionEvent(event);
        },
        onConnectionState: (state) => {
          if (state === "failed" && !signal.aborted) {
            failSession("Realtime文字起こしとの接続が切れました。");
          }
        },
      }).then((connection) => {
        if (signal.aborted) {
          connection.close();
          return;
        }
        transcriptionConnectionRef.current = connection;
      });
      const translationPromise = connectTranslationSessions(
        sourceStream,
        signal,
      );
      await Promise.all([transcriptionPromise, translationPromise]);

      if (signal.aborted || startAbortScopeRef.current !== startAbortScope) return;
      startAbortScope.clearDeadline();
      if (!transcriptionConnectionRef.current?.clear()) {
        throw new Error("Realtime文字起こしを開始できませんでした。");
      }
      pendingTranslationsRef.current.clear();
      translationCandidatesRef.current.clear();
      startLocalVad(sourceStream);
      setApiConfigured(true);
      liveRef.current = true;
      setConnectionStatus("live");
      setIsListening(true);
    } catch (error) {
      if (startAbortScopeRef.current !== startAbortScope) return;
      if (
        error instanceof DOMException &&
        error.name === "AbortError" &&
        signal.reason instanceof DOMException &&
        signal.reason.name === "AbortError"
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : "接続を開始できませんでした。";
      failSession(message);
      if (message.includes("OPENAI_API_KEY")) {
        setApiConfigured(false);
        setConnectionStatus("idle");
      }
    }
  };

  const stopConversation = () => {
    if (stoppingRef.current) return;
    setIsListening(false);
    setConnectionStatus("idle");
    if (!liveRef.current) {
      closeRealtimeResources();
      return;
    }

    stoppingRef.current = true;
    syncAudioOutputs();
    stopLocalVad();
    sourceStreamRef.current?.getTracks().forEach((track) => track.stop());
    sourceStreamRef.current = null;
    const activeRowId = activeRowIdRef.current;
    if (activeRowId) {
      commitTranscriptionRow(activeRowId);
      finalizeRow(activeRowId);
    }
    if (finalizeTimerRef.current !== null) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
    for (const timer of emptyRowCleanupTimersRef.current.values()) window.clearTimeout(timer);
    emptyRowCleanupTimersRef.current.clear();

    const scope = startAbortScopeRef.current;
    translationsDrainedRef.current = false;
    const finish = (deadlineReached = false) => {
      if (!stoppingRef.current || startAbortScopeRef.current !== scope) return;
      const pendingSource = rowsRef.current.some((row) => (
        (committedTranscriptionRowsRef.current.has(row.id) ||
          transcriptionRowItemsRef.current.has(row.id)) &&
        row.sourceStatus !== "completed"
      ));
      if (!deadlineReached && (pendingSource || !translationsDrainedRef.current)) return;
      closeRealtimeResources();
      for (const row of [...rowsRef.current]) discardEmptyRow(row.id, true);
    };
    finishStopRef.current = () => finish();
    stopDrainTimerRef.current = window.setTimeout(() => finish(true), STOP_DRAIN_TIMEOUT_MS);
    void Promise.all(translationConnectionsRef.current.map((connection) => (
      connection.drain(STOP_DRAIN_TIMEOUT_MS)
    ))).then(() => {
      if (startAbortScopeRef.current !== scope || !stoppingRef.current) return;
      translationsDrainedRef.current = true;
      finish();
    });
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
