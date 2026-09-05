import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { mountConversation } from "./support/conversation-harness.mjs";

async function output(h, targetLanguage, delta, elapsed_ms) {
  const connection = h.translations.find((candidate) => candidate.targetLanguage === targetLanguage);
  await act(async () => connection.onEvent(targetLanguage, {
    type: "session.output_transcript.delta", delta, elapsed_ms,
  }));
}

for (const [language, nextSource] of [["Japanese", "次の発話"], ["English", "Next turn"]]) {
  test(`mounted hook keeps late translation on A while B speaks ${language}`, async (t) => {
    const h = await mountConversation(t);
    await h.start();
    await h.speech();
    await h.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "最初の発話" });
    await h.advance(1_000);
    await h.silence();
    await h.advance(450);
    await h.end();
    assert.equal(h.session.rows[0].status, "draft");
    assert.equal(h.session.rows[0].speechEndMs, 1_000);
    await h.speech();
    await h.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "b", delta: nextSource });
    await output(h, "en", "First", 500);
    await output(h, "en", " turn.", undefined);
    assert.equal(h.session.rows[0].ja, "最初の発話");
    assert.equal(h.session.rows[0].en, "First turn.");
    assert.equal(h.session.rows[1].en, nextSource === "Next turn" ? nextSource : "");
    assert.equal(h.session.rows[1].ja, nextSource === "Next turn" ? "" : nextSource);
  });
}

test("mounted hook preserves pre-row target candidates until source becomes known", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await output(h, "en", "Hello", 0);
  await output(h, "ja", "こんにちは", 0);
  assert.equal(h.session.rows.length, 0);
  await h.advance(100);
  await h.speech();
  assert.equal(h.session.rows[0].ja, "");
  assert.equal(h.session.rows[0].en, "");
  await h.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "こんにちは。" });
  assert.equal(h.session.rows[0].ja, "こんにちは。");
  assert.equal(h.session.rows[0].en, "Hello");
});
