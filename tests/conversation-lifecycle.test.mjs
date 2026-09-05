import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { mountConversation } from "./support/conversation-harness.mjs";

const delta = (item_id, text) => ({ type: "conversation.item.input_audio_transcription.delta", item_id, delta: text });
const complete = (item_id, transcript) => ({ type: "conversation.item.input_audio_transcription.completed", item_id, transcript });

test("continuous speech without transcript survives both former timeout boundaries", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  const rowId = h.session.rows[0].id;
  await h.advance(6_000);
  assert.equal(h.transcription.connection.commit.mock.callCount(), 0);
  assert.equal(h.session.rows[0].id, rowId);
  assert.equal(h.session.rows[0].status, "draft");
  await h.silence();
  await h.advance(450);
  await h.end();
  assert.equal(h.transcription.connection.commit.mock.callCount(), 1);
  assert.equal(h.session.rows[0].speechEndMs, 6_000);
  assert.equal(h.session.rows[0].sourceStatus, "pending");
  assert.equal(h.session.rows[0].status, "draft");
  await h.advance(6_000);
  assert.equal(h.session.rows[0].id, rowId);
  await h.event(complete("a", "Long speech."));
  assert.equal(h.session.rows[0].sourceText, "Long speech.");
  assert.equal(h.session.rows[0].sourceStatus, "completed");
  assert.equal(h.session.rows[0].status, "final");
});

test("silence watchdog cancels on resumed audio and transcript arrival cannot end active speech", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.silence();
  await h.advance(700);
  await h.resume();
  await h.event(delta("a", "hello"));
  await h.advance(2_000);
  assert.equal(h.transcription.connection.commit.mock.callCount(), 0);
  await h.event(complete("a", "Hello."));
  assert.equal(h.session.rows[0].status, "draft");
  assert.equal(h.session.rows[0].sourceText, "Hello.");
  await h.silence();
  await h.advance(1_200);
  assert.equal(h.transcription.connection.commit.mock.callCount(), 1);
  assert.equal(h.session.rows[0].status, "final");
});

test("late source corrections remain on the committed row while another row is active", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.event(delta("a", "helo"));
  await h.silence();
  await h.advance(450);
  await h.end();
  await h.speech();
  const secondId = h.session.rows[1].id;
  await h.event(complete("a", "Hello."));
  assert.equal(h.session.rows[0].sourceText, "Hello.");
  assert.equal(h.session.rows[1].id, secondId);
  assert.equal(h.session.rows[1].status, "draft");
  await h.event(delta("b", "次"));
  await h.event(complete("b", "次"));
  assert.equal(h.session.rows[1].sourceStatus, "completed");
  assert.equal(h.session.rows[1].status, "draft");
});

test("stop before source commits captured speech and receives source plus translation while draining", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.advance(900);
  await h.stop();
  assert.equal(h.tracks[0].stop.mock.callCount(), 1);
  assert.equal(h.stopLocalVad.mock.callCount(), 2);
  assert.equal(h.transcription.connection.commit.mock.callCount(), 1);
  assert.equal(h.transcription.connection.close.mock.callCount(), 0);
  assert.equal(h.session.rows.length, 1);
  await h.event(complete("a", "Hello."));
  const ja = h.translations.find((connection) => connection.targetLanguage === "ja");
  await act(async () => ja.onEvent("ja", { type: "session.output_transcript.delta", elapsed_ms: 900, delta: "こんにちは。" }));
  assert.equal(h.session.rows[0].ja, "こんにちは。");
  assert.equal(h.transcription.connection.close.mock.callCount(), 0);
  await act(async () => h.translations.forEach((connection) => connection.resolveDrain()));
  assert.equal(h.transcription.connection.close.mock.callCount(), 1);
});

test("drain deadline removes uncompleted empty rows and restart ignores old completions", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.stop();
  const old = h.transcription;
  const oldTranslations = h.translations;
  await h.advance(5_000);
  assert.equal(old.connection.close.mock.callCount(), 1);
  assert.equal(h.session.rows.length, 0);
  await h.start();
  await h.speech();
  await act(async () => {
    old.onEvent(complete("old", "Stale text"));
    oldTranslations.forEach((connection) => connection.resolveDrain());
  });
  assert.equal(h.session.rows.length, 1);
  assert.equal(h.session.rows[0].sourceText, "");
  assert.equal(h.transcription.connection.close.mock.callCount(), 0);
  await h.advance(5_000);
  assert.equal(h.session.connectionStatus, "live");
});

test("restart during drain aborts the old receive path without closing the new session", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.stop();
  const old = h.transcription;
  await h.start();
  await h.speech();
  await act(async () => old.onEvent(complete("a", "Old completion")));
  await h.advance(5_000);
  assert.equal(h.session.rows[0].sourceText, "");
  assert.equal(h.session.connectionStatus, "live");
  assert.equal(h.transcription.connection.close.mock.callCount(), 0);
});

test("source delta recovers a VAD-missed row while acoustic silence still decides commit", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.event(delta("quiet", "Quiet speech"));
  assert.equal(h.markSpeechDetected.mock.callCount(), 1);
  await h.advance(1_200);
  assert.equal(h.transcription.connection.commit.mock.callCount(), 0);
  await h.silence();
  await h.advance(450);
  await h.end();
  assert.equal(h.transcription.connection.commit.mock.callCount(), 1);
  assert.equal(h.session.rows[0].status, "draft");
  await h.event(complete("quiet", "Quiet speech."));
  assert.equal(h.session.rows[0].status, "final");
});

test("discarded empty items cannot bind late text to the next utterance", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.event({ type: "input_audio_buffer.committed", item_id: "empty" });
  await h.silence();
  await h.advance(450);
  await h.end();
  await h.event(complete("empty", ""));
  assert.equal(h.session.rows.length, 0);
  await h.speech();
  await h.event(delta("empty", "Late duplicate"));
  assert.equal(h.session.rows.length, 1);
  assert.equal(h.session.rows[0].sourceText, "");
  await h.event(delta("next", "New speech"));
  assert.equal(h.session.rows[0].sourceText, "New speech");
});

test("errors immediately remove pending empty rows and stop resources", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await h.speech();
  await h.event({ type: "error", error: { message: "Connection failed" } });
  assert.equal(h.session.connectionStatus, "error");
  assert.equal(h.session.rows.length, 0);
  assert.equal(h.tracks[0].stop.mock.callCount(), 1);
  assert.equal(h.transcription.connection.close.mock.callCount(), 1);
});

test("stop immediately mutes playback and late source cannot unmute it", async (t) => {
  const h = await mountConversation(t);
  await h.start();
  await act(async () => h.session.setAudioMode("auto"));
  await h.speech();
  await h.event(delta("a", "Hello"));
  const ja = h.translations.find((item) => item.targetLanguage === "ja");
  assert.equal(ja.connection.audio.muted, false);
  await h.stop();
  assert.equal(ja.connection.audio.muted, true);
  await h.event(complete("a", "こんにちは"));
  assert.ok(h.translations.every((item) => item.connection.audio.muted));
});
