"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TranscriptPanel } from "@/app/components/transcript-panel";
import { GitHubIcon, Icon, Waveform } from "@/app/components/ui-icons";
import { DEMO_UTTERANCES } from "@/lib/demo-utterances";
import { createDownloadContent, type DownloadFormat } from "@/lib/download-log";
import {
  connectTranslation,
  prefetchTranslationClientSecrets,
  type TranslationConnection,
  type TranslationEvent,
} from "@/lib/realtime-translation";
import { getVadSilenceDurationMs } from "@/lib/local-vad";
import type { Language, TargetLanguage, Utterance } from "@/lib/translation-types";
import {
  detectLanguage,
  findLastRowStartingAtOrBefore,
  replaceRow,
  selectSourceSession,
  type SourceCandidates,
} from "@/lib/utterance-alignment";

type AudioMode = "off" | "ja" | "en" | "auto";
type ConnectionStatus = "idle" | "connecting" | "live" | "error";

const FALLBACK_FINALIZE_MS = 1_200;
const VAD_MIN_RMS = 0.012;
const VAD_NOISE_MULTIPLIER = 2.5;

const AUDIO_MODES: { id: AudioMode; label: string }[] = [
  { id: "off", label: "再生しない" },
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
  { id: "auto", label: "自動" },
];

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function toEventElapsed(event: TranslationEvent, fallback: number) {
  return typeof event.elapsed_ms === "number" ? event.elapsed_ms : fallback;
}

