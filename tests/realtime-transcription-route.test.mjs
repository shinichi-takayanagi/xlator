import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/realtime/transcription/route.ts";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL;
const originalTranscriptionDelay = process.env.OPENAI_TRANSCRIPTION_DELAY;
const originalTranscriptionPrompt = process.env.OPENAI_TRANSCRIPTION_PROMPT;
const originalTranscriptionKeywords = process.env.OPENAI_TRANSCRIPTION_KEYWORDS;
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  delete process.env.OPENAI_TRANSCRIPTION_PROMPT;
  delete process.env.OPENAI_TRANSCRIPTION_KEYWORDS;
});

test.afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalTranscriptionModel === undefined) delete process.env.OPENAI_TRANSCRIPTION_MODEL;
  else process.env.OPENAI_TRANSCRIPTION_MODEL = originalTranscriptionModel;
  if (originalTranscriptionDelay === undefined) delete process.env.OPENAI_TRANSCRIPTION_DELAY;
  else process.env.OPENAI_TRANSCRIPTION_DELAY = originalTranscriptionDelay;
  if (originalTranscriptionPrompt === undefined) delete process.env.OPENAI_TRANSCRIPTION_PROMPT;
  else process.env.OPENAI_TRANSCRIPTION_PROMPT = originalTranscriptionPrompt;
  if (originalTranscriptionKeywords === undefined) delete process.env.OPENAI_TRANSCRIPTION_KEYWORDS;
  else process.env.OPENAI_TRANSCRIPTION_KEYWORDS = originalTranscriptionKeywords;
  globalThis.fetch = originalFetch;
});

test("rejects transcription secret creation without a server API key", async () => {
  delete process.env.OPENAI_API_KEY;
  const response = await POST();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "missing_api_key");
});

test("creates a low-delay bilingual transcription secret", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  process.env.OPENAI_TRANSCRIPTION_MODEL = "custom-transcriber";
  process.env.OPENAI_TRANSCRIPTION_DELAY = "low";
  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init };
    return Response.json({
      value: "transcription-secret",
      expires_at: 1234,
      session: { type: "transcription" },
    });
  };

  const response = await POST();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    value: "transcription-secret",
    expires_at: 1234,
  });
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(upstreamRequest.init.headers.Authorization, "Bearer server-only-test-key");

  const body = JSON.parse(upstreamRequest.init.body);
  assert.deepEqual(body.expires_after, { anchor: "created_at", seconds: 600 });
  assert.equal(body.session.type, "transcription");
  assert.deepEqual(body.session.audio.input.transcription, {
    model: "custom-transcriber",
    languages: ["en", "ja"],
    delay: "low",
  });
  assert.equal(body.session.audio.input.noise_reduction.type, "far_field");
  assert.equal(body.session.audio.input.turn_detection, null);
});

test("falls back to minimal transcription delay for unsupported values", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  process.env.OPENAI_TRANSCRIPTION_DELAY = "instant";
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return Response.json({ value: "transcription-secret", expires_at: 1234 });
  };

  await POST();
  assert.equal(requestBody.session.audio.input.transcription.delay, "minimal");
});

test("sends optional context and normalized keyword hints without returning upstream session data", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  process.env.OPENAI_TRANSCRIPTION_PROMPT = "  A discussion about xlator and OpenAI.  ";
  process.env.OPENAI_TRANSCRIPTION_KEYWORDS = '[" xlator ","OpenAI","xlator"]';
  let transcription;
  globalThis.fetch = async (_url, init) => {
    transcription = JSON.parse(init.body).session.audio.input.transcription;
    return Response.json({
      value: "transcription-secret",
      expires_at: 1234,
      session: { audio: { input: { transcription } } },
    });
  };

  const response = await POST();
  assert.equal(response.status, 200);
  assert.equal(transcription.prompt, "A discussion about xlator and OpenAI.");
  assert.deepEqual(transcription.keywords, ["xlator", "OpenAI"]);
  assert.deepEqual(await response.json(), { value: "transcription-secret", expires_at: 1234 });
});

test("omits blank optional hints and an empty keyword list", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  process.env.OPENAI_TRANSCRIPTION_PROMPT = "  ";
  process.env.OPENAI_TRANSCRIPTION_KEYWORDS = "[]";
  let transcription;
  globalThis.fetch = async (_url, init) => {
    transcription = JSON.parse(init.body).session.audio.input.transcription;
    return Response.json({ value: "transcription-secret", expires_at: 1234 });
  };

  assert.equal((await POST()).status, 200);
  assert.equal("prompt" in transcription, false);
  assert.equal("keywords" in transcription, false);
});

test("rejects malformed keyword configuration before requesting a secret", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("Unexpected upstream request"); };
  for (const invalid of [
    "not-json", '"xlator"', "null", "{}", "[123]", '[""]', '[" "]',
    '["line\\nbreak"]', '["line\\rbreak"]', '["<term>"]',
  ]) {
    process.env.OPENAI_TRANSCRIPTION_KEYWORDS = invalid;
    const response = await POST();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "invalid_transcription_context");
  }
  assert.equal(requests, 0);
});
