"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalVad } from "@/app/hooks/use-local-vad";
import { DEMO_UTTERANCES } from "@/lib/demo-utterances";
import {
  connectTranslation,
  prefetchTranslationClientSecrets,
  type TranslationConnection,
  type TranslationEvent,
} from "@/lib/realtime-translation";
import type { Language, TargetLanguage, Utterance } from "@/lib/translation-types";
import {
  detectLanguage,
  findLastRowStartingAtOrBefore,
  replaceRow,
  selectSourceSession,
  type SourceCandidates,
} from "@/lib/utterance-alignment";

export type AudioMode = "off" | "ja" | "en" | "auto";
export type ConnectionStatus = "idle" | "connecting" | "live" | "error";

const FALLBACK_FINALIZE_MS = 1_200;

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function toEventElapsed(event: TranslationEvent, fallback: number) {
  return typeof event.elapsed_ms === "number" ? event.elapsed_ms : fallback;
}

export function useConversationSession() {
  const [isListening, setIsListening] = useState(false);
  const [rows, setRows] = useState<Utterance[]>(DEMO_UTTERANCES);
  const [elapsed, setElapsed] = useState(91);
  const [audioMode, setAudioMode] = useState<AudioMode>("off");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const connectionsRef = useRef<TranslationConnection[]>([]);
  const startAbortControllerRef = useRef<AbortController | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const activeRowIdRef = useRef<string | null>(null);
  const sourceCandidatesRef = useRef<Record<string, SourceCandidates>>({});
  const selectedSourceSessionRef = useRef<Record<string, TargetLanguage>>({});
  const finalizeTimerRef = useRef<number | null>(null);
  const activeSourceTextRef = useRef("");
  const sessionStartedAtRef = useRef(0);
  const lastSourceLanguageRef = useRef<Language | "unknown">("unknown");
  const audioModeRef = useRef<AudioMode>("off");

  useEffect(() => {
    if (!isListening) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
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
    void prefetchTranslationClientSecrets().catch(() => undefined);
  }, [apiConfigured]);

  const syncAudioOutputs = useCallback(() => {
    const mode = audioModeRef.current;
    const sourceLanguage = lastSourceLanguageRef.current;

    for (const connection of connectionsRef.current) {
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

  useEffect(() => {
    audioModeRef.current = audioMode;
    syncAudioOutputs();
  }, [audioMode, syncAudioOutputs]);

  const finalizeCurrentRow = useCallback(() => {
    const activeId = activeRowIdRef.current;
    if (!activeId) return;
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
    setRows((current) => current.map((row) => (
      row.id === activeId ? { ...row, status: "final" as const } : row
    )));
    activeRowIdRef.current = null;
    activeSourceTextRef.current = "";
  }, []);

  const getActiveSourceText = useCallback(() => activeSourceTextRef.current, []);
  const handleVadSpeechStart = useCallback(() => {
    lastSourceLanguageRef.current = "unknown";
    queueMicrotask(syncAudioOutputs);
  }, [syncAudioOutputs]);

  const {
    markSpeechDetected,
    startLocalVad,
    stopLocalVad,
  } = useLocalVad({
    getActiveSourceText,
    onSpeechStart: handleVadSpeechStart,
    onSpeechEnd: finalizeCurrentRow,
  });

  const handleSourceDelta = (targetLanguage: TargetLanguage, event: TranslationEvent) => {
    if (!event.delta) return;
    markSpeechDetected();
    const elapsedMs = toEventElapsed(
      event,
      Math.max(0, Date.now() - sessionStartedAtRef.current),
    );

    setRows((current) => {
      const activeIndex = current.findIndex((row) => row.id === activeRowIdRef.current);
      let index = activeIndex;
      let next = current;

      if (activeIndex >= 0) {
        const activeStartMs = current[activeIndex].startMs ?? 0;
        if (elapsedMs + 400 < activeStartMs) {
          index = findLastRowStartingAtOrBefore(current, elapsedMs + 400, activeIndex);
        }
      } else if (current.length > 0) {
        const latestIndex = current.length - 1;
        const latest = current[latestIndex];
        const latestEndMs = latest.endMs ?? latest.startMs ?? 0;
        if (elapsedMs <= latestEndMs + 700) index = latestIndex;
      }

      if (index < 0) {
        const id = `live-${Date.now()}-${current.length + 1}`;
        activeRowIdRef.current = id;
        const created: Utterance = {
          id,
          sequence: current.length + 1,
          at: formatElapsed(Math.floor(elapsedMs / 1000)),
          startMs: elapsedMs,
          endMs: elapsedMs,
          sourceLanguage: "unknown",
          sourceText: "",
          ja: "",
          en: "",
          status: "draft",
        };
        next = [...current, created];
        index = next.length - 1;
      }

      const row = next[index];
      const candidates = sourceCandidatesRef.current[row.id] ?? {};
      const previousCandidate = candidates[targetLanguage];
      candidates[targetLanguage] = {
        text: `${previousCandidate?.text ?? ""}${event.delta}`,
        endMs: elapsedMs,
      };
      sourceCandidatesRef.current[row.id] = candidates;

      const selectedSession = selectedSourceSessionRef.current[row.id];
      const bestSession = selectSourceSession(
        candidates,
        selectedSession,
        targetLanguage,
      );
      selectedSourceSessionRef.current[row.id] = bestSession;

      const sourceText = candidates[bestSession]?.text ?? row.sourceText ?? "";
      if (sourceText === (row.sourceText ?? "")) return current;
      activeSourceTextRef.current = sourceText;

      const sourceLanguage = detectLanguage(sourceText);
      if (
        sourceLanguage !== "unknown" &&
        sourceLanguage !== lastSourceLanguageRef.current
      ) {
        lastSourceLanguageRef.current = sourceLanguage;
        queueMicrotask(syncAudioOutputs);
      }

      const updated: Utterance = {
        ...row,
        sourceText,
        sourceLanguage,
        endMs: Math.max(row.endMs ?? 0, candidates[bestSession]?.endMs ?? elapsedMs),
        status: row.id === activeRowIdRef.current ? "draft" : row.status,
        ja: sourceLanguage === "ja" ? sourceText : row.ja,
        en: sourceLanguage === "en" ? sourceText : row.en,
      };

      return replaceRow(next, index, updated);
    });

    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = window.setTimeout(
      finalizeCurrentRow,
      FALLBACK_FINALIZE_MS,
    );
  };

  const handleOutputDelta = (targetLanguage: TargetLanguage, event: TranslationEvent) => {
    if (!event.delta) return;
    const elapsedMs = toEventElapsed(
      event,
      Math.max(0, Date.now() - sessionStartedAtRef.current),
    );

    setRows((current) => {
      if (current.length === 0) return current;
      let index = findLastRowStartingAtOrBefore(current, elapsedMs + 400);
      if (index < 0) index = current.length - 1;

      const row = current[index];
      if (row.sourceLanguage === targetLanguage) return current;
      const updated = { ...row, [targetLanguage]: `${row[targetLanguage]}${event.delta}` };
      return replaceRow(current, index, updated);
    });
  };

  const handleTranslationEvent = (targetLanguage: TargetLanguage, event: TranslationEvent) => {
    if (event.type === "session.input_transcript.delta") {
      handleSourceDelta(targetLanguage, event);
    } else if (event.type === "session.output_transcript.delta") {
      handleOutputDelta(targetLanguage, event);
    } else if (event.type === "error") {
      setErrorMessage(event.error?.message ?? "Realtime処理中にエラーが発生しました。");
      setConnectionStatus("error");
    }
  };

  const closeRealtimeResources = useCallback(() => {
    startAbortControllerRef.current?.abort();
    startAbortControllerRef.current = null;
    stopLocalVad();
    activeSourceTextRef.current = "";
    for (const connection of connectionsRef.current) connection.close();
    connectionsRef.current = [];
    sourceStreamRef.current?.getTracks().forEach((track) => track.stop());
    sourceStreamRef.current = null;
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = null;
  }, [stopLocalVad]);

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
    activeRowIdRef.current = null;
    sourceCandidatesRef.current = {};
    selectedSourceSessionRef.current = {};
    lastSourceLanguageRef.current = "unknown";
    activeSourceTextRef.current = "";
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

      const results = await Promise.allSettled(
        (["en", "ja"] as const).map((targetLanguage) => connectTranslation({
          targetLanguage,
          sourceStream,
          muted: true,
          signal: startAbortController.signal,
          onEvent: handleTranslationEvent,
          onConnectionState: (_language, state) => {
            if (state === "failed" && !startAbortController.signal.aborted) {
              closeRealtimeResources();
              setConnectionStatus("error");
              setErrorMessage("Realtimeとの接続が切れました。");
              setIsListening(false);
            }
          },
        })),
      );

      const liveConnections = results.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      const failed = results.find((result) => result.status === "rejected");

      if (startAbortController.signal.aborted) {
        liveConnections.forEach((connection) => connection.close());
        return;
      }

      if (failed?.status === "rejected") {
        liveConnections.forEach((connection) => connection.close());
        throw failed.reason;
      }

      connectionsRef.current = liveConnections;
      syncAudioOutputs();
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