export default function Home() {
  const [isListening, setIsListening] = useState(false);
  const [rows, setRows] = useState<Utterance[]>(DEMO_UTTERANCES);
  const [elapsed, setElapsed] = useState(91);
  const [audioMode, setAudioMode] = useState<AudioMode>("off");
  const [downloadOpen, setDownloadOpen] = useState(false);
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
  const vadAudioContextRef = useRef<AudioContext | null>(null);
  const vadAnimationFrameRef = useRef<number | null>(null);
  const vadSpeechDetectedRef = useRef(false);
  const vadSilenceStartedAtRef = useRef<number | null>(null);
  const vadNoiseFloorRef = useRef(0.01);
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

  const stopLocalVad = useCallback(() => {
    if (vadAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(vadAnimationFrameRef.current);
    }
    vadAnimationFrameRef.current = null;
    const audioContext = vadAudioContextRef.current;
    vadAudioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
    vadSpeechDetectedRef.current = false;
    vadSilenceStartedAtRef.current = null;
    vadNoiseFloorRef.current = 0.01;
    activeSourceTextRef.current = "";
  }, []);

  const startLocalVad = useCallback((sourceStream: MediaStream) => {
    stopLocalVad();
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(sourceStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    vadAudioContextRef.current = audioContext;

    const sampleVoiceActivity = (now: number) => {
      analyser.getFloatTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) sumSquares += sample * sample;
      const rms = Math.sqrt(sumSquares / samples.length);
      const speechThreshold = Math.max(
        VAD_MIN_RMS,
        vadNoiseFloorRef.current * VAD_NOISE_MULTIPLIER,
      );

      if (rms >= speechThreshold) {
        if (!vadSpeechDetectedRef.current) {
          lastSourceLanguageRef.current = "unknown";
          queueMicrotask(syncAudioOutputs);
        }
        vadSpeechDetectedRef.current = true;
        vadSilenceStartedAtRef.current = null;
      } else {
        vadNoiseFloorRef.current += (rms - vadNoiseFloorRef.current) * 0.05;
        if (vadSpeechDetectedRef.current) {
          vadSilenceStartedAtRef.current ??= now;
          const silenceDurationMs = getVadSilenceDurationMs(
            activeSourceTextRef.current,
          );
          if (now - vadSilenceStartedAtRef.current >= silenceDurationMs) {
            finalizeCurrentRow();
            vadSpeechDetectedRef.current = false;
            vadSilenceStartedAtRef.current = null;
          }
        }
      }

      vadAnimationFrameRef.current = window.requestAnimationFrame(sampleVoiceActivity);
    };

    vadAnimationFrameRef.current = window.requestAnimationFrame(sampleVoiceActivity);
  }, [finalizeCurrentRow, stopLocalVad, syncAudioOutputs]);

  const handleSourceDelta = (targetLanguage: TargetLanguage, event: TranslationEvent) => {
    if (!event.delta) return;
    vadSpeechDetectedRef.current = true;
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

  const statusLabel = connectionStatus === "connecting"
    ? "接続中"
    : connectionStatus === "live"
      ? "リスニング中"
      : connectionStatus === "error"
        ? "接続エラー"
        : apiConfigured === false
          ? "APIキー未設定"
          : "待機中";

  const download = (format: DownloadFormat) => {
    const { content, mime } = createDownloadContent(rows, format);

    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `xlator-log.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloadOpen(false);
  };

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="xlator ホーム">
          <span className="brand-mark"><span>あ</span><span>A</span></span>
          <span>xlator</span>
        </a>
        <div className="header-meta">
          <span className="realtime-badge">REALTIME</span>
          <span className="local-label"><span className="local-dot" /> localhost</span>
          <a
            className="github-link"
            href="https://github.com/shinichi-takayanagi/xlator"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHubでリポジトリを開く"
          >
            <GitHubIcon />
          </a>
        </div>
      </header>

      <div className="workspace" id="top">
        <section className="control-bar" aria-label="録音コントロール">
          <div className="primary-controls">
            <button className="start-button" onClick={startConversation} disabled={isListening || connectionStatus === "connecting"}>
              <Icon name="mic" />
              <span><strong>会話を開始</strong><small>マイクを使用</small></span>
            </button>
            <button className="stop-button" onClick={stopConversation} disabled={!isListening && connectionStatus !== "connecting"} aria-label="停止">
              <Icon name="stop" />
            </button>
          </div>

          <div className="session-status" aria-live="polite">
            <div className="session-copy">
              <span className={`status-dot ${isListening ? "is-live" : ""}`} />
              <span>{statusLabel}</span>
            </div>
            <Waveform active={isListening} />
            <span className="elapsed">{formatElapsed(elapsed)}</span>
          </div>

          <div className="audio-control">
            <div className="control-label"><Icon name="volume" /><span>翻訳音声</span></div>
            <div className="segmented-control" aria-label="翻訳音声の言語">
              {AUDIO_MODES.map((mode) => (
                <button key={mode.id} className={audioMode === mode.id ? "is-selected" : ""} onClick={() => setAudioMode(mode.id)} aria-pressed={audioMode === mode.id}>
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className="download-wrap">
            <button className="download-button" onClick={() => setDownloadOpen((value) => !value)} aria-expanded={downloadOpen}>
              <Icon name="download" /><span>ダウンロード</span><Icon name="chevron" />
            </button>
            {downloadOpen && (
              <div className="download-menu">
                {(["txt", "csv", "json", "srt"] as const).map((format) => (
                  <button key={format} onClick={() => download(format)}><span>.{format}</span><small>{format === "txt" ? "読みやすいログ" : format === "srt" ? "字幕データ" : "構造化データ"}</small></button>
                ))}
              </div>
            )}
          </div>
        </section>

        <div className="log-stack">
          <TranscriptPanel language="ja" rows={rows} />
          <TranscriptPanel language="en" rows={rows} />
        </div>

        {errorMessage && (
          <div className="error-toast" role="alert">
            <strong>接続できませんでした</strong>
            <span>{errorMessage}</span>
            {apiConfigured === false && <code>OPENAI_API_KEY</code>}
            <button onClick={() => setErrorMessage("")} aria-label="エラーを閉じる">×</button>
          </div>
        )}
      </div>
    </main>
  );
}
