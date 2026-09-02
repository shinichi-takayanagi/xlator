"use client";

import { useState } from "react";
import { Icon, Waveform } from "@/app/components/ui-icons";
import type { AudioMode, ConnectionStatus } from "@/app/hooks/use-conversation-session";
import { createDownloadContent, type DownloadFormat } from "@/lib/download-log";
import type { Utterance } from "@/lib/translation-types";

const AUDIO_MODES: { id: AudioMode; label: string }[] = [
  { id: "off", label: "再生しない" },
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
  { id: "auto", label: "自動" },
];

const DOWNLOAD_OPTIONS: { format: DownloadFormat; description: string }[] = [
  { format: "txt", description: "読みやすいログ" },
  { format: "md", description: "Markdown表" },
  { format: "csv", description: "構造化データ" },
  { format: "json", description: "構造化データ" },
  { format: "srt", description: "字幕データ" },
];

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function getStatusLabel(
  connectionStatus: ConnectionStatus,
  apiConfigured: boolean | null,
) {
  if (connectionStatus === "connecting") return "接続中";
  if (connectionStatus === "live") return "リスニング中";
  if (connectionStatus === "error") return "接続エラー";
  if (apiConfigured === false) return "APIキー未設定";
  return "待機中";
}

type ConversationControlsProps = {
  apiConfigured: boolean | null;
  audioMode: AudioMode;
  connectionStatus: ConnectionStatus;
  elapsed: number;
  isListening: boolean;
  rows: Utterance[];
  onAudioModeChange: (mode: AudioMode) => void;
  onStart: () => Promise<void>;
  onStop: () => void;
};

export function ConversationControls({
  apiConfigured,
  audioMode,
  connectionStatus,
  elapsed,
  isListening,
  rows,
  onAudioModeChange,
  onStart,
  onStop,
}: ConversationControlsProps) {
  const [downloadOpen, setDownloadOpen] = useState(false);
  const statusLabel = getStatusLabel(connectionStatus, apiConfigured);

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
    <section className="control-bar" aria-label="録音コントロール">
      <div className="primary-controls">
        <button
          className="start-button"
          onClick={() => void onStart()}
          disabled={isListening || connectionStatus === "connecting"}
        >
          <Icon name="mic" />
          <span><strong>会話を開始</strong><small>マイクを使用</small></span>
        </button>
        <button
          className="stop-button"
          onClick={onStop}
          disabled={!isListening && connectionStatus !== "connecting"}
          aria-label="停止"
        >
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
            <button
              key={mode.id}
              className={audioMode === mode.id ? "is-selected" : ""}
              onClick={() => onAudioModeChange(mode.id)}
              aria-pressed={audioMode === mode.id}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <div className="download-wrap">
        <button
          className="download-button"
          onClick={() => setDownloadOpen((value) => !value)}
          aria-expanded={downloadOpen}
        >
          <Icon name="download" /><span>ダウンロード</span><Icon name="chevron" />
        </button>
        {downloadOpen && (
          <div className="download-menu">
            {DOWNLOAD_OPTIONS.map(({ format, description }) => (
              <button key={format} onClick={() => download(format)}>
                <span>.{format}</span>
                <small>{description}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
