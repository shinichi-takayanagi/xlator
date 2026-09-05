"use client";

import { memo, useLayoutEffect, useRef } from "react";
import type { Language, Utterance } from "@/lib/translation-types";
import { Waveform } from "./ui-icons";

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

export function TranscriptPanel({
  language,
  rows,
}: {
  language: Language;
  rows: Utterance[];
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
            />
          ))
        )}
      </div>
    </section>
  );
}
