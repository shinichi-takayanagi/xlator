import type { Utterance } from "./translation-types";

export type DownloadFormat = "txt" | "csv" | "json" | "srt";

function escapeCsv(value: string | number) {
  const text = String(value).replaceAll('"', '""');
  return `"${text}"`;
}

export function formatSrtTimestamp(milliseconds: number) {
  const totalMs = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const remainder = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

export function createDownloadContent(rows: Utterance[], format: DownloadFormat) {
  if (format === "json") {
    return {
      content: JSON.stringify(rows, null, 2),
      mime: "application/json",
    };
  }

  if (format === "csv") {
    return {
      content: [
        ["sequence", "time", "source_language", "japanese", "english"].map(escapeCsv).join(","),
        ...rows.map((row) => [row.sequence, row.at, row.sourceLanguage, row.ja, row.en].map(escapeCsv).join(",")),
      ].join("\n"),
      mime: "text/csv",
    };
  }

  if (format === "srt") {
    return {
      content: rows.map((row, index) => {
        const startMs = row.startMs ?? index * 4000;
        const endMs = Math.max(startMs + 500, row.endMs ?? startMs + 3500);
        return `${index + 1}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${row.ja}\n${row.en}`;
      }).join("\n\n"),
      mime: "text/plain",
    };
  }

  return {
    content: `## 日本語ログ\n${rows.map((row) => row.ja).join("\n")}\n\n## 英語ログ\n${rows.map((row) => row.en).join("\n")}`,
    mime: "text/plain",
  };
}
