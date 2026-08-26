"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  connectTranslation,
  prefetchTranslationClientSecrets,
  type TargetLanguage,
  type TranslationConnection,
  type TranslationEvent,
} from "@/lib/realtime-translation";
import { getVadSilenceDurationMs } from "@/lib/local-vad";

type Language = "ja" | "en";
type AudioMode = "off" | "ja" | "en" | "auto";
type ConnectionStatus = "idle" | "connecting" | "live" | "error";

type Utterance = {
  id: string;
  sequence: number;
  at: string;
  sourceLanguage: Language | "unknown";
  sourceText?: string;
  startMs?: number;
  endMs?: number;
  status?: "draft" | "final";
  ja: string;
  en: string;
};

type SourceCandidate = {
  text: string;
  endMs: number;
};

type SourceCandidates = Partial<Record<TargetLanguage, SourceCandidate>>;

const FALLBACK_FINALIZE_MS = 1_200;
const VAD_MIN_RMS = 0.012;
const VAD_NOISE_MULTIPLIER = 2.5;

const DEMO_UTTERANCES: Utterance[] = [
  {
    id: "demo-1",
    sequence: 1,
    at: "00:03",
    sourceLanguage: "ja",
    ja: "こんちわ、今日は暑いですね",
    en: "Hello, it is hot today",
  },
  {
    id: "demo-2",
    sequence: 2,
    at: "00:08",
    sourceLanguage: "en",
    ja: "ええ、とてもあつね",
    en: "YES, too hot!",
  },
  {
    id: "demo-3",
    sequence: 3,
    at: "00:12",
    sourceLanguage: "ja",
    ja: "元気ですか？",
    en: "How are you?",
  },
  {
    id: "demo-4",
    sequence: 4,
    at: "00:16",
    sourceLanguage: "en",
    ja: "はい、元気です！",
    en: "Yep, I'm fine",
  },
  {
    id: "demo-5",
    sequence: 5,
    at: "00:22",
    sourceLanguage: "ja",
    ja: "週末は何をする予定ですか？",
    en: "What are you planning to do this weekend?",
  },
  {
    id: "demo-6",
    sequence: 6,
    at: "00:28",
    sourceLanguage: "en",
    ja: "友達と海に行くつもりです。",
    en: "I'm going to the beach with some friends.",
  },
  {
    id: "demo-7",
    sequence: 7,
    at: "00:34",
    sourceLanguage: "ja",
    ja: "いいですね。どこの海ですか？",
    en: "That sounds nice. Which beach are you going to?",
  },
  {
    id: "demo-8",
    sequence: 8,
    at: "00:41",
    sourceLanguage: "en",
    ja: "まだ決めていません。天気次第ですね。",
    en: "We haven't decided yet. It depends on the weather.",
  },
  {
    id: "demo-9",
    sequence: 9,
    at: "00:49",
    sourceLanguage: "ja",
    ja: "予報では土曜日は晴れるそうです。",
    en: "The forecast says it will be sunny on Saturday.",
  },
  {
    id: "demo-10",
    sequence: 10,
    at: "00:56",
    sourceLanguage: "en",
    ja: "それなら完璧ですね。",
    en: "That would be perfect.",
  },
  {
    id: "demo-11",
    sequence: 11,
    at: "01:02",
    sourceLanguage: "ja",
    ja: "日焼け止めを忘れないでくださいね。",
    en: "Don't forget to bring sunscreen.",
  },
  {
    id: "demo-12",
    sequence: 12,
    at: "01:08",
    sourceLanguage: "en",
    ja: "もちろんです。飲み物もたくさん持っていきます。",
    en: "Of course. We'll bring plenty of water too.",
  },
  {
    id: "demo-13",
    sequence: 13,
    at: "01:16",
    sourceLanguage: "ja",
    ja: "写真を撮ったら、あとで見せてください。",
    en: "Please show me the photos afterward.",
  },
  {
    id: "demo-14",
    sequence: 14,
    at: "01:22",
    sourceLanguage: "en",
    ja: "いいですよ。たくさん撮ってきます。",
    en: "Sure. I'll take lots of them.",
  },
  {
    id: "demo-15",
    sequence: 15,
    at: "01:28",
    sourceLanguage: "ja",
    ja: "では、楽しい週末を！",
    en: "Have a great weekend, then!",
  },
  {
    id: "demo-16",
    sequence: 16,
    at: "01:31",
    sourceLanguage: "en",
    ja: "ありがとう。また月曜日に！",
    en: "Thanks. See you on Monday!",
  },
];

const AUDIO_MODES: { id: AudioMode; label: string }[] = [
  { id: "off", label: "再生しない" },
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
  { id: "auto", label: "自動" },
];

function Waveform({ active }: { active: boolean }) {
  return (
    <span className={`waveform ${active ? "is-active" : ""}`} aria-hidden="true">
      {[7, 12, 18, 10, 22, 15, 8, 19, 12, 7].map((height, index) => (
        <span key={index} style={{ height }} />
      ))}
    </span>
  );
}

