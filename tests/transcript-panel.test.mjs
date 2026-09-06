import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, Fragment } from "react";
import { TranscriptPanel } from "../app/components/transcript-panel.tsx";
import { mountConversation } from "./support/conversation-harness.mjs";

const delta = (text) => ({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: text });
const complete = (text) => ({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: text });
const panels = (session) => createElement(Fragment, null,
  ...["ja", "en"].map((language) => createElement(TranscriptPanel, {
    key: language, language, rows: session.rows, onCommit: session.onTranscriptCommit,
  })));
const list = (language) => document.querySelector(`[data-testid='${language}-transcript-list']`);

test("mounted panels keep unchanged-side scroll and measure only committed visible text", async (t) => {
  const h = await mountConversation(t, panels);
  await h.start();
  await h.speech();
  await h.advance(100);
  await h.event(delta("こんにちは"));
  const japanese = list("ja");
  const english = list("en");
  Object.defineProperty(japanese, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(english, "scrollHeight", { value: 600, configurable: true });
  japanese.scrollTop = 21;
  english.scrollTop = 31;
  await h.advance(50);
  await act(async () => h.translations.find((connection) => connection.targetLanguage === "en").onEvent("en", {
    type: "session.output_transcript.delta", delta: "Hello", elapsed_ms: 150,
  }));
  assert.equal(japanese.scrollTop, 21, "opposite-side text must not scroll the source panel");
  assert.equal(english.scrollTop, 600);
  assert.equal(english.querySelector("p").textContent, "Hello");
  assert.equal(japanese.querySelector("p").textContent, "こんにちは");
  assert.equal(window.__xlatorLatency.filter((record) => record.metric === "speech-to-source-dom").length, 1);
  assert.equal(window.__xlatorLatency.filter((record) => record.metric === "speech-to-translation-dom").length, 1);
  await h.silence();
  await h.advance(450);
  await h.end();
  assert.equal(h.session.rows[0].status, "draft", "acoustic end does not complete the source");
  assert.equal(window.__xlatorLatency.some((record) => record.metric === "source-completed-to-dom"), false);
  await h.advance(100);
  await h.event(complete("こんにちは"));
  assert.equal(h.session.rows[0].status, "final");
  assert.equal(japanese.querySelector(".source-tag").textContent, "原文");
  assert.equal(japanese.querySelector(".is-draft"), null);
  assert.equal(window.__xlatorLatency.filter((record) => record.metric === "source-completed-to-dom").length, 1);
});

test("mounted numeric source remains visible without fabricating VAD latency", async (t) => {
  const h = await mountConversation(t, panels);
  await h.start();
  await h.advance(100);
  await h.event(delta("123"));
  assert.equal(list("ja").querySelector("p").textContent, "123");
  assert.equal(list("ja").querySelector("p").hasAttribute("lang"), false);
  assert.equal(list("en").querySelector("p").textContent, "…");
  assert.equal(h.session.rows[0].ja, "");
  assert.equal(h.session.rows[0].en, "");
  await h.advance(20);
  await h.event(complete("123"));
  assert.equal(list("ja").querySelector(".source-tag").textContent, "原文・言語不明");
  assert.equal(window.__xlatorLatency.some((record) => record.metric.startsWith("speech-to-")), false);
  assert.equal(window.__xlatorLatency.filter((record) => record.metric === "source-completed-to-dom").length, 1);
});

for (const boundary of ["watchdog", "stop"]) {
  test(`mounted ${boundary} during observed silence records acoustic end once`, async (t) => {
    const h = await mountConversation(t, panels);
    await h.start();
    await h.speech();
    await h.advance(100);
    await h.event(delta("Hello"));
    await h.silence();
    if (boundary === "watchdog") await h.advance(1_200);
    else {
      await h.advance(200);
      await h.stop();
    }
    assert.deepEqual(window.__xlatorLatency.filter((record) => record.metric === "silence-to-speech-end"), [
      { sequence: 1, metric: "silence-to-speech-end", durationMs: boundary === "watchdog" ? 1_200 : 200 },
    ]);
    await h.advance(100);
    await h.event(complete("Hello"));
    assert.equal(window.__xlatorLatency.filter((record) => record.metric === "silence-to-source-completed").length, 1);
    assert.equal(window.__xlatorLatency.filter((record) => record.metric === "source-completed-to-dom").length, 1);
  });
}

test("mounted buffered translation measures from its original receipt before row creation", async (t) => {
  const h = await mountConversation(t, panels);
  await h.start();
  await act(async () => h.translations.find((connection) => connection.targetLanguage === "en").onEvent("en", {
    type: "session.output_transcript.delta", delta: "Hello", elapsed_ms: 0,
  }));
  await h.advance(100);
  await h.speech();
  await h.advance(200);
  await h.event(delta("こんにちは"));
  assert.equal(list("en").querySelector("p").textContent, "Hello");
  assert.deepEqual(window.__xlatorLatency.filter((record) => record.metric === "translation-receipt-to-adoption"), [
    { sequence: 1, metric: "translation-receipt-to-adoption", durationMs: 300 },
  ]);
  assert.equal(window.__xlatorLatency.some((record) => record.metric === "speech-to-translation-receipt"), false);
});
