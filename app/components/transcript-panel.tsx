"use client";

import { memo, useLayoutEffect, useRef } from "react";
import type { Language, Utterance } from "@/lib/translation-types";
import { getTranscriptDisplay, hasSameTranscriptDisplay, type TranscriptCommit } from "@/lib/transcript-display";
import { Waveform } from "./ui-icons";

const TranscriptRow = memo(function TranscriptRow({
  language,
  row,
  isLatest,
  onCommit,
}: {
  language: Language;
  row: Utterance;
  isLatest: boolean;
  onCommit?: (commit: TranscriptCommit) => void;
}) {
  const display = getTranscriptDisplay(row, language);
  const { text, kind, sourceFinal } = display;
  useLayoutEffect(() => {
    if (text.trim() && kind) {
      onCommit?.({ rowId: row.id, sequence: row.sequence, kind, language, sourceFinal });
    }
  }, [kind, language, onCommit, row.id, row.sequence, sourceFinal, text]);
  return (
    <article className={`transcript-row ${isLatest ? "is-latest" : ""} ${row.status === "draft" ? "is-draft" : ""}`}>
      <div className="row-meta">
        <span className="row-number">{String(row.sequence).padStart(2, "0")}</span>
        <time>{row.at}</time>
        <span className={`source-tag source-${row.sourceLanguage}`}>
          {display.label}
        </span>
      </div>
      <p lang={display.textLanguage}>{display.text || "…"}</p>
    </article>
  );
}, (previous, next) => previous.language === next.language &&
  previous.isLatest === next.isLatest && previous.onCommit === next.onCommit &&
  hasSameTranscriptDisplay(previous.row, next.row, next.language));

export const TranscriptPanel = memo(function TranscriptPanel({
  language,
  rows,
  onCommit,
}: {
  language: Language;
  rows: Utterance[];
  onCommit?: (commit: TranscriptCommit) => void;
}) {
  const isJapanese = language === "ja";
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [rows]);

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
              onCommit={onCommit}
            />
          ))
        )}
      </div>
    </section>
  );
}, (previous, next) => previous.language === next.language &&
  previous.onCommit === next.onCommit && previous.rows.length === next.rows.length &&
  previous.rows.every((row, index) => hasSameTranscriptDisplay(row, next.rows[index], next.language)));
