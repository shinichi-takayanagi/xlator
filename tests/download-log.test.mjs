import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadContent, formatSrtTimestamp } from "../lib/download-log.ts";

const rows = [
  {
    id: "1",
    sequence: 1,
    at: "00:01",
    sourceLanguage: "ja",
    startMs: 1250,
    endMs: 2800,
    ja: "こんにちは、\"世界\"",
    en: "Hello, world",
  },
];

test("formats SRT timestamps and bilingual subtitles", () => {
  assert.equal(formatSrtTimestamp(3_661_234), "01:01:01,234");
  const { content, mime } = createDownloadContent(rows, "srt");
  assert.equal(mime, "text/plain");
  assert.match(content, /00:00:01,250 --> 00:00:02,800/);
  assert.match(content, /こんにちは、"世界"\nHello, world/);
});

test("escapes CSV and preserves the aligned row", () => {
  const { content, mime } = createDownloadContent(rows, "csv");
  assert.equal(mime, "text/csv");
  assert.match(content, /"こんにちは、""世界"""/);
  assert.match(content, /"ja","こんにちは/);
});

test("creates readable text and structured JSON", () => {
  const text = createDownloadContent(rows, "txt").content;
  assert.match(text, /^## 日本語ログ/m);
  assert.match(text, /^## 英語ログ/m);

  const json = JSON.parse(createDownloadContent(rows, "json").content);
  assert.deepEqual(json, rows);
});

test("creates an aligned Markdown table and escapes cell content", () => {
  const markdownRows = [{
    ...rows[0],
    ja: "こんにちは | <世界>\n続き",
    en: "Hello | world\ncontinued",
  }];

  const { content, mime } = createDownloadContent(markdownRows, "md");

  assert.equal(mime, "text/markdown");
  assert.match(content, /^# xlator conversation log/m);
  assert.match(content, /\| # \| Time \| Source \| Japanese \| English \|/);
  assert.match(content, /\| 1 \| 00:01 \| ja \| こんにちは \\\| &lt;世界&gt;<br>続き \| Hello \\\| world<br>continued \|/);
});