function Icon({ name }: { name: "mic" | "stop" | "download" | "volume" | "chevron" }) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19v2h14v-2" /></>,
    volume: <><path d="M5 10v4h4l5 4V6L9 10H5Z" /><path d="M17 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function GitHubIcon() {
  return (
    <svg className="github-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.28-.36 6.72-1.61 6.72-7.05A5.44 5.44 0 0 0 19.28 3.7 5.07 5.07 0 0 0 19.14.2S18 0 15 1.5a13.38 13.38 0 0 0-6 0C6 .2 4.86.2 4.86.2a5.07 5.07 0 0 0-.14 3.5 5.44 5.44 0 0 0-1.44 3.75c0 5.43 3.44 6.68 6.72 7.05A4.8 4.8 0 0 0 9 18v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

const TranscriptRow = memo(function TranscriptRow({
  language,
  row,
  isLatest,
}: {
  language: Language;
  row: Utterance;
  isLatest: boolean;
}) {
  return (
    <article className={`transcript-row ${isLatest ? "is-latest" : ""} ${row.status === "draft" ? "is-draft" : ""}`}>
      <div className="row-meta">
        <span className="row-number">{String(row.sequence).padStart(2, "0")}</span>
        <time>{row.at}</time>
        <span className={`source-tag source-${row.sourceLanguage}`}>
          {row.sourceLanguage === "unknown" ? "処理中" : row.sourceLanguage === language ? "原文" : "翻訳"}
        </span>
      </div>
      <p lang={language}>{row[language] || "…"}</p>
    </article>
  );
});

function TranscriptPanel({ language, rows }: { language: Language; rows: Utterance[] }) {
  const isJapanese = language === "ja";
  const listRef = useRef<HTMLDivElement>(null);
  const latestText = rows.at(-1)?.[language] ?? "";

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [latestText, rows.length]);

  return (
    <section className={`transcript-panel language-${language}`} aria-labelledby={`${language}-heading`}>
      <div className="panel-heading">
        <div className="panel-title">
          <span className="language-mark">{isJapanese ? "JA" : "EN"}</span>
          <h2 id={`${language}-heading`}>{isJapanese ? "日本語ログ" : "English log"}</h2>
        </div>
        <div className="panel-status">
          <span className="latest-badge"><span />最新を表示中</span>
          <span className="panel-count">{rows.length} 発話</span>
        </div>
      </div>

      <div className="transcript-list" ref={listRef} data-testid={`${language}-transcript-list`} aria-live="polite">
        {rows.length === 0 ? (
          <div className="empty-state">
            <Waveform active />
            <p>マイクの音声を待っています…</p>
          </div>
        ) : (
          rows.map((row, index) => (
            <TranscriptRow
              key={`${language}-${row.id}`}
              language={language}
              row={row}
              isLatest={index === rows.length - 1}
            />
          ))
        )}
      </div>
    </section>
  );
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function escapeCsv(value: string | number) {
  const text = String(value).replaceAll('"', '""');
  return `"${text}"`;
}

function formatSrtTimestamp(milliseconds: number) {
  const totalMs = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const remainder = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

function detectLanguage(text: string): Language | "unknown" {
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(text)) return "ja";
  if (/[A-Za-z]/.test(text)) return "en";
  return "unknown";
}

function toEventElapsed(event: TranslationEvent, fallback: number) {
  return typeof event.elapsed_ms === "number" ? event.elapsed_ms : fallback;
}

function findLastRowStartingAtOrBefore(
  rows: Utterance[],
  elapsedMs: number,
  endExclusive = rows.length,
) {
  for (let index = Math.min(endExclusive, rows.length) - 1; index >= 0; index -= 1) {
    if ((rows[index].startMs ?? 0) <= elapsedMs) return index;
  }

  return -1;
}

function replaceRow(rows: Utterance[], index: number, row: Utterance) {
  if (rows[index] === row) return rows;
  const next = rows.slice();
  next[index] = row;
  return next;
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

  const syncAudioOutputs = () => {
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
  };

  useEffect(() => {
    audioModeRef.current = audioMode;
    syncAudioOutputs();
  }, [audioMode]);

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
  }, [finalizeCurrentRow, stopLocalVad]);

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
      let bestSession = selectedSession && candidates[selectedSession]
        ? selectedSession
        : targetLanguage;
      for (const candidateSession of ["en", "ja"] as const) {
        const candidate = candidates[candidateSession];
        const best = candidates[bestSession];
        const isAheadInTime = candidate && best && candidate.endMs > best.endMs + 600;
        if (
          candidate &&
          (!best || candidate.text.length > best.text.length || isAheadInTime)
        ) {
          bestSession = candidateSession;
        }
      }
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

    try {
      const sourceStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      sourceStreamRef.current = sourceStream;
      startLocalVad(sourceStream);

      const results = await Promise.allSettled(
        (["en", "ja"] as const).map((targetLanguage) => connectTranslation({
          targetLanguage,
          sourceStream,
          muted: true,
          onEvent: handleTranslationEvent,
          onConnectionState: (_language, state) => {
            if (state === "failed") {
              setConnectionStatus("error");
              setErrorMessage("Realtimeとの接続が切れました。");
            }
          },
        })),
      );

      const liveConnections = results.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      const failed = results.find((result) => result.status === "rejected");

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

  const download = (format: "txt" | "csv" | "json" | "srt") => {
    let content = "";
    let mime = "text/plain";

    if (format === "json") {
      content = JSON.stringify(rows, null, 2);
      mime = "application/json";
    } else if (format === "csv") {
      content = [
        ["sequence", "time", "source_language", "japanese", "english"].map(escapeCsv).join(","),
        ...rows.map((row) => [row.sequence, row.at, row.sourceLanguage, row.ja, row.en].map(escapeCsv).join(",")),
      ].join("\n");
      mime = "text/csv";
    } else if (format === "srt") {
      content = rows.map((row, index) => {
        const startMs = row.startMs ?? index * 4000;
        const endMs = Math.max(startMs + 500, row.endMs ?? startMs + 3500);
        return `${index + 1}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${row.ja}\n${row.en}`;
      }).join("\n\n");
    } else {
      content = `## 日本語ログ\n${rows.map((row) => row.ja).join("\n")}\n\n## 英語ログ\n${rows.map((row) => row.en).join("\n")}`;
    }

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
